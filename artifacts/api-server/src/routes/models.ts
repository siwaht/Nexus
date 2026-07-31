import { db, modelsTable } from '@workspace/db';
import { and, eq } from 'drizzle-orm';
import { Router, type IRouter } from 'express';

import {
  connectedProviders,
  getUserSettings,
  listCatalogue,
  refreshCatalogue,
  seedEntriesFor,
  updateUserSettings,
  type ModelTask,
} from '../lib/ai';
import { rateLimit } from '../lib/rateLimit';
import { requireAuth } from '../middlewares/requireAuth';
import {
  boolOr,
  handler,
  numberOr,
  optionalStr,
  str,
  userId,
} from './helpers';

/**
 * Model catalogue and per-task defaults.
 *
 * The catalogue is fetched live from each connected provider and cached in the
 * database. Refresh is rate-limited because it can mean a dozen upstream calls.
 */

const router: IRouter = Router();

router.use('/models', requireAuth);
router.use('/settings', requireAuth);

const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 4,
  message: 'Catalogue refresh is limited to a few times a minute.',
});

router.get(
  '/models',
  handler(async (req, res) => {
    const uid = userId(req);
    const task = optionalStr(req.query.task) as ModelTask | null;
    const entries = await listCatalogue(uid, task ?? undefined);

    // A connected provider with no cached rows yet (refresh pending or
    // failed) still shows its seed models, so the picker is never empty
    // for a provider the user just connected.
    const connected = await connectedProviders(uid);
    const cachedProviders = new Set(entries.map((entry) => entry.providerName));
    const missing = connected.filter((provider) => !cachedProviders.has(provider));
    if (missing.length > 0) {
      const seeds = missing.flatMap((provider) => seedEntriesFor(provider));
      entries.push(...(task ? seeds.filter((entry) => entry.task === task) : seeds));
    }

    const overrides = await db
      .select({ modelRef: modelsTable.modelRef, enabled: modelsTable.enabled })
      .from(modelsTable)
      .where(eq(modelsTable.userId, uid));
    const disabled = new Set(
      overrides.filter((row) => !row.enabled).map((row) => row.modelRef),
    );

    res.json({
      models: entries.map((entry) => ({
        ...entry,
        enabled: !disabled.has(entry.modelRef),
      })),
      stale: (await listCatalogue(uid)).length === 0,
    });
  }),
);

router.post(
  '/models/refresh',
  refreshLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const outcome = await refreshCatalogue(uid);
    req.log.info(
      { total: outcome.total, providers: outcome.outcomes.length },
      'Model catalogue refreshed',
    );
    res.json(outcome);
  }),
);

router.patch(
  '/models/enabled',
  handler(async (req, res) => {
    const uid = userId(req);
    const modelRef = str(req.body?.modelRef);
    if (!modelRef) throw new Error('modelRef is required.');
    const enabled = boolOr(req.body?.enabled, true);

    await db
      .insert(modelsTable)
      .values({ userId: uid, modelRef, enabled })
      .onConflictDoUpdate({
        target: [modelsTable.userId, modelsTable.modelRef],
        set: { enabled },
      });
    res.json({ modelRef, enabled });
  }),
);

router.get(
  '/settings',
  handler(async (req, res) => {
    const uid = userId(req);
    const [settings, connected] = await Promise.all([
      getUserSettings(uid),
      connectedProviders(uid),
    ]);
    res.json({ settings, connectedProviders: connected });
  }),
);

router.patch(
  '/settings',
  handler(async (req, res) => {
    const uid = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = await getUserSettings(uid);

    const patch = {
      defaultChatModel: modelField(body.defaultChatModel, current.defaultChatModel),
      defaultVisionModel: modelField(
        body.defaultVisionModel,
        current.defaultVisionModel,
      ),
      defaultTranscriptionModel: modelField(
        body.defaultTranscriptionModel,
        current.defaultTranscriptionModel,
      ),
      defaultEmbeddingModel: modelField(
        body.defaultEmbeddingModel,
        current.defaultEmbeddingModel,
      ),
      defaultRerankModel: modelField(
        body.defaultRerankModel,
        current.defaultRerankModel,
      ),
      defaultImageModel: modelField(
        body.defaultImageModel,
        current.defaultImageModel,
      ),
      defaultTtsModel: modelField(body.defaultTtsModel, current.defaultTtsModel),
      autoMemory: boolOr(body.autoMemory, current.autoMemory),
      semanticRecall: boolOr(body.semanticRecall, current.semanticRecall),
      summarizeThreshold: clamp(
        numberOr(body.summarizeThreshold, current.summarizeThreshold),
        0.2,
        0.95,
      ),
      recallLimit: Math.round(
        clamp(numberOr(body.recallLimit, current.recallLimit), 0, 20),
      ),
      autoRouteModel: boolOr(body.autoRouteModel, current.autoRouteModel),
      theme: str(body.theme, current.theme),
      accentColor: str(body.accentColor, current.accentColor),
      fontSize: str(body.fontSize, current.fontSize),
      density: str(body.density, current.density),
      codeTheme: str(body.codeTheme, current.codeTheme),
      maxParallelAgents: Math.round(
        clamp(numberOr(body.maxParallelAgents, current.maxParallelAgents), 1, 8),
      ),
      maxAgentSteps: Math.round(
        clamp(numberOr(body.maxAgentSteps, current.maxAgentSteps), 4, 200),
      ),
      browserDriver: str(body.browserDriver, current.browserDriver),
    };

    const settings = await updateUserSettings(uid, patch);
    res.json({ settings });
  }),
);

/** `null` clears a default; `undefined` leaves it alone. */
function modelField(value: unknown, current: string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  return current;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export default router;
