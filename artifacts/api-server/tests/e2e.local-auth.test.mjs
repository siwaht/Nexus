import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

/**
 * End-to-end tests for both documented deployment topologies:
 *
 * 1. Same-origin (default): web + API behind one origin, SameSite=Lax
 *    session cookies, no credentialed CORS, foreign-Origin mutations 403.
 * 2. Split-origin (WEB_ORIGIN set): frontend on its own origin, allowlisted
 *    credentialed CORS, SameSite=None; Secure cookies (what browsers require
 *    to attach them cross-site), CSRF origin checks, and auth redirects that
 *    land back on the frontend origin.
 *
 * Requires: `pnpm --filter @workspace/api-server run build` first, and
 * DATABASE_URL + SESSION_SECRET in the environment.
 */

const APP_ORIGIN = 'https://app.example.com';
const TEST_KEY = 'sk-test-abcd1234efgh9999';

async function startServer(port, extraEnv = {}) {
  const child = spawn('node', ['--enable-source-maps', './dist/index.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'development',
      AUTH_MODE: 'local',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/healthz`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGTERM');
      throw new Error(`API server on :${port} did not start`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { base, stop: () => child.kill('SIGTERM') };
}

function sessionCookie(res) {
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find((c) => c.startsWith('sid='));
  assert.ok(sid, 'expected a sid session cookie');
  return sid.split(';')[0];
}

async function register(base, email) {
  return fetch(`${base}/api/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'correct horse battery staple',
      firstName: 'E2E',
    }),
  });
}

describe('same-origin deployment (default)', () => {
  let base;
  let stop;
  let cookie;

  before(async () => {
    ({ base, stop } = await startServer(3999));
  });
  after(() => stop());

  it('auth config reports local mode', async () => {
    const res = await fetch(`${base}/api/auth/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mode: 'local' });
  });

  it('providers are gated when unauthenticated', async () => {
    const res = await fetch(`${base}/api/providers`);
    assert.equal(res.status, 401);
  });

  it('register creates an account with a SameSite=Lax httpOnly cookie', async () => {
    const res = await register(base, `e2e-same-${Date.now()}@example.com`);
    assert.equal(res.status, 200);
    cookie = sessionCookie(res);
    const raw = res.headers.getSetCookie().join('; ');
    assert.match(raw, /samesite=lax/i);
    assert.match(raw, /httponly/i);
    const body = await res.json();
    assert.ok(body.user?.email.endsWith('@example.com'));
    assert.equal(body.user.passwordHash, undefined, 'must not leak the password hash');
  });

  it('session cookie authenticates API calls', async () => {
    const res = await fetch(`${base}/api/auth/user`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).user?.id);
  });

  it('cross-origin browser calls get no CORS headers', async () => {
    const res = await fetch(`${base}/api/auth/config`, {
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('CSRF guard: mutations from a foreign Origin are rejected', async () => {
    const res = await fetch(`${base}/api/providers/openai`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ credentials: { apiKey: TEST_KEY } }),
    });
    assert.equal(res.status, 403);
  });

  it('saving provider credentials returns only a masked preview', async () => {
    const res = await fetch(`${base}/api/providers/openai`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ credentials: { apiKey: TEST_KEY }, isDefault: true }),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes(TEST_KEY), 'plaintext key must never appear in responses');
    const provider = JSON.parse(raw);
    assert.equal(provider.configured, true);
    assert.equal(provider.isDefault, true);
    assert.match(provider.fields.find((f) => f.key === 'apiKey').maskedPreview, /^••••9999$/);
  });

  it('provider list stays masked', async () => {
    const res = await fetch(`${base}/api/providers`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes(TEST_KEY));
    assert.equal(JSON.parse(raw).length >= 10, true);
  });

  it('SSRF guard: custom endpoint must be HTTPS', async () => {
    await fetch(`${base}/api/providers/custom`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        credentials: { baseUrl: 'http://169.254.169.254/latest/meta-data', apiKey: 'x', model: 'm' },
      }),
    });
    const res = await fetch(`${base}/api/providers/custom/test`, {
      method: 'POST',
      headers: { cookie },
    });
    const outcome = await res.json();
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /HTTPS/);
  });

  it('SSRF guard: private addresses are rejected', async () => {
    await fetch(`${base}/api/providers/custom`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        credentials: { baseUrl: 'https://10.0.0.12/internal', apiKey: 'x', model: 'm' },
      }),
    });
    const res = await fetch(`${base}/api/providers/custom/test`, {
      method: 'POST',
      headers: { cookie },
    });
    const outcome = await res.json();
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /public address/);
  });

  it('SSRF guard: IPv6 loopback, ULA, link-local and mapped variants are rejected', async () => {
    const blocked = [
      'https://[::1]/',
      'https://[::]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:7f00:1]/',
      'https://[fd12::8]/',
      'https://[fe80::1]/',
    ];
    for (const baseUrl of blocked) {
      await fetch(`${base}/api/providers/custom`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ credentials: { baseUrl, apiKey: 'x', model: 'm' } }),
      });
      const res = await fetch(`${base}/api/providers/custom/test`, {
        method: 'POST',
        headers: { cookie },
      });
      const outcome = await res.json();
      assert.equal(outcome.ok, false, baseUrl);
      assert.match(outcome.message, /public address/, baseUrl);
    }
  });

  it('logout rejects foreign returnTo URLs', async () => {
    const res = await fetch(`${base}/api/logout?returnTo=${encodeURIComponent('https://evil.example.com')}`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });

  it('removing credentials deconfigures the provider', async () => {
    const res = await fetch(`${base}/api/providers/openai`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const provider = await res.json();
    assert.equal(provider.configured, false);
    assert.equal(provider.fields.find((f) => f.key === 'apiKey').maskedPreview, null);
  });

  it('logout clears the session', async () => {
    await fetch(`${base}/api/logout?returnTo=/`, { headers: { cookie }, redirect: 'manual' });
    const afterLogout = await fetch(`${base}/api/auth/user`, { headers: { cookie } });
    assert.equal((await afterLogout.json()).user, null);
  });
});

describe('split-origin deployment (WEB_ORIGIN set)', () => {
  let base;
  let stop;
  let cookie;

  before(async () => {
    ({ base, stop } = await startServer(3998, { WEB_ORIGIN: APP_ORIGIN }));
  });
  after(() => stop());

  it('register issues a SameSite=None; Secure cookie (cross-site attachable)', async () => {
    const res = await register(base, `e2e-split-${Date.now()}@example.com`);
    assert.equal(res.status, 200);
    cookie = sessionCookie(res);
    const raw = res.headers.getSetCookie().join('; ');
    assert.match(raw, /samesite=none/i);
    assert.match(raw, /secure/i);
  });

  it('credentialed CORS is allowlisted to the frontend origin', async () => {
    const res = await fetch(`${base}/api/auth/config`, {
      headers: { origin: APP_ORIGIN },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), APP_ORIGIN);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  });

  it('other origins receive no CORS headers', async () => {
    const res = await fetch(`${base}/api/auth/config`, {
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('CSRF guard: mutations from a foreign Origin are rejected', async () => {
    const res = await fetch(`${base}/api/providers/openai`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ credentials: { apiKey: TEST_KEY } }),
    });
    assert.equal(res.status, 403);
  });

  it('mutations from the frontend Origin are accepted', async () => {
    const res = await fetch(`${base}/api/providers/openai`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, origin: APP_ORIGIN },
      body: JSON.stringify({ credentials: { apiKey: TEST_KEY } }),
    });
    assert.equal(res.status, 200);
    const provider = await res.json();
    assert.equal(provider.configured, true);
  });

  it('logout returnTo on the frontend origin is honored', async () => {
    const res = await fetch(
      `${base}/api/logout?returnTo=${encodeURIComponent(`${APP_ORIGIN}/signed-out`)}`,
      { redirect: 'manual' },
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${APP_ORIGIN}/signed-out`);
  });

  it('logout returnTo on a foreign origin falls back to the frontend origin', async () => {
    const res = await fetch(
      `${base}/api/logout?returnTo=${encodeURIComponent('https://evil.example.com')}`,
      { redirect: 'manual' },
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${APP_ORIGIN}/`);
  });
});
