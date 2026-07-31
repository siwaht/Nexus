import dns from 'node:dns/promises';
import net from 'node:net';

import type { Provider, ProviderField, ProviderName } from '@workspace/api-zod';

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

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/**
 * User-supplied endpoints (the Custom provider) are fetched server-side, so
 * they must never reach loopback, private, link-local, or cloud-metadata
 * addresses. Every provider adapter that fetches a user-controlled URL must
 * call assertPublicHttpUrl first and fetch with `redirect: "error"` so a
 * redirect can't bounce the request to a blocked address after validation.
 */

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 || // "this" network
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmark
    a >= 224 // multicast / reserved
  );
}

/**
 * Parse an IPv6 address into its 8 hextets. Handles `::` compression and
 * dotted-quad tails (e.g. ::ffff:127.0.0.1). Returns null when invalid.
 */
function parseIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const tail = addr.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const bytes = tail.slice(1).map(Number);
    if (bytes.some((b) => b > 255)) return null;
    const hi = ((bytes[0] << 8) | bytes[1]).toString(16);
    const lo = ((bytes[2] << 8) | bytes[3]).toString(16);
    addr = `${addr.slice(0, tail.index)}${hi}:${lo}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right =
    halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const hextets = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (hextets.length !== 8) return null;
  const nums = hextets.map((h) =>
    /^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN,
  );
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

function isBlockedIPv6(ip: string): boolean {
  const h = parseIPv6(ip);
  if (!h) return true; // unparseable — treat as blocked
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;

  // Any address whose last 32 bits encode an IPv4 address:
  // IPv4-mapped ::ffff:0:0/96, deprecated IPv4-compatible ::/96 (covers ::1
  // and :: too, since 0.0.0.x is blocked), and NAT64 64:ff9b::/96.
  const embedsIpv4 =
    (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0xffff || h5 === 0)) ||
    (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0);
  if (embedsIpv4) {
    const ipv4 = `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
    return isBlockedIPv4(ipv4);
  }

  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // documentation range
  if (h0 === 0x2001 && h1 === 0x0000) return true; // Teredo tunneling
  if (h0 === 0x2002) return true; // 6to4 tunneling
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // unparseable — treat as blocked
}

/**
 * Validate that a user-supplied endpoint is HTTPS and resolves to public
 * addresses only. Throws with a user-readable message otherwise.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('The endpoint URL is not valid.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Custom endpoints must use HTTPS.');
  }
  // URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]") — strip the
  // brackets so address parsing sees the real address.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await dns.lookup(hostname, { all: true }).catch(() => [])).map(
        (a) => a.address,
      );
  if (addresses.length === 0) {
    throw new Error(`Could not resolve host "${hostname}".`);
  }
  if (addresses.some(isBlockedAddress)) {
    throw new Error(
      'Custom endpoints must resolve to a public address — loopback, private-network and metadata addresses are not allowed.',
    );
  }
}

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
    case 'custom': {
      const baseUrl = credentials.baseUrl.replace(/\/+$/, '');
      try {
        await assertPublicHttpUrl(`${baseUrl}/chat/completions`);
      } catch (err) {
        return {
          ok: false,
          message:
            err instanceof Error ? err.message : 'The endpoint URL is not valid.',
          latencyMs: 0,
        };
      }
      return chatCompletionsTest(
        `${baseUrl}/chat/completions`,
        credentials.apiKey ?? '',
        credentials.model || 'default',
      );
    }
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
