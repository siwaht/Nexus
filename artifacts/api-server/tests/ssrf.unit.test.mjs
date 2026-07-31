import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { build } from 'esbuild';

/**
 * Unit tests for the SSRF guard (src/lib/ssrf.ts), including the DNS
 * rebinding regression: the resolver performs exactly ONE lookup and the
 * vetted answers are what the connection uses — a second (rebound) answer
 * can never influence the connection.
 *
 * The TS module is bundled with esbuild so plain node can import it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '.tmp', 'ssrf.mjs');

let ssrf;

before(async () => {
  await build({
    entryPoints: [path.join(here, '..', 'src', 'lib', 'ssrf.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  ssrf = await import(bundlePath);
});

describe('isBlockedAddress', () => {
  it('blocks private, loopback, link-local and reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '192.0.2.1',
      '198.51.100.4',
      '203.0.113.9',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      assert.equal(ssrf.isBlockedAddress(ip), true, ip);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1']) {
      assert.equal(ssrf.isBlockedAddress(ip), false, ip);
    }
  });

  it('blocks IPv6 loopback, unspecified, ULA, link-local and multicast', () => {
    for (const ip of [
      '::1',
      '::',
      'fd12::8',
      'fc00::1',
      'fe80::1',
      'febf::1',
      'ff02::1',
      '2001:db8::1',
      '2001::1',
      '2002::1',
    ]) {
      assert.equal(ssrf.isBlockedAddress(ip), true, ip);
    }
  });

  it('blocks IPv4-mapped/compatible/NAT64 IPv6 in dotted and hex forms', () => {
    for (const ip of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:169.254.169.254',
      '64:ff9b::7f00:1',
      '64:ff9b::a9fe:a9fe',
    ]) {
      assert.equal(ssrf.isBlockedAddress(ip), true, ip);
    }
  });

  it('allows public IPv6 (including mapped public IPv4)', () => {
    for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      assert.equal(ssrf.isBlockedAddress(ip), false, ip);
    }
  });

  it('blocks unparseable input', () => {
    for (const ip of ['', 'not-an-ip', '999.1.2.3']) {
      assert.equal(ssrf.isBlockedAddress(ip), true, JSON.stringify(ip));
    }
  });
});

describe('resolvePublicHttpUrl', () => {
  it('requires HTTPS', async () => {
    await assert.rejects(ssrf.resolvePublicHttpUrl('http://example.com/v1'), /HTTPS/);
  });

  it('rejects invalid URLs', async () => {
    await assert.rejects(ssrf.resolvePublicHttpUrl('not a url'), /not valid/);
  });

  it('blocks bracketed IPv6 literals without any DNS lookup', async () => {
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
      return [{ address: '8.8.8.8' }];
    };
    await assert.rejects(
      ssrf.resolvePublicHttpUrl('https://[::1]/v1', lookup),
      /public address/,
    );
    assert.equal(lookups, 0);
  });

  it('resolves once and returns the vetted addresses', async () => {
    let lookups = 0;
    const lookup = async (hostname) => {
      lookups += 1;
      assert.equal(hostname, 'api.example.com');
      return [{ address: '93.184.216.34' }, { address: '8.8.8.8' }];
    };
    const resolved = await ssrf.resolvePublicHttpUrl(
      'https://api.example.com/v1/chat/completions',
      lookup,
    );
    assert.equal(lookups, 1);
    assert.deepEqual(resolved.addresses, ['93.184.216.34', '8.8.8.8']);
    assert.equal(resolved.url.pathname, '/v1/chat/completions');
  });

  it('rejects mixed answers (public + private) — mixed-answer attack', async () => {
    const lookup = async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }];
    await assert.rejects(
      ssrf.resolvePublicHttpUrl('https://rebind.example.com/v1', lookup),
      /public address/,
    );
  });

  it('DNS rebinding regression: a second, rebound answer never occurs', async () => {
    // Simulates a hostname that answers public IPs for the validation query
    // and the cloud-metadata address for a later query. The design performs
    // exactly one resolution whose vetted result feeds the connection, so
    // the second answer can never be observed by the request path.
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
      return lookups === 1
        ? [{ address: '8.8.8.8' }]
        : [{ address: '169.254.169.254' }];
    };
    const resolved = await ssrf.resolvePublicHttpUrl(
      'https://rebinding.example.com/v1',
      lookup,
    );
    assert.equal(lookups, 1, 'connection-time re-resolution must not exist');
    assert.deepEqual(resolved.addresses, ['8.8.8.8']);
  });

  it('reports unresolvable hosts', async () => {
    const lookup = async () => [];
    await assert.rejects(
      ssrf.resolvePublicHttpUrl('https://gone.example.com/v1', lookup),
      /Could not resolve host/,
    );
  });
});
