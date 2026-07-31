import type { ProviderName } from '@workspace/api-zod';

import type { Credentials } from '../providers';
import { resolvePublicHttpUrl } from '../ssrf';
import { ProviderError } from './types';

/**
 * Where each provider lives and how to authenticate against it.
 *
 * Most providers speak the OpenAI wire format, so they share one adapter and
 * differ only in base URL and auth header. Anthropic and Google get their own
 * families. Cloudflare Workers AI is OpenAI-compatible for chat/embeddings
 * and exposes everything else (Whisper, image, TTS, reranking) through
 * `/ai/run/{model}`.
 */

export type ProviderFamily = 'openai-compat' | 'anthropic' | 'google';

export interface Transport {
  provider: ProviderName;
  family: ProviderFamily;
  /** Base URL with no trailing slash, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  headers: Record<string, string>;
  /** Cloudflare only: `/ai/run/{model}` for non-chat tasks. */
  runUrl?: (model: string) => string;
  /** Provider model-discovery endpoint, when one exists. */
  cataloguePath?: string;
  /** True when the base URL came from user input and needs SSRF checks. */
  userSupplied?: boolean;
}

const CF_API = 'https://api.cloudflare.com/client/v4';

export function cloudflareAccountBase(accountId: string): string {
  return `${CF_API}/accounts/${encodeURIComponent(accountId)}/ai`;
}

export async function resolveTransport(
  provider: ProviderName,
  credentials: Credentials,
): Promise<Transport> {
  switch (provider) {
    case 'cloudflare-workers-ai': {
      const base = cloudflareAccountBase(credentials.accountId);
      return {
        provider,
        family: 'openai-compat',
        baseUrl: `${base}/v1`,
        headers: { Authorization: `Bearer ${credentials.apiToken}` },
        runUrl: (model) => `${base}/run/${model}`,
        cataloguePath: `${base}/models/search`,
      };
    }
    case 'cloudflare-ai-gateway': {
      const gatewayId = credentials.gatewayId || 'default';
      return {
        provider,
        family: 'openai-compat',
        baseUrl: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(credentials.accountId)}/${encodeURIComponent(gatewayId)}/compat`,
        headers: { Authorization: `Bearer ${credentials.apiToken}` },
      };
    }
    case 'openrouter':
      return {
        provider,
        family: 'openai-compat',
        baseUrl: 'https://openrouter.ai/api/v1',
        headers: {
          Authorization: `Bearer ${credentials.apiKey}`,
          'X-Title': 'Nexus',
        },
        cataloguePath: 'https://openrouter.ai/api/v1/models',
      };
    case 'openai':
      return {
        provider,
        family: 'openai-compat',
        baseUrl: 'https://api.openai.com/v1',
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        cataloguePath: 'https://api.openai.com/v1/models',
      };
    case 'anthropic':
      return {
        provider,
        family: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        headers: {
          'x-api-key': credentials.apiKey,
          'anthropic-version': '2023-06-01',
        },
        cataloguePath: 'https://api.anthropic.com/v1/models',
      };
    case 'google-ai-studio':
      return {
        provider,
        family: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        headers: { 'x-goog-api-key': credentials.apiKey },
        cataloguePath:
          'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      };
    case 'groq':
      return {
        provider,
        family: 'openai-compat',
        baseUrl: 'https://api.groq.com/openai/v1',
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        cataloguePath: 'https://api.groq.com/openai/v1/models',
      };
    case 'mistral':
      return {
        provider,
        family: 'openai-compat',
        baseUrl: 'https://api.mistral.ai/v1',
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        cataloguePath: 'https://api.mistral.ai/v1/models',
      };
    case 'deepseek':
      return {
        provider,
        family: 'openai-compat',
        baseUrl: 'https://api.deepseek.com/v1',
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        cataloguePath: 'https://api.deepseek.com/models',
      };
    case 'xai':
      return {
        provider,
        family: 'openai-compat',
        baseUrl: 'https://api.x.ai/v1',
        headers: { Authorization: `Bearer ${credentials.apiKey}` },
        cataloguePath: 'https://api.x.ai/v1/models',
      };
    case 'custom': {
      const baseUrl = (credentials.baseUrl ?? '').replace(/\/+$/, '');
      // User-controlled endpoint — SSRF-check before anything is sent to it.
      // Throws unless the URL is HTTPS and every resolved address is public.
      await resolvePublicHttpUrl(`${baseUrl}/chat/completions`);
      const headers: Record<string, string> = {};
      if (credentials.apiKey) {
        headers.Authorization = `Bearer ${credentials.apiKey}`;
      }
      return {
        provider,
        family: 'openai-compat',
        baseUrl,
        headers,
        cataloguePath: `${baseUrl}/models`,
        userSupplied: true,
      };
    }
    default:
      throw new ProviderError({
        kind: 'unsupported',
        provider,
        message: `No transport is defined for provider "${provider}".`,
      });
  }
}

/**
 * Cloudflare's `/ai/run/{model}` endpoint, required for every non-chat task.
 * Throws a clear error when the selected provider has no equivalent.
 */
export function requireRunUrl(transport: Transport, model: string): string {
  if (!transport.runUrl) {
    throw new ProviderError({
      kind: 'unsupported',
      provider: transport.provider,
      message: `${transport.provider} does not expose a raw model-run endpoint for this task.`,
      hint: 'Pick a Cloudflare Workers AI model for this capability, or choose a provider that supports it directly.',
    });
  }
  return transport.runUrl(model);
}
