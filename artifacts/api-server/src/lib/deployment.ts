import type { Request } from 'express';

/**
 * Deployment topology configuration.
 *
 * Same-origin mode (default): the web app and API share an origin (Replit,
 * or a reverse proxy self-hosted). No CORS is needed and session cookies
 * are SameSite=Lax.
 *
 * Split-origin mode: set WEB_ORIGIN to the web frontend's public origin
 * (e.g. https://nexus.example.com). Only that origin may make credentialed
 * cross-origin requests, session cookies become SameSite=None; Secure, and
 * OIDC login/logout redirects land back on the frontend. Both origins must
 * be served over HTTPS — browsers reject SameSite=None without Secure.
 */
export const WEB_ORIGIN = process.env.WEB_ORIGIN?.replace(/\/+$/, '') || null;

export function isSplitOrigin(): boolean {
  return WEB_ORIGIN !== null;
}

export function requestOrigin(req: Request): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host =
    (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

/** Origins permitted to make credentialed cross-origin (CORS) requests. */
export function allowedOrigins(): string[] {
  return WEB_ORIGIN ? [WEB_ORIGIN] : [];
}

/**
 * CSRF check: is this Origin allowed to drive cookie-authenticated
 * mutations? Either this API's own origin (same-origin topology) or the
 * configured frontend origin (split topology).
 */
export function isAllowedRequestOrigin(origin: string, req: Request): boolean {
  if (origin === requestOrigin(req)) return true;
  if (WEB_ORIGIN && origin === WEB_ORIGIN) return true;
  return false;
}
