import {
  DeleteProviderCredentialsParams,
  SaveProviderCredentialsBody,
  SaveProviderCredentialsParams,
  TestProviderConnectionParams,
  type Provider,
} from '@workspace/api-zod';
import { db, modelCatalogueTable, providersTable } from '@workspace/db';
import { and, eq, ne } from 'drizzle-orm';
import { Router, type IRouter, type Request, type Response } from 'express';

import { invalidateCredentialCache, refreshCatalogue } from '../lib/ai';
import { decrypt, encrypt } from '../lib/crypto';
import {
  getProviderDefinition,
  PROVIDER_DEFINITIONS,
  sanitizeCredentials,
  testConnection,
  toProviderView,
  type Credentials,
} from '../lib/providers';
import { rateLimit } from '../lib/rateLimit';
import { requireAuth } from '../middlewares/requireAuth';

const router: IRouter = Router();

router.use('/providers', requireAuth);

const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many connection tests — wait a moment and try again.',
});

function loadCredentials(encrypted: string): Credentials | null {
  try {
    return sanitizeCredentials(JSON.parse(decrypt(encrypted))) as Credentials;
  } catch {
    return null;
  }
}

/**
 * Repopulate the model catalogue after credentials change, without blocking
 * the response. Model resolution falls back to seed entries while this runs,
 * so chat keeps working even before the refresh lands.
 */
function refreshCatalogueInBackground(
  userId: string,
  reason: string,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
): void {
  void refreshCatalogue(userId).then(
    (outcome) =>
      log.info({ total: outcome.total, reason }, 'Model catalogue auto-refreshed'),
    (err) => log.warn({ err, reason }, 'Model catalogue auto-refresh failed'),
  );
}

async function buildProviderList(userId: string): Promise<Provider[]> {
  const rows = await db
    .select()
    .from(providersTable)
    .where(eq(providersTable.userId, userId));
  const byName = new Map(rows.map((r) => [r.name, r]));
  return PROVIDER_DEFINITIONS.map((definition) => {
    const row = byName.get(definition.name);
    return toProviderView(
      definition,
      row,
      row ? loadCredentials(row.encryptedCredentials) : null,
    );
  });
}

router.get('/providers', async (req: Request, res: Response) => {
  res.json(await buildProviderList(req.user!.id));
});

router.put('/providers/:name', async (req: Request, res: Response) => {
  const params = SaveProviderCredentialsParams.safeParse(req.params);
  const body = SaveProviderCredentialsBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: 'Invalid provider name or credentials payload.' });
    return;
  }
  const { name } = params.data;
  const definition = getProviderDefinition(name);
  if (!definition) {
    res.status(400).json({ error: 'Unknown provider.' });
    return;
  }

  const userId = req.user!.id;
  const incoming = body.data.credentials;
  const knownKeys = new Set(definition.fields.map((f) => f.key));
  const cleaned: Credentials = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (knownKeys.has(key) && typeof value === 'string' && value.trim().length > 0) {
      // Trim pasted whitespace — a stray newline in an API key breaks auth.
      cleaned[key] = value.trim();
    }
  }

  const [existing] = await db
    .select()
    .from(providersTable)
    .where(and(eq(providersTable.userId, userId), eq(providersTable.name, name)));

  // Merge with stored credentials so masked (unchanged) fields keep working.
  const merged: Credentials = {
    ...(existing ? loadCredentials(existing.encryptedCredentials) : {}),
    ...cleaned,
  };

  const missing = definition.fields
    .filter((f) => f.required && !merged[f.key])
    .map((f) => f.label);
  if (missing.length > 0) {
    res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}.` });
    return;
  }

  if (body.data.isDefault) {
    await db
      .update(providersTable)
      .set({ isDefault: false })
      .where(and(eq(providersTable.userId, userId), ne(providersTable.name, name)));
  }

  const values = {
    userId,
    name,
    encryptedCredentials: encrypt(JSON.stringify(merged)),
    isDefault: body.data.isDefault ?? existing?.isDefault ?? false,
    // Credentials changed — the previous test result no longer applies.
    status: 'untested',
    statusMessage: null,
    lastTestedAt: null,
  };

  if (existing) {
    await db
      .update(providersTable)
      .set(values)
      .where(eq(providersTable.id, existing.id));
  } else {
    await db.insert(providersTable).values(values);
  }

  const [row] = await db
    .select()
    .from(providersTable)
    .where(and(eq(providersTable.userId, userId), eq(providersTable.name, name)));
  // Model calls cache decrypted credentials briefly — drop that immediately.
  invalidateCredentialCache(userId);
  refreshCatalogueInBackground(userId, 'credentials-saved', req.log);
  res.json(toProviderView(definition, row, merged));
});

router.delete('/providers/:name', async (req: Request, res: Response) => {
  const params = DeleteProviderCredentialsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: 'Invalid provider name.' });
    return;
  }
  const { name } = params.data;
  const definition = getProviderDefinition(name);
  if (!definition) {
    res.status(400).json({ error: 'Unknown provider.' });
    return;
  }
  await db
    .delete(providersTable)
    .where(and(eq(providersTable.userId, req.user!.id), eq(providersTable.name, name)));
  // Drop the cached catalogue rows too, so disconnected providers never
  // surface in the model picker or in automatic model resolution.
  await db
    .delete(modelCatalogueTable)
    .where(
      and(
        eq(modelCatalogueTable.userId, req.user!.id),
        eq(modelCatalogueTable.providerName, name),
      ),
    );
  invalidateCredentialCache(req.user!.id);
  res.json(toProviderView(definition, undefined, null));
});

router.post(
  '/providers/:name/test',
  testLimiter,
  async (req: Request, res: Response) => {
    const params = TestProviderConnectionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: 'Invalid provider name.' });
      return;
    }
    const { name } = params.data;
    const definition = getProviderDefinition(name);
    if (!definition) {
      res.status(400).json({ error: 'Unknown provider.' });
      return;
    }

    const [row] = await db
      .select()
      .from(providersTable)
      .where(
        and(eq(providersTable.userId, req.user!.id), eq(providersTable.name, name)),
      );
    const credentials = row ? loadCredentials(row.encryptedCredentials) : null;
    if (!row || !credentials) {
      res.status(400).json({
        error: 'Save credentials for this provider before testing the connection.',
      });
      return;
    }

    const outcome = await testConnection(name, credentials);
    await db
      .update(providersTable)
      .set({
        status: outcome.ok ? 'ok' : 'error',
        statusMessage: outcome.message,
        lastTestedAt: new Date(),
      })
      .where(eq(providersTable.id, row.id));

    req.log.info(
      { provider: name, ok: outcome.ok, latencyMs: outcome.latencyMs },
      'Provider connection test',
    );
    if (outcome.ok) {
      refreshCatalogueInBackground(req.user!.id, 'connection-tested', req.log);
    }
    res.json(outcome);
  },
);

export default router;
