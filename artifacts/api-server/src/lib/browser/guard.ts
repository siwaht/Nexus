import dns from 'node:dns/promises';
import net from 'node:net';

import { isBlockedAddress } from '../providers';

/**
 * SSRF guard for the web tools.
 *
 * Same address blocklist the provider layer uses, but http:// is permitted
 * here because plenty of the public web still isn't HTTPS and these URLs are
 * fetched for their content, not trusted with credentials. Private, loopback,
 * link-local and cloud-metadata addresses stay blocked, and callers must fetch
 * with `redirect: 'manual'` so a redirect can't slip past validation.
 */

export interface GuardedUrl {
  url: URL;
  /** Resolved addresses, useful for logging a blocked attempt. */
  addresses: string[];
}

export async function assertPublicWebUrl(rawUrl: string): Promise<GuardedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`"${rawUrl}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http:// and https:// URLs can be fetched.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await dns.lookup(hostname, { all: true }).catch(() => [])).map(
        (a) => a.address,
      );

  if (addresses.length === 0) {
    throw new Error(`Could not resolve "${hostname}".`);
  }
  if (addresses.some(isBlockedAddress)) {
    throw new Error(
      `"${hostname}" resolves to a private or reserved address, so it can't be fetched.`,
    );
  }
  return { url, addresses };
}

const MAX_REDIRECTS = 5;

/**
 * Fetch a URL, re-validating the target at every redirect hop. Returns the
 * final response plus the URL it actually landed on.
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<{ response: Response; finalUrl: string }> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const { url } = await assertPublicWebUrl(current);
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Identify honestly; many sites reject blank user agents outright.
        'User-Agent':
          'Mozilla/5.0 (compatible; NexusBot/1.0; +https://github.com/nexus-workspace)',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(init.headers ?? {}),
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: url.toString() };
      current = new URL(location, url).toString();
      continue;
    }
    return { response, finalUrl: url.toString() };
  }
  throw new Error('Too many redirects.');
}
