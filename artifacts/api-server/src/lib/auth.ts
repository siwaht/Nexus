import crypto from 'crypto';
import type { AuthUser } from '@workspace/api-zod';
import { db, sessionsTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { type CookieOptions, type Request, type Response } from 'express';
import * as client from 'openid-client';

import { isSplitOrigin } from './deployment';

export const ISSUER_URL = process.env.ISSUER_URL ?? 'https://replit.com/oidc';
export const SESSION_COOKIE = 'sid';
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

/**
 * Session cookie attributes for the active deployment topology.
 * Split-origin deployments require SameSite=None + Secure so the browser
 * attaches the cookie on cross-site credentialed fetches; same-origin
 * deployments stay SameSite=Lax and only mark Secure over HTTPS (so local
 * http development still works).
 */
export function sessionCookieOptions(req: Request): CookieOptions {
  if (isSplitOrigin()) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: SESSION_TTL,
    };
  }
  return {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  };
}

export function setSessionCookie(req: Request, res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, sessionCookieOptions(req));
}

export interface SessionData {
  user: AuthUser;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

let oidcConfig: client.Configuration | null = null;

export async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcConfig) {
    oidcConfig = await client.discovery(
      new URL(ISSUER_URL),
      process.env.REPL_ID!,
    );
  }
  return oidcConfig;
}

export async function createSession(data: SessionData): Promise<string> {
  const sid = crypto.randomBytes(32).toString('hex');
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL),
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));

  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }

  return row.sess as unknown as SessionData;
}

export async function updateSession(
  sid: string,
  data: SessionData,
): Promise<void> {
  await db
    .update(sessionsTable)
    .set({
      sess: data as unknown as Record<string, unknown>,
      expire: new Date(Date.now() + SESSION_TTL),
    })
    .where(eq(sessionsTable.sid, sid));
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(res: Response, sid?: string): Promise<void> {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.cookies?.[SESSION_COOKIE];
}
