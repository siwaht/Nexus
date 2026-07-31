import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

/**
 * SSRF protection for user-controlled endpoints (the Custom provider, and
 * any future adapter that fetches a user-supplied URL).
 *
 * Rebinding-safe by construction: resolvePublicHttpUrl performs ONE DNS
 * resolution, validates EVERY returned address, and the caller connects to
 * those exact vetted addresses via pinnedRequest — no second resolution
 * happens at connection time, so DNS rebinding or mixed-answer attacks
 * cannot smuggle an internal address past the check. HTTPS is required and
 * redirects are never followed.
 */

export const SSRF_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 || // "this" network
    a === 10 || // RFC1918 private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918 private
    (a === 192 && b === 168) || // RFC1918 private
    (a === 192 && b === 0) || // IETF protocol assignments (incl. 192.0.2 doc)
    (a === 198 && (b === 18 || b === 19)) || // benchmark
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast / reserved
  );
}

/**
 * Parse an IPv6 address into its 8 hextets. Handles `::` compression and
 * dotted-quad tails (e.g. ::ffff:127.0.0.1). Returns null when invalid.
 */
function parseIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const tail = addr.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const bytes = tail.slice(1).map(Number);
    if (bytes.some((b) => b > 255)) return null;
    const hi = ((bytes[0] << 8) | bytes[1]).toString(16);
    const lo = ((bytes[2] << 8) | bytes[3]).toString(16);
    addr = `${addr.slice(0, tail.index)}${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right =
    halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const hextets = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (hextets.length !== 8) return null;
  const nums = hextets.map((h) =>
    /^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN,
  );
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

function isBlockedIPv6(ip: string): boolean {
  const h = parseIPv6(ip);
  if (!h) return true; // unparseable — treat as blocked
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;

  // Any address whose last 32 bits encode an IPv4 address:
  // IPv4-mapped ::ffff:0:0/96, deprecated IPv4-compatible ::/96 (covers ::1
  // and :: too, since 0.0.0.x is blocked), and NAT64 64:ff9b::/96.
  const embedsIpv4 =
    (h0 === 0 &&
      h1 === 0 &&
      h2 === 0 &&
      h3 === 0 &&
      h4 === 0 &&
      (h5 === 0xffff || h5 === 0)) ||
    (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0);
  if (embedsIpv4) {
    const ipv4 = `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
    return isBlockedIPv4(ipv4);
  }

  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // documentation range
  if (h0 === 0x2001 && h1 === 0x0000) return true; // Teredo tunneling
  if (h0 === 0x2002) return true; // 6to4 tunneling
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // unparseable — treat as blocked
}

/** Returns an error message when any resolved address is blocked, else null. */
export function validateResolvedAddresses(addresses: string[]): string | null {
  if (addresses.some(isBlockedAddress)) {
    return 'Custom endpoints must resolve to a public address — loopback, private-network and metadata addresses are not allowed.';
  }
  return null;
}

export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

export interface ResolvedPublicUrl {
  url: URL;
  addresses: string[];
}

/**
 * Resolve and vet a user-supplied endpoint: HTTPS-only, exactly ONE DNS
 * resolution (injectable for tests), every returned address validated. The
 * returned addresses are the only ones a connection may use — pair with
 * pinnedRequest so connection time performs no new resolution.
 */
export async function resolvePublicHttpUrl(
  rawUrl: string,
  lookupFn?: LookupFn,
): Promise<ResolvedPublicUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('The endpoint URL is not valid.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Custom endpoints must use HTTPS.');
  }
  // URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]") — strip the
  // brackets so address parsing sees the real address.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    const lookup = lookupFn ?? ((h: string) => dns.lookup(h, { all: true }));
    const resolved = await lookup(hostname).catch(
      () => [] as Array<{ address: string }>,
    );
    addresses = resolved.map((a) => a.address);
  }
  if (addresses.length === 0) {
    throw new Error(`Could not resolve host "${hostname}".`);
  }
  const error = validateResolvedAddresses(addresses);
  if (error) throw new Error(error);
  return { url, addresses };
}

export interface PinnedRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface PinnedResponse {
  status: number;
  body: string;
}

/**
 * HTTPS request pinned to a pre-vetted IP address: the TCP connection goes
 * to `address` while SNI, certificate validation and the Host header use
 * the original hostname. Redirects are never followed — a 3xx status is
 * returned for the caller to treat as an error.
 */
export function pinnedRequest(
  url: URL,
  address: string,
  init: PinnedRequestInit,
  timeoutMs = SSRF_TIMEOUT_MS,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: address,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: init.method,
        servername: url.hostname.replace(/^\[|\]$/g, ''),
        headers: { host: url.host, ...init.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('Provider response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
