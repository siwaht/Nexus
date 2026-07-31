import type { NextFunction, Request, Response } from 'express';

/** Gate a router behind authentication — 401 for anything unsigned. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
