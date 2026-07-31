import type { NextFunction, Request, Response } from 'express';

import { isAllowedRequestOrigin } from '../lib/deployment';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie-authenticated mutations.
 *
 * Browsers always attach an Origin header to cross-site POST/PUT/DELETE
 * requests, so any mutation whose Origin is neither this API's own origin
 * nor the configured frontend origin (WEB_ORIGIN) is rejected. Requests
 * without an Origin header (curl, server-to-server) cannot be CSRF attacks
 * by construction, and bearer-token clients (mobile) are not
 * cookie-authenticated — both are exempt.
 */
export function csrfOriginGuard(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.headers.authorization) {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }
  if (!isAllowedRequestOrigin(origin, req)) {
    res.status(403).json({ error: 'Forbidden: unexpected request origin.' });
    return;
  }
  next();
}
