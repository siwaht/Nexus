import type { ProviderName } from '@workspace/api-zod';
import { db, modelCatalogueTable } from '@workspace/db';
import { and, eq } from 'drizzle-orm';

import { getProviderDefinition } from '../providers';
import { connectedProviders, loadCredentials } from './credentials';
import { resolveTransport, type Transport } from './endpoints';
import { providerFetchJson } from './http';
import { ProviderError, type ModelTask } from './types';

/**
 * Live model catalogue.
 *
 * Nothing here is hardcoded as truth: each provider's own discovery endpoint
 * is fetched and cached in `model_catalogue`. SEED_MODELS exists only so the
 * picker isn't empty on a cold start, and every seed is dropped if the live
 * catalogue doesn't confirm it.
 */

export interface CatalogueEntry {
  providerName: ProviderName;
  modelRef: string;
  modelId: string;
  displayName: string;
  task: ModelTask;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  modalities: string[];
  capabilities: string[];
  pricing: Record<string, unknown> | null;
  experimental: boolean;
}

/**
 * Cold-start fallbacks, verified against the live catalogue on first refresh.
 * These are Cloudflare refs because Workers AI is the primary model source.
 */
export const SEED_MODELS: Record<string, { model: string; task: ModelTask }[]> = {
  'cloudflare-workers-ai': [
    { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', task: 'Text Generation' },
    { model: '@cf/openai/gpt-oss-120b', task: 'Text Generation' },
    { model: '@cf/meta/llama-3.1-8b-instruct-fp8', task: 'Text Generation' },
    { model: '@cf/meta/llama-4-scout-17b-16e-instruct', task: 'Image-to-Text' },
    {
      model: '@cf/mistralai/mistral-small-3.1-24b-instruct',
      task: 'Image-to-Text',
    },
    {
      model: '@cf/openai/whisper-large-v3-turbo',
      task: 'Automatic Speech Recognition',
    },
    { model: '@cf/baai/bge-m3', task: 'Text Embeddings' },
    { model: '@cf/baai/bge-reranker-base', task: 'Reranking' },
    { model: '@cf/black-forest-labs/flux-1-schnell', task: 'Text-to-Image' },
    { model: '@cf/deepgram/aura-1', task: 'Text-to-Speech' },
  ],
};

/** Map a provider's own task label onto our normalized set. */
function normalizeTask(raw: string | undefined, modelId: string): ModelTask {
  const label = (raw ?? '').toLowerCase();
  const id = modelId.toLowerCase();

  if (label.includes('speech recognition') || label.includes('transcri')) {
    return 'Automatic Speech Recognition';
  }
  if (label.includes('text-to-speech') || label.includes('text to speech')) {
    return 'Text-to-Speech';
  }
  if (label.includes('text-to-image') || label.includes('image generation')) {
    return 'Text-to-Image';
  }
  if (label.includes('image-to-text') || label.includes('vision')) {
    return 'Image-to-Text';
  }
  if (label.includes('embedding')) return 'Text Embeddings';
  if (label.includes('rerank')) return 'Reranking';
  if (label.includes('translation')) return 'Translation';
  if (label.includes('text generation') || label.includes('chat')) {
    return 'Text Generation';
  }

  // No usable label — infer from the model id.
  if (/whisper|transcrib/.test(id)) return 'Automatic Speech Recognition';
  if (/\btts\b|aura|speech|melotts/.test(id)) return 'Text-to-Speech';
  if (/embed|bge-(?!reranker)|text-embedding/.test(id)) return 'Text Embeddings';
  if (/rerank/.test(id)) return 'Reranking';
  if (/flux|stable-diffusion|dall-e|gpt-image|imagen/.test(id)) {
    return 'Text-to-Image';
  }
  if (/m2m100|translat|opus-mt/.test(id)) return 'Translation';
  if (/moderation|guard/.test(id)) return 'Other';
  return 'Text Generation';
}

function inferModalities(modelId: string, task: ModelTask): string[] {
  const id = modelId.toLowerCase();
  const modalities = new Set<string>(['text']);
  if (task === 'Image-to-Text') modalities.add('image');
  if (task === 'Text-to-Image') modalities.add('image-out');
  if (task === 'Automatic Speech Recognition') modalities.add('audio');
  if (task === 'Text-to-Speech') modalities.add('audio-out');
  if (/vision|scout|maverick|gpt-4o|gpt-5|claude|gemini|pixtral|llava/.test(id)) {
    modalities.add('image');
  }
  return [...modalities];
}

// ---------------------------------------------------------------------------
// Per-provider discovery
// ---------------------------------------------------------------------------

interface CloudflareModel {
  name?: string;
  description?: string;
  task?: { name?: string };
  properties?: Array<{ property_id?: string; value?: unknown }>;
  tags?: string[];
}

async function fetchCloudflare(
  transport: Transport,
): Promise<CatalogueEntry[]> {
  const entries: CatalogueEntry[] = [];
  const perPage = 100;

  for (let page = 1; page <= 10; page += 1) {
    const url = `${transport.cataloguePath}?per_page=${perPage}&page=${page}&hide_experimental=false`;
    const json = await providerFetchJson<{ result?: CloudflareModel[] }>(
      transport,
      url,
    );
    const batch = json.result ?? [];
    for (const model of batch) {
      if (!model.name) continue;
      const task = normalizeTask(model.task?.name, model.name);
      const props = new Map(
        (model.properties ?? []).map((p) => [p.property_id, p.value]),
      );
      const contextWindow = Number(
        props.get('context_window') ?? props.get('max_input_tokens') ?? 0,
      );
      const maxOutput = Number(props.get('max_output_tokens') ?? 0);
      entries.push({
        providerName: 'cloudflare-workers-ai',
        modelRef: `cloudflare-workers-ai:${model.name}`,
        modelId: model.name,
        displayName: model.name.split('/').pop() ?? model.name,
        task,
        description: model.description ?? null,
        contextWindow: contextWindow > 0 ? contextWindow : null,
        maxOutputTokens: maxOutput > 0 ? maxOutput : null,
        modalities: inferModalities(model.name, task),
        capabilities: model.tags ?? [],
        pricing: null,
        experimental: (model.tags ?? []).includes('experimental'),
      });
    }
    if (batch.length < perPage) break;
  }
  return entries;
}

interface OpenRouterModel {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  top_provider?: { max_completion_tokens?: number };
  pricing?: Record<string, string>;
}

async function fetchOpenRouter(
  transport: Transport,
): Promise<CatalogueEntry[]> {
  const json = await providerFetchJson<{ data?: OpenRouterModel[] }>(
    transport,
    transport.cataloguePath!,
  );
  return (json.data ?? [])
    .filter((m): m is OpenRouterModel & { id: string } => Boolean(m.id))
    .map((model) => {
      const inputs = model.architecture?.input_modalities ?? ['text'];
      const task: ModelTask = inputs.includes('image')
        ? 'Image-to-Text'
        : 'Text Generation';
      return {
        providerName: 'openrouter' as ProviderName,
        modelRef: `openrouter:${model.id}`,
        modelId: model.id,
        displayName: model.name ?? model.id,
        task,
        description: model.description?.slice(0, 500) ?? null,
        contextWindow: model.context_length ?? null,
        maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
        modalities: [
          ...new Set([...inputs, ...(model.architecture?.output_modalities ?? [])]),
        ],
        capabilities: [],
        pricing: model.pricing ?? null,
        experimental: false,
      };
    });
}

interface GoogleModel {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

async function fetchGoogle(transport: Transport): Promise<CatalogueEntry[]> {
  const json = await providerFetchJson<{ models?: GoogleModel[] }>(
    transport,
    transport.cataloguePath!,
  );
  return (json.models ?? [])
    .filter((m): m is GoogleModel & { name: string } => Boolean(m.name))
    .map((model) => {
      const id = model.name.replace(/^models\//, '');
      const methods = model.supportedGenerationMethods ?? [];
      const task: ModelTask = methods.some((m) => m.includes('embedContent'))
        ? 'Text Embeddings'
        : /imagen/.test(id)
          ? 'Text-to-Image'
          : 'Text Generation';
      return {
        providerName: 'google-ai-studio' as ProviderName,
        modelRef: `google-ai-studio:${id}`,
        modelId: id,
        displayName: model.displayName ?? id,
        task,
        description: model.description?.slice(0, 500) ?? null,
        contextWindow: model.inputTokenLimit ?? null,
        maxOutputTokens: model.outputTokenLimit ?? null,
        modalities: inferModalities(id, task),
        capabilities: methods,
        pricing: null,
        experimental: /exp|preview/.test(id),
      };
    });
}

interface OpenAiStyleModel {
  id?: string;
  display_name?: string;
  name?: string;
  description?: string;
  max_context_length?: number;
  context_length?: number;
  capabilities?: Record<string, boolean> | string[];
}

/** Handles OpenAI, Anthropic, Groq, Mistral, DeepSeek, xAI and custom. */
async function fetchOpenAiStyle(
  transport: Transport,
  provider: ProviderName,
): Promise<CatalogueEntry[]> {
  const json = await providerFetchJson<{
    data?: OpenAiStyleModel[];
    models?: OpenAiStyleModel[];
  }>(transport, transport.cataloguePath!);
  const list = json.data ?? json.models ?? [];
  return list
    .filter((m): m is OpenAiStyleModel & { id: string } => Boolean(m.id))
    .map((model) => {
      const task = normalizeTask(undefined, model.id);
      const capabilities = Array.isArray(model.capabilities)
        ? model.capabilities
        : Object.entries(model.capabilities ?? {})
            .filter(([, on]) => on)
            .map(([name]) => name);
      return {
        providerName: provider,
        modelRef: `${provider}:${model.id}`,
        modelId: model.id,
        displayName: model.display_name ?? model.name ?? model.id,
        task,
        description: model.description?.slice(0, 500) ?? null,
        contextWindow: model.max_context_length ?? model.context_length ?? null,
        maxOutputTokens: null,
        modalities: inferModalities(model.id, task),
        capabilities,
        pricing: null,
        experimental: /preview|alpha|beta|exp/.test(model.id),
      };
    });
}

async function fetchProviderCatalogue(
  userId: string,
  provider: ProviderName,
): Promise<CatalogueEntry[]> {
  const credentials = await loadCredentials(userId, provider);
  const transport = await resolveTransport(provider, credentials);
  if (!transport.cataloguePath) return [];

  switch (provider) {
    case 'cloudflare-workers-ai':
      return fetchCloudflare(transport);
    case 'openrouter':
      return fetchOpenRouter(transport);
    case 'google-ai-studio':
      return fetchGoogle(transport);
    default:
      return fetchOpenAiStyle(transport, provider);
  }
}

/**
 * The AI Gateway has no discovery endpoint of its own — it proxies other
 * providers using `{provider}/{model}` refs. Mirror whatever the user's other
 * connected providers expose so Gateway routing is selectable in the picker.
 */
function deriveGatewayEntries(entries: CatalogueEntry[]): CatalogueEntry[] {
  const gatewayPrefix: Partial<Record<ProviderName, string>> = {
    openai: 'openai',
    anthropic: 'anthropic',
    'google-ai-studio': 'google-ai-studio',
    groq: 'groq',
    mistral: 'mistral',
    deepseek: 'deepseek',
    'cloudflare-workers-ai': 'workers-ai',
  };
  const derived: CatalogueEntry[] = [];
  for (const entry of entries) {
    const prefix = gatewayPrefix[entry.providerName];
    if (!prefix) continue;
    if (entry.task !== 'Text Generation' && entry.task !== 'Image-to-Text') {
      continue;
    }
    const id = `${prefix}/${entry.modelId}`;
    derived.push({
      ...entry,
      providerName: 'cloudflare-ai-gateway',
      modelRef: `cloudflare-ai-gateway:${id}`,
      modelId: id,
      displayName: `${entry.displayName} (via Gateway)`,
    });
  }
  return derived;
}

export interface RefreshOutcome {
  provider: ProviderName;
  ok: boolean;
  count: number;
  message: string;
}

/**
 * Refresh the catalogue for every connected provider. Providers are fetched
 * independently so one bad key doesn't blank the whole picker — each returns
 * its own outcome for the UI to display.
 */
export async function refreshCatalogue(
  userId: string,
  only?: ProviderName[],
): Promise<{ outcomes: RefreshOutcome[]; total: number }> {
  const connected = await connectedProviders(userId);
  const targets = only
    ? connected.filter((p) => only.includes(p))
    : connected.filter((p) => p !== 'cloudflare-ai-gateway');

  const outcomes: RefreshOutcome[] = [];
  const collected: CatalogueEntry[] = [];

  const results = await Promise.allSettled(
    targets.map(async (provider) => ({
      provider,
      entries: await fetchProviderCatalogue(userId, provider),
    })),
  );

  for (let i = 0; i < results.length; i += 1) {
    const provider = targets[i];
    const result = results[i];
    const displayName = getProviderDefinition(provider)?.displayName ?? provider;
    if (result.status === 'fulfilled') {
      collected.push(...result.value.entries);
      outcomes.push({
        provider,
        ok: true,
        count: result.value.entries.length,
        message: `${result.value.entries.length} models from ${displayName}`,
      });
    } else {
      const reason = result.reason;
      outcomes.push({
        provider,
        ok: false,
        count: 0,
        message:
          reason instanceof ProviderError
            ? reason.message
            : `Could not load models from ${displayName}.`,
      });
    }
  }

  if (connected.includes('cloudflare-ai-gateway')) {
    const derived = deriveGatewayEntries(collected);
    collected.push(...derived);
    outcomes.push({
      provider: 'cloudflare-ai-gateway',
      ok: true,
      count: derived.length,
      message: `${derived.length} models routable through the Gateway`,
    });
  }

  if (collected.length > 0) {
    const refreshedProviders = new Set(collected.map((e) => e.providerName));
    for (const provider of refreshedProviders) {
      await db
        .delete(modelCatalogueTable)
        .where(
          and(
            eq(modelCatalogueTable.userId, userId),
            eq(modelCatalogueTable.providerName, provider),
          ),
        );
    }
    // Batch inserts — some providers return well over a thousand models.
    const rows = collected.map((entry) => ({
      userId,
      providerName: entry.providerName,
      modelRef: entry.modelRef,
      displayName: entry.displayName,
      task: entry.task,
      description: entry.description,
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
      modalities: entry.modalities,
      capabilities: entry.capabilities,
      pricing: entry.pricing,
      experimental: entry.experimental,
      fetchedAt: new Date(),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insert(modelCatalogueTable)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing();
    }
  }

  return { outcomes, total: collected.length };
}

/** Read the cached catalogue, optionally filtered by task. */
export async function listCatalogue(
  userId: string,
  task?: ModelTask,
): Promise<CatalogueEntry[]> {
  const rows = await db
    .select()
    .from(modelCatalogueTable)
    .where(
      task
        ? and(
            eq(modelCatalogueTable.userId, userId),
            eq(modelCatalogueTable.task, task),
          )
        : eq(modelCatalogueTable.userId, userId),
    );

  return rows.map((row) => ({
    providerName: row.providerName as ProviderName,
    modelRef: row.modelRef,
    modelId: row.modelRef.slice(row.modelRef.indexOf(':') + 1),
    displayName: row.displayName ?? row.modelRef,
    task: row.task as ModelTask,
    description: row.description,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    modalities: (row.modalities as string[] | null) ?? [],
    capabilities: (row.capabilities as string[] | null) ?? [],
    pricing: (row.pricing as Record<string, unknown> | null) ?? null,
    experimental: row.experimental,
  }));
}

/** Seed refs for a provider, used before the first live refresh lands. */
export function seedEntriesFor(provider: ProviderName): CatalogueEntry[] {
  return (SEED_MODELS[provider] ?? []).map(({ model, task }) => ({
    providerName: provider,
    modelRef: `${provider}:${model}`,
    modelId: model,
    displayName: model.split('/').pop() ?? model,
    task,
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    modalities: inferModalities(model, task),
    capabilities: [],
    pricing: null,
    experimental: false,
  }));
}
