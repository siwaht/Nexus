import {
  GetCurrentAuthUserResponse,
  LoginLocalUserBody,
  RegisterLocalUserBody,
} from '@workspace/api-zod';
import { db, usersTable } from '@workspace/db';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { Router, type IRouter, type Request, type Response } from 'express';

import { createSession, setSessionCookie } from '../lib/auth';
import { rateLimit } from '../lib/rateLimit';

/**
 * Portable auth: AUTH_MODE=replit uses Replit OIDC (see auth.ts);
 * AUTH_MODE=local uses email+password with bcrypt and httpOnly session
 * cookies so the app runs identically on any host. Defaults to replit when
 * running on Replit, local everywhere else.
 */

export const AUTH_MODE: 'replit' | 'local' =
  (process.env.AUTH_MODE ?? (process.env.REPL_ID ? 'replit' : 'local')) ===
  'local'
    ? 'local'
    : 'replit';

const router: IRouter = Router();

const localAuthLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: 'Too many sign-in attempts — try again in a few minutes.',
});

router.get('/auth/config', (_req: Request, res: Response) => {
  res.json({ mode: AUTH_MODE });
});

router.post(
  '/auth/local/register',
  localAuthLimiter,
  async (req: Request, res: Response) => {
    if (AUTH_MODE !== 'local') {
      res.status(404).json({ error: 'Local auth is not enabled.' });
      return;
    }
    const parsed = RegisterLocalUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A valid email and a password of at least 8 characters are required.' });
      return;
    }
    const { email, password, firstName, lastName } = parsed.data;
    const normalizedEmail = email.toLowerCase();

    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, normalizedEmail));
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [user] = await db
      .insert(usersTable)
      .values({
        email: normalizedEmail,
        firstName: firstName || null,
        lastName: lastName || null,
        passwordHash,
      })
      .returning();

    const sid = await createSession({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileImageUrl: user.profileImageUrl,
      },
      access_token: '',
    });
    setSessionCookie(req, res, sid);
    res.json(
      GetCurrentAuthUserResponse.parse({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          profileImageUrl: user.profileImageUrl,
        },
      }),
    );
  },
);

router.post(
  '/auth/local/login',
  localAuthLimiter,
  async (req: Request, res: Response) => {
    if (AUTH_MODE !== 'local') {
      res.status(404).json({ error: 'Local auth is not enabled.' });
      return;
    }
    const parsed = LoginLocalUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    const { email, password } = parsed.data;

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase()));
    if (!user?.passwordHash) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const sid = await createSession({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileImageUrl: user.profileImageUrl,
      },
      access_token: '',
    });
    setSessionCookie(req, res, sid);
    res.json(
      GetCurrentAuthUserResponse.parse({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          profileImageUrl: user.profileImageUrl,
        },
      }),
    );
  },
);

export default router;
