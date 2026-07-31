import {
  db,
  modelCatalogueTable,
  userSettingsTable,
  type UserSettingsRow,
} from '@workspace/db';
import { and, asc, eq } from 'drizzle-orm';

import { connectedProviders } from './credentials';
import { seedEntriesFor } from './catalogue';
import { ProviderError, type ModelTask } from './types';

/**
 * Per-user settings and the "which model runs this task" decision.
 *
 * Resolution order for any task: the user's explicit default → the best
 * cached catalogue entry → a seed ref for a connected provider. If none of
 * those produce a model, callers get a ProviderError with a pointer to the
 * exact setting to fix, never a silent no-op.
 */

export type TaskSlot =
  | 'chat'
  | 'vision'
  | 'transcription'
  | 'embedding'
  | 'rerank'
  | 'image'
  | 'tts';

const SLOT_TO_COLUMN = {
  chat: 'defaultChatModel',
  vision: 'defaultVisionModel',
  transcription: 'defaultTranscriptionModel',
  embedding: 'defaultEmbeddingModel',
  rerank: 'defaultRerankModel',
  image: 'defaultImageModel',
  tts: 'defaultTtsModel',
} as const satisfies Record<TaskSlot, keyof UserSettingsRow>;

const SLOT_TO_TASK: Record<TaskSlot, ModelTask> = {
  chat: 'Text Generation',
  vision: 'Image-to-Text',
  transcription: 'Automatic Speech Recognition',
  embedding: 'Text Embeddings',
  rerank: 'Reranking',
  image: 'Text-to-Image',
  tts: 'Text-to-Speech',
};

const SLOT_LABEL: Record<TaskSlot, string> = {
  chat: 'chat',
  vision: 'vision',
  transcription: 'transcription',
  embedding: 'embedding',
  rerank: 'reranking',
  image: 'image generation',
  tts: 'text-to-speech',
};

/** Preference order when picking a default automatically. */
const PROVIDER_PRIORITY = [
  'cloudflare-workers-ai',
  'cloudflare-ai-gateway',
  'openai',
  'anthropic',
  'google-ai-studio',
  'openrouter',
  'groq',
  'mistral',
  'deepseek',
  'xai',
  'custom',
];

export async function getUserSettings(userId: string): Promise<UserSettingsRow> {
  const [existing] = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId));
  if (existing) return existing;

  const [created] = await db
    .insert(userSettingsTable)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [row] = await db
    .select()
    .from(userSettingsTable)
    .where(eq(userSettingsTable.userId, userId));
  return row;
}

export async function updateUserSettings(
  userId: string,
  patch: Partial<Omit<UserSettingsRow, 'userId' | 'updatedAt'>>,
): Promise<UserSettingsRow> {
  await getUserSettings(userId);
  const [row] = await db
    .update(userSettingsTable)
    .set(patch)
    .where(eq(userSettingsTable.userId, userId))
    .returning();
  return row;
}

/** Pick the best cached catalogue entry for a task. */
async function bestCatalogueRef(
  userId: string,
  task: ModelTask,
): Promise<string | null> {
  const rows = await db
    .select({
      modelRef: modelCatalogueTable.modelRef,
      providerName: modelCatalogueTable.providerName,
      contextWindow: modelCatalogueTable.contextWindow,
      experimental: modelCatalogueTable.experimental,
    })
    .from(modelCatalogueTable)
    .where(
      and(
        eq(modelCatalogueTable.userId, userId),
        eq(modelCatalogueTable.task, task),
      ),
    )
    .orderBy(asc(modelCatalogueTable.modelRef));

  if (rows.length === 0) return null;
  const scored = rows
    .map((row) => {
      const priority = PROVIDER_PRIORITY.indexOf(row.providerName);
      return {
        modelRef: row.modelRef,
        // Prefer non-experimental, then provider priority, then a larger window.
        score:
          (row.experimental ? 1000 : 0) +
          (priority === -1 ? 500 : priority * 10) -
          Math.min((row.contextWindow ?? 0) / 100_000, 5),
      };
    })
    .sort((a, b) => a.score - b.score);
  return scored[0].modelRef;
}

/**
 * Resolve the model reference to use for a task slot.
 * `override` short-circuits everything — that's the user's explicit pick.
 */
export async function resolveModelForTask(
  userId: string,
  slot: TaskSlot,
  override?: string | null,
): Promise<string> {
  if (override) return override;

  const settings = await getUserSettings(userId);
  const configured = settings[SLOT_TO_COLUMN[slot]];
  if (typeof configured === 'string' && configured) return configured;

  const task = SLOT_TO_TASK[slot];
  const fromCatalogue = await bestCatalogueRef(userId, task);
  if (fromCatalogue) return fromCatalogue;

  // Nothing cached yet — fall back to a seed ref for a connected provider.
  const connected = await connectedProviders(userId);
  for (const provider of PROVIDER_PRIORITY) {
    if (!connected.includes(provider as never)) continue;
    const seed = seedEntriesFor(provider as never).find((e) => e.task === task);
    if (seed) return seed.modelRef;
  }

  // Vision and chat are interchangeable on most modern models — retry chat.
  if (slot === 'vision') return resolveModelForTask(userId, 'chat');

  throw new ProviderError({
    kind: 'unsupported',
    message:
      connected.length === 0
        ? `No provider is connected, so there's no ${SLOT_LABEL[slot]} model available.`
        : `No ${SLOT_LABEL[slot]} model is available from your connected providers.`,
    hint:
      connected.length === 0
        ? 'Connect a provider in Settings → Providers.'
        : 'Refresh the catalogue and set a default in Settings → Models.',
  });
}

/** Context window for a model ref, falling back to a conservative default. */
export async function contextWindowFor(
  userId: string,
  modelRef: string,
): Promise<number> {
  const [row] = await db
    .select({ contextWindow: modelCatalogueTable.contextWindow })
    .from(modelCatalogueTable)
    .where(
      and(
        eq(modelCatalogueTable.userId, userId),
        eq(modelCatalogueTable.modelRef, modelRef),
      ),
    );
  return row?.contextWindow && row.contextWindow > 0 ? row.contextWindow : 8192;
}

/** Whether a model ref can accept images on a chat turn. */
export async function supportsVision(
  userId: string,
  modelRef: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      modalities: modelCatalogueTable.modalities,
      task: modelCatalogueTable.task,
    })
    .from(modelCatalogueTable)
    .where(
      and(
        eq(modelCatalogueTable.userId, userId),
        eq(modelCatalogueTable.modelRef, modelRef),
      ),
    );
  if (!row) return false;
  const modalities = (row.modalities as string[] | null) ?? [];
  return row.task === 'Image-to-Text' || modalities.includes('image');
}
