import type { Provider, ProviderField, ProviderName } from '@workspace/api-zod';

import { pinnedRequest, resolvePublicHttpUrl } from './ssrf';

/**
 * Provider abstraction layer.
 *
 * Every supported provider is described declaratively here (fields, docs,
 * how to run a cheap connection test). Adding a provider later means adding
 * one entry to PROVIDER_DEFINITIONS plus one adapter file — nothing else.
 * Cloudflare is one provider among many, not a special case.
 */

export interface ProviderDefinition {
  name: ProviderName;
  displayName: string;
  description: string;
  docsUrl: string | null;
  fields: Array<Omit<ProviderField, 'maskedPreview'>>;
}

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    name: 'cloudflare-workers-ai',
    displayName: 'Cloudflare Workers AI',
    description: 'Run open models on Cloudflare GPUs — chat, embeddings, Whisper, image generation and TTS from one token.',
    docsUrl: 'https://developers.cloudflare.com/workers-ai/get-started/rest-api/',
    fields: [
      { key: 'accountId', label: 'Account ID', secret: false, required: true, placeholder: 'From the Cloudflare dashboard sidebar' },
      { key: 'apiToken', label: 'API Token', secret: true, required: true, placeholder: 'Needs the Workers AI permission' },
    ],
  },
  {
    name: 'cloudflare-ai-gateway',
    displayName: 'Cloudflare AI Gateway',
    description: 'Route OpenAI, Anthropic, Gemini and more through one URL with caching, rate limiting and unified analytics.',
    docsUrl: 'https://developers.cloudflare.com/ai-gateway/',
    fields: [
      { key: 'accountId', label: 'Account ID', secret: false, required: true, placeholder: 'From the Cloudflare dashboard sidebar' },
      { key: 'gatewayId', label: 'Gateway ID', secret: false, required: false, placeholder: 'default' },
      { key: 'apiToken', label: 'Cloudflare API Token', secret: true, required: true, placeholder: 'Needs the AI Gateway permission' },
    ],
  },
  {
    name: 'openrouter',
    displayName: 'OpenRouter',
    description: 'One API key that unlocks hundreds of models across every major lab.',
    docsUrl: 'https://openrouter.ai/keys',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-or-…' },
    ],
  },
  {
    name: 'openai',
    displayName: 'OpenAI',
    description: 'GPT models, Whisper, embeddings and image generation direct from OpenAI.',
    docsUrl: 'https://platform.openai.com/api-keys',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-…' },
    ],
  },
  {
    name: 'anthropic',
    displayName: 'Anthropic',
    description: 'Claude models direct from Anthropic.',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-ant-…' },
    ],
  },
  {
    name: 'google-ai-studio',
    displayName: 'Google AI Studio',
    description: 'Gemini models with a free-tier-friendly API key from AI Studio.',
    docsUrl: 'https://aistudio.google.com/apikey',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'AIza…' },
    ],
  },
  {
    name: 'groq',
    displayName: 'Groq',
    description: 'Ultra-low-latency inference for open models on Groq hardware.',
    docsUrl: 'https://console.groq.com/keys',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'gsk_…' },
    ],
  },
  {
    name: 'mistral',
    displayName: 'Mistral',
    description: 'Mistral and Mixtral models direct from La Plateforme.',
    docsUrl: 'https://console.mistral.ai/api-keys',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'API key' },
    ],
  },
  {
    name: 'deepseek',
    displayName: 'DeepSeek',
    description: 'DeepSeek chat and reasoner models via an OpenAI-compatible API.',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'sk-…' },
    ],
  },
  {
    name: 'xai',
    displayName: 'xAI',
    description: 'Grok models direct from xAI.',
    docsUrl: 'https://console.x.ai/',
    fields: [
      { key: 'apiKey', label: 'API Key', secret: true, required: true, placeholder: 'xai-…' },
    ],
  },
  {
    name: 'custom',
    displayName: 'Custom Endpoint',
    description: 'Any OpenAI-compatible API — point Nexus at a base URL, key and model of your choice.',
    docsUrl: null,
    fields: [
      { key: 'baseUrl', label: 'Base URL', secret: false, required: true, placeholder: 'https://your-host.example/v1' },
      { key: 'apiKey', label: 'API Key', secret: true, required: false, placeholder: 'Optional' },
      { key: 'model', label: 'Model', secret: false, required: false, placeholder: 'Used for the connection test' },
    ],
  },
];

export function getProviderDefinition(
  name: string,
): ProviderDefinition | undefined {
  return PROVIDER_DEFINITIONS.find((d) => d.name === name);
}

export type Credentials = Record<string, string>;

export interface TestConnectionOutcome {
  ok: boolean;
  message: string;
  latencyMs: number;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Normalize any provider error into a single human-readable shape. */
export function normalizeProviderError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = parsed.error as Record<string, unknown> | string | undefined;
    if (typeof err === 'string') return err;
    if (err && typeof err.message === 'string') return err.message;
    const errors = parsed.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = errors[0] as Record<string, unknown>;
      if (typeof first?.message === 'string') return first.message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // body was not JSON — fall through
  }
  if (status === 401 || status === 403) {
    return 'Authentication failed — check the key or token and its permissions.';
  }
  if (status === 429) return 'Rate limited by the provider — try again shortly.';
  return `Provider returned HTTP ${status}.`;
}

async function probe(
  url: string,
  init: RequestInit,
  okMessage: string,
): Promise<TestConnectionOutcome> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      // Never follow redirects — a validated URL could otherwise bounce the
      // request to an internal address.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    const body = await res.text();
    if (res.ok) {
      return { ok: true, message: okMessage, latencyMs };
    }
    return {
      ok: false,
      message: normalizeProviderError(res.status, body),
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const message =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'Connection timed out — check the account ID, base URL and network.'
        : 'Could not reach the provider — check the account ID, base URL and network.';
    return { ok: false, message, latencyMs };
  }
}

function chatCompletionsTest(
  url: string,
  token: string,
  model: string,
  extraHeaders: Record<string, string> = {},
): Promise<TestConnectionOutcome> {
  return probe(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    },
    `OK — model "${model}" responded`,
  );
}

function modelsListTest(
  url: string,
  headers: Record<string, string>,
): Promise<TestConnectionOutcome> {
  return probe(
    url,
    { method: 'GET', headers },
    'OK — credentials accepted, model list reachable',
  );
}

/**
 * Connection test for the user-controlled Custom provider. DNS is resolved
 * and vetted exactly once and the request is pinned to those addresses, so
 * rebinding between validation and connection is impossible (lib/ssrf.ts).
 */
async function customChatCompletionsTest(
  baseUrl: string,
  token: string,
  model: string,
): Promise<TestConnectionOutcome> {
  const started = Date.now();
  let resolved;
  try {
    resolved = await resolvePublicHttpUrl(
      `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    );
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error ? err.message : 'The endpoint URL is not valid.',
      latencyMs: Date.now() - started,
    };
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });
  let lastError: unknown;
  // Every candidate address passed validation — try each until one connects.
  for (const address of resolved.addresses) {
    try {
      const res = await pinnedRequest(
        resolved.url,
        address,
        { method: 'POST', headers, body },
        REQUEST_TIMEOUT_MS,
      );
      const latencyMs = Date.now() - started;
      if (res.status >= 300 && res.status < 400) {
        return {
          ok: false,
          message:
            'The endpoint answered with a redirect — redirects are never followed for security.',
          latencyMs,
        };
      }
      if (res.status >= 200 && res.status < 300) {
        return {
          ok: true,
          message: `OK — model "${model}" responded`,
          latencyMs,
        };
      }
      return {
        ok: false,
        message: normalizeProviderError(res.status, res.body),
        latencyMs,
      };
    } catch (err) {
      lastError = err;
    }
  }
  const timedOut =
    lastError instanceof Error && /timed out/i.test(lastError.message);
  return {
    ok: false,
    message: timedOut
      ? 'Connection timed out — check the base URL and network.'
      : 'Could not reach the provider — check the base URL and network.',
    latencyMs: Date.now() - started,
  };
}

/**
 * Make one real cheap call against the provider to verify credentials.
 * Each provider gets exactly one adapter here; live model calls in later
 * milestones go through the same per-provider adapter pattern.
 */
export async function testConnection(
  name: ProviderName,
  credentials: Credentials,
): Promise<TestConnectionOutcome> {
  switch (name) {
    case 'cloudflare-workers-ai':
      return chatCompletionsTest(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/v1/chat/completions`,
        credentials.apiToken,
        '@cf/meta/llama-3.1-8b-instruct',
      );
    case 'cloudflare-ai-gateway':
      return chatCompletionsTest(
        `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(credentials.accountId)}/${encodeURIComponent(credentials.gatewayId || 'default')}/compat/chat/completions`,
        credentials.apiToken,
        'workers-ai/@cf/meta/llama-3.1-8b-instruct',
      );
    case 'openrouter':
      return modelsListTest('https://openrouter.ai/api/v1/auth/key', {
        Authorization: `Bearer ${credentials.apiKey}`,
      });
    case 'openai':
      return modelsListTest('https://api.openai.com/v1/models', {
        Authorization: `Bearer ${credentials.apiKey}`,
      });
    case 'anthropic':
      return modelsListTest('https://api.anthropic.com/v1/models', {
        'x-api-key': credentials.apiKey,
        'anthropic-version': '2023-06-01',
      });
    case 'google-ai-studio':
      return modelsListTest(
        'https://generativelanguage.googleapis.com/v1beta/models',
        { 'x-goog-api-key': credentials.apiKey },
      );
    case 'groq':
      return modelsListTest('https://api.groq.com/openai/v1/models', {
        Authorization: `Bearer ${credentials.apiKey}`,
      });
    case 'mistral':
      return modelsListTest('https://api.mistral.ai/v1/models', {
        Authorization: `Bearer ${credentials.apiKey}`,
      });
    case 'deepseek':
      return modelsListTest('https://api.deepseek.com/models', {
        Authorization: `Bearer ${credentials.apiKey}`,
      });
    case 'xai':
      return modelsListTest('https://api.x.ai/v1/models', {
        Authorization: `Bearer ${credentials.apiKey}`,
      });
    case 'custom':
      // User-controlled URL: resolve once, vet every address, connect to the
      // vetted IPs only (HTTPS-only, redirects refused) — see lib/ssrf.ts.
      return customChatCompletionsTest(
        credentials.baseUrl,
        credentials.apiKey ?? '',
        credentials.model || 'default',
      );
  }
}

/** Build the API-facing Provider view for a definition + optional DB row. */
export function toProviderView(
  definition: ProviderDefinition,
  row:
    | {
        isDefault: boolean;
        status: string;
        statusMessage: string | null;
        lastTestedAt: Date | null;
      }
    | undefined,
  credentials: Credentials | null,
): Provider {
  const configured = definition.fields
    .filter((f) => f.required)
    .every((f) => Boolean(credentials?.[f.key]));
  return {
    name: definition.name,
    displayName: definition.displayName,
    description: definition.description,
    docsUrl: definition.docsUrl,
    fields: definition.fields.map((f) => ({
      ...f,
      maskedPreview: credentials?.[f.key]
        ? f.secret
          ? `••••${credentials[f.key].slice(-4)}`
          : credentials[f.key]
        : null,
    })),
    configured: Boolean(row) && configured,
    isDefault: row?.isDefault ?? false,
    status: (row?.status as Provider['status']) ?? 'untested',
    statusMessage: row?.statusMessage ?? null,
    lastTestedAt: row?.lastTestedAt ?? null,
  };
}
