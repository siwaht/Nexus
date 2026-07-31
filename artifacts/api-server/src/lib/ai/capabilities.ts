import { loadCredentials, parseModelRef } from './credentials';
import { requireRunUrl, resolveTransport, type Transport } from './endpoints';
import { providerFetch, providerFetchJson } from './http';
import {
  ProviderError,
  type EmbedRequest,
  type EmbedResult,
  type ImageRequest,
  type ImageResult,
  type RerankRequest,
  type RerankResult,
  type SpeakRequest,
  type SpeakResult,
  type TranscribeRequest,
  type TranscribeResult,
  type TranscriptSegment,
} from './types';

/**
 * The non-chat half of the provider interface: embed, transcribe,
 * generateImage, speak and rerank.
 *
 * Embeddings are OpenAI-compatible almost everywhere. The rest are only
 * offered by some providers, so each function routes to the family that
 * supports it and raises a clear `unsupported` error otherwise — never a
 * silent fallback that would quietly produce wrong results.
 */

async function transportFor(
  userId: string,
  modelRef: string,
): Promise<{ transport: Transport; model: string }> {
  const { provider, model } = parseModelRef(modelRef);
  const credentials = await loadCredentials(userId, provider);
  return { transport: await resolveTransport(provider, credentials), model };
}

function unsupported(
  transport: Transport,
  modelRef: string,
  capability: string,
): ProviderError {
  return new ProviderError({
    kind: 'unsupported',
    provider: transport.provider,
    modelRef,
    message: `${transport.provider} does not support ${capability}.`,
    hint: 'Connect Cloudflare Workers AI or OpenAI and pick a model for this task in Settings → Models.',
  });
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

interface OpenAiEmbedResponse {
  data?: Array<{ embedding: number[]; index: number }>;
  model?: string;
  usage?: { prompt_tokens?: number };
}

interface GoogleEmbedResponse {
  embeddings?: Array<{ values: number[] }>;
}

export async function embed(
  userId: string,
  request: EmbedRequest,
): Promise<EmbedResult> {
  const inputs = request.input.filter((t) => t.trim().length > 0);
  if (inputs.length === 0) {
    return { embeddings: [], model: request.modelRef, tokensIn: 0 };
  }
  const { transport, model } = await transportFor(userId, request.modelRef);

  if (transport.family === 'google') {
    const body = {
      requests: inputs.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      })),
    };
    const json = await providerFetchJson<GoogleEmbedResponse>(
      transport,
      `${transport.baseUrl}/models/${encodeURIComponent(model)}:batchEmbedContents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
        modelRef: request.modelRef,
      },
    );
    return {
      embeddings: (json.embeddings ?? []).map((e) => e.values),
      model,
      tokensIn: null,
    };
  }

  if (transport.family === 'anthropic') {
    throw unsupported(transport, request.modelRef, 'embeddings');
  }

  const json = await providerFetchJson<OpenAiEmbedResponse>(
    transport,
    `${transport.baseUrl}/embeddings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: inputs }),
      signal: request.signal,
      modelRef: request.modelRef,
    },
  );
  const ordered = (json.data ?? [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return {
    embeddings: ordered.map((d) => d.embedding),
    model: json.model ?? model,
    tokensIn: json.usage?.prompt_tokens ?? null,
  };
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

interface CloudflareWhisperResponse {
  result?: {
    text?: string;
    transcription_info?: { duration?: number };
    segments?: Array<{ start?: number; end?: number; text?: string }>;
    words?: Array<{ start?: number; end?: number; word?: string }>;
  };
}

interface OpenAiTranscriptionResponse {
  text?: string;
  duration?: number;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
}

export async function transcribe(
  userId: string,
  request: TranscribeRequest,
): Promise<TranscribeResult> {
  const { transport, model } = await transportFor(userId, request.modelRef);

  // Cloudflare: /ai/run/{model}. The v3-turbo Whisper build takes base64
  // JSON; the original build takes the raw bytes as the body.
  if (transport.runUrl) {
    const url = requireRunUrl(transport, model);
    const usesBase64 = /whisper-large-v3/.test(model);
    const init = usesBase64
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audio: request.audio.toString('base64'),
            ...(request.language ? { language: request.language } : {}),
          }),
        }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(request.audio),
        };

    const json = await providerFetchJson<CloudflareWhisperResponse>(
      transport,
      url,
      { ...init, signal: request.signal, modelRef: request.modelRef },
    );
    const result = json.result ?? {};
    const segments: TranscriptSegment[] = (result.segments ?? [])
      .filter((s) => typeof s.text === 'string')
      .map((s) => ({
        start: s.start ?? 0,
        end: s.end ?? s.start ?? 0,
        text: (s.text ?? '').trim(),
      }));
    return {
      text: (result.text ?? '').trim(),
      segments,
      durationS: result.transcription_info?.duration ?? null,
    };
  }

  if (transport.family !== 'openai-compat') {
    throw unsupported(transport, request.modelRef, 'audio transcription');
  }

  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  if (request.language) form.append('language', request.language);
  form.append(
    'file',
    new Blob([new Uint8Array(request.audio)], { type: request.mime }),
    request.filename,
  );

  const json = await providerFetchJson<OpenAiTranscriptionResponse>(
    transport,
    `${transport.baseUrl}/audio/transcriptions`,
    {
      method: 'POST',
      body: form,
      signal: request.signal,
      modelRef: request.modelRef,
    },
  );
  return {
    text: (json.text ?? '').trim(),
    segments: (json.segments ?? []).map((s) => ({
      start: s.start ?? 0,
      end: s.end ?? s.start ?? 0,
      text: (s.text ?? '').trim(),
    })),
    durationS: json.duration ?? null,
  };
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

interface CloudflareImageResponse {
  result?: { image?: string };
}

interface OpenAiImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

export async function generateImage(
  userId: string,
  request: ImageRequest,
): Promise<ImageResult> {
  const { transport, model } = await transportFor(userId, request.modelRef);

  if (transport.runUrl) {
    const url = requireRunUrl(transport, model);
    const body: Record<string, unknown> = { prompt: request.prompt };
    if (request.negativePrompt) body.negative_prompt = request.negativePrompt;
    if (request.width) body.width = request.width;
    if (request.height) body.height = request.height;
    if (request.steps) body.steps = request.steps;

    const res = await providerFetch(transport, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal,
      modelRef: request.modelRef,
    });

    const contentType = res.headers.get('content-type') ?? '';
    // Flux returns base64 JSON; the Stable Diffusion models stream raw PNG.
    if (contentType.includes('application/json')) {
      const json = JSON.parse(await res.text()) as CloudflareImageResponse;
      const base64 = json.result?.image;
      if (!base64) {
        throw new ProviderError({
          kind: 'server',
          provider: transport.provider,
          modelRef: request.modelRef,
          message: 'The image model returned no image data.',
        });
      }
      return { data: Buffer.from(base64, 'base64'), mime: 'image/png' };
    }
    return {
      data: Buffer.from(await res.arrayBuffer()),
      mime: contentType || 'image/png',
    };
  }

  if (transport.family !== 'openai-compat') {
    throw unsupported(transport, request.modelRef, 'image generation');
  }

  const size =
    request.width && request.height
      ? `${request.width}x${request.height}`
      : '1024x1024';
  const json = await providerFetchJson<OpenAiImageResponse>(
    transport,
    `${transport.baseUrl}/images/generations`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: request.prompt, size, n: 1 }),
      signal: request.signal,
      modelRef: request.modelRef,
    },
  );
  const first = json.data?.[0];
  if (first?.b64_json) {
    return { data: Buffer.from(first.b64_json, 'base64'), mime: 'image/png' };
  }
  if (first?.url) {
    const res = await providerFetch(transport, first.url, {
      modelRef: request.modelRef,
    });
    return {
      data: Buffer.from(await res.arrayBuffer()),
      mime: res.headers.get('content-type') ?? 'image/png',
    };
  }
  throw new ProviderError({
    kind: 'server',
    provider: transport.provider,
    modelRef: request.modelRef,
    message: 'The image model returned no image data.',
  });
}

// ---------------------------------------------------------------------------
// Text to speech
// ---------------------------------------------------------------------------

export async function speak(
  userId: string,
  request: SpeakRequest,
): Promise<SpeakResult> {
  const { transport, model } = await transportFor(userId, request.modelRef);

  if (transport.runUrl) {
    const url = requireRunUrl(transport, model);
    const body: Record<string, unknown> = { text: request.text };
    if (request.voice) body.speaker = request.voice;
    const res = await providerFetch(transport, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal,
      modelRef: request.modelRef,
    });
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = JSON.parse(await res.text()) as {
        result?: { audio?: string };
      };
      const base64 = json.result?.audio;
      if (!base64) {
        throw new ProviderError({
          kind: 'server',
          provider: transport.provider,
          modelRef: request.modelRef,
          message: 'The speech model returned no audio.',
        });
      }
      return { data: Buffer.from(base64, 'base64'), mime: 'audio/mpeg' };
    }
    return {
      data: Buffer.from(await res.arrayBuffer()),
      mime: contentType || 'audio/mpeg',
    };
  }

  if (transport.family !== 'openai-compat') {
    throw unsupported(transport, request.modelRef, 'text to speech');
  }

  const res = await providerFetch(transport, `${transport.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: request.text,
      voice: request.voice ?? 'alloy',
    }),
    signal: request.signal,
    modelRef: request.modelRef,
  });
  return {
    data: Buffer.from(await res.arrayBuffer()),
    mime: res.headers.get('content-type') ?? 'audio/mpeg',
  };
}

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

interface CloudflareRerankResponse {
  result?: { response?: Array<{ id?: number; score?: number }> };
}

/**
 * Rerank retrieved chunks against the query. Cloudflare exposes BGE
 * rerankers via /ai/run; other providers generally don't, so callers should
 * treat a thrown `unsupported` as "keep the vector order".
 */
export async function rerank(
  userId: string,
  request: RerankRequest,
): Promise<RerankResult> {
  if (request.documents.length === 0) return { ranking: [] };
  const { transport, model } = await transportFor(userId, request.modelRef);

  if (!transport.runUrl) {
    throw unsupported(transport, request.modelRef, 'reranking');
  }

  const json = await providerFetchJson<CloudflareRerankResponse>(
    transport,
    requireRunUrl(transport, model),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: request.query,
        contexts: request.documents.map((text) => ({ text })),
        top_k: request.topK ?? request.documents.length,
      }),
      signal: request.signal,
      modelRef: request.modelRef,
    },
  );

  const ranking = (json.result?.response ?? [])
    .filter((r) => typeof r.id === 'number')
    .map((r) => ({ index: r.id as number, score: r.score ?? 0 }))
    .sort((a, b) => b.score - a.score);
  return { ranking };
}
