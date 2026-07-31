import type { ProviderName } from '@workspace/api-zod';

/**
 * The one internal interface every model call goes through.
 *
 * Six capabilities — chat, embed, transcribe, generateImage, speak, rerank —
 * each with a single normalized request/response shape. Providers differ only
 * inside `endpoints.ts` (where the call goes) and the per-family adapters in
 * `chat.ts` (how the wire format is translated). Adding a provider means
 * adding one endpoint entry plus, at most, one adapter branch.
 */

/** A model reference is always `<providerName>:<modelId>`. */
export type ModelRef = string;

export interface ParsedModelRef {
  provider: ProviderName;
  model: string;
}

export type ModelTask =
  | 'Text Generation'
  | 'Text Embeddings'
  | 'Automatic Speech Recognition'
  | 'Text-to-Image'
  | 'Image-to-Text'
  | 'Text-to-Speech'
  | 'Translation'
  | 'Reranking'
  | 'Other';

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model. */
  arguments: string;
}

export interface ChatAttachment {
  /** `data:` URL or https URL of an image for vision-capable turns. */
  imageUrl?: string;
  /** Plain-text attachment inlined into the turn. */
  text?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on `role: 'tool'` turns — which call this result answers. */
  toolCallId?: string;
  name?: string;
  attachments?: ChatAttachment[];
}

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object describing the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  modelRef: ModelRef;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  tools?: ToolSchema[];
  /** `auto` lets the model decide; `none` forbids tool use this turn. */
  toolChoice?: 'auto' | 'none';
  responseFormat?: 'text' | 'json';
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; tokensIn: number | null; tokensOut: number | null }
  | { type: 'done'; finishReason: string };

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  tokensIn: number | null;
  tokensOut: number | null;
  finishReason: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Embeddings, transcription, images, speech, reranking
// ---------------------------------------------------------------------------

export interface EmbedRequest {
  modelRef: ModelRef;
  input: string[];
  signal?: AbortSignal;
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
  tokensIn: number | null;
}

export interface TranscribeRequest {
  modelRef: ModelRef;
  audio: Buffer;
  mime: string;
  filename: string;
  language?: string;
  signal?: AbortSignal;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeResult {
  text: string;
  segments: TranscriptSegment[];
  durationS: number | null;
}

export interface ImageRequest {
  modelRef: ModelRef;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  signal?: AbortSignal;
}

export interface ImageResult {
  /** Raw image bytes. */
  data: Buffer;
  mime: string;
}

export interface SpeakRequest {
  modelRef: ModelRef;
  text: string;
  voice?: string;
  signal?: AbortSignal;
}

export interface SpeakResult {
  data: Buffer;
  mime: string;
}

export interface RerankRequest {
  modelRef: ModelRef;
  query: string;
  documents: string[];
  topK?: number;
  signal?: AbortSignal;
}

export interface RerankResult {
  /** Indices into `documents`, best first, with scores. */
  ranking: Array<{ index: number; score: number }>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProviderErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'quota'
  | 'invalid_request'
  | 'unsupported'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown';

/**
 * Every provider failure surfaces as this one shape so the UI can show the
 * real cause and an actionable fix instead of "something went wrong".
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  readonly provider: string | null;
  readonly modelRef: string | null;
  /** Short user-facing next step, e.g. "Fix in Settings → Providers". */
  readonly hint: string | null;

  constructor(opts: {
    kind: ProviderErrorKind;
    message: string;
    status?: number | null;
    provider?: string | null;
    modelRef?: string | null;
    hint?: string | null;
  }) {
    super(opts.message);
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.status = opts.status ?? null;
    this.provider = opts.provider ?? null;
    this.modelRef = opts.modelRef ?? null;
    this.hint = opts.hint ?? null;
  }

  toJSON() {
    return {
      error: this.message,
      kind: this.kind,
      status: this.status,
      provider: this.provider,
      modelRef: this.modelRef,
      hint: this.hint,
    };
  }
}
