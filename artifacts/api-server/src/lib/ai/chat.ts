import { loadCredentials, parseModelRef } from './credentials';
import { resolveTransport, type Transport } from './endpoints';
import { providerFetch, sseChunks } from './http';
import {
  ProviderError,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ToolCall,
  type ToolSchema,
} from './types';

/**
 * Streaming chat across three provider families.
 *
 * `streamChat` is the only entry point callers use. It resolves the model
 * reference to a transport, translates the normalized `ChatMessage[]` into
 * that family's wire format, and translates the response stream back into
 * `ChatEvent`s. Tool calls, reasoning traces and usage counts are normalized
 * the same way for every provider.
 */

interface DataUrlParts {
  mime: string;
  base64: string;
}

function parseDataUrl(url: string): DataUrlParts | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible family
// ---------------------------------------------------------------------------

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAiMessage {
  role: string;
  content: string | OpenAiContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

function toOpenAiMessages(messages: ChatMessage[]): OpenAiMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    const images = (message.attachments ?? []).filter((a) => a.imageUrl);
    if (images.length > 0) {
      const parts: OpenAiContentPart[] = [];
      if (message.content) parts.push({ type: 'text', text: message.content });
      for (const attachment of images) {
        parts.push({
          type: 'image_url',
          image_url: { url: attachment.imageUrl! },
        });
      }
      return { role: message.role, content: parts };
    }
    return { role: message.role, content: message.content };
  });
}

function toOpenAiTools(tools: ToolSchema[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

interface OpenAiStreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: OpenAiStreamDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
  error?: { message?: string } | string;
}

async function* streamOpenAiCompat(
  transport: Transport,
  model: string,
  request: ChatRequest,
): AsyncGenerator<ChatEvent> {
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.tools?.length) {
    body.tools = toOpenAiTools(request.tools);
    body.tool_choice = request.toolChoice ?? 'auto';
  }
  if (request.responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }

  const res = await providerFetch(transport, `${transport.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: request.signal,
    modelRef: request.modelRef,
  });

  // Tool call fragments arrive spread across chunks, keyed by index.
  const pending = new Map<number, { id: string; name: string; args: string }>();
  let finishReason = 'stop';
  let sawUsage = false;

  for await (const payload of sseChunks(res)) {
    let chunk: OpenAiStreamChunk;
    try {
      chunk = JSON.parse(payload) as OpenAiStreamChunk;
    } catch {
      continue;
    }

    if (chunk.error) {
      const message =
        typeof chunk.error === 'string'
          ? chunk.error
          : chunk.error.message ?? 'The provider reported an error mid-stream.';
      throw new ProviderError({
        kind: 'server',
        provider: transport.provider,
        modelRef: request.modelRef,
        message,
      });
    }

    if (chunk.usage) {
      sawUsage = true;
      yield {
        type: 'usage',
        tokensIn: chunk.usage.prompt_tokens ?? null,
        tokensOut: chunk.usage.completion_tokens ?? null,
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) continue;

    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) yield { type: 'reasoning', delta: reasoning };
    if (delta.content) yield { type: 'text', delta: delta.content };

    for (const fragment of delta.tool_calls ?? []) {
      const slot = pending.get(fragment.index) ?? { id: '', name: '', args: '' };
      if (fragment.id) slot.id = fragment.id;
      if (fragment.function?.name) slot.name += fragment.function.name;
      if (fragment.function?.arguments) {
        slot.args += fragment.function.arguments;
      }
      pending.set(fragment.index, slot);
    }
  }

  for (const [index, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    if (!slot.name) continue;
    yield {
      type: 'tool_call',
      call: {
        id: slot.id || `call_${index}`,
        name: slot.name,
        arguments: slot.args || '{}',
      },
    };
  }

  if (!sawUsage) yield { type: 'usage', tokensIn: null, tokensOut: null };
  yield { type: 'done', finishReason };
}

// ---------------------------------------------------------------------------
// Anthropic family
// ---------------------------------------------------------------------------

type AnthropicContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentPart[];
}

function toAnthropicPayload(request: ChatRequest, model: string) {
  const system = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const messages: AnthropicMessage[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      // Anthropic carries tool results on a user turn.
      const part: AnthropicContentPart = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      };
      const last = messages[messages.length - 1];
      if (last?.role === 'user') last.content.push(part);
      else messages.push({ role: 'user', content: [part] });
      continue;
    }

    const parts: AnthropicContentPart[] = [];
    if (message.content) parts.push({ type: 'text', text: message.content });
    for (const attachment of message.attachments ?? []) {
      if (!attachment.imageUrl) continue;
      const parsed = parseDataUrl(attachment.imageUrl);
      if (parsed) {
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsed.mime,
            data: parsed.base64,
          },
        });
      }
    }
    for (const call of message.toolCalls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.arguments || '{}');
      } catch {
        input = {};
      }
      parts.push({ type: 'tool_use', id: call.id, name: call.name, input });
    }
    if (parts.length === 0) parts.push({ type: 'text', text: '' });
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: parts,
    });
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    // Anthropic requires max_tokens; pick a sane ceiling when unset.
    max_tokens: request.maxTokens ?? 4096,
  };
  if (system) body.system = system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  return body;
}

interface AnthropicEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: { type: string; id?: string; name?: string; text?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

async function* streamAnthropic(
  transport: Transport,
  model: string,
  request: ChatRequest,
): AsyncGenerator<ChatEvent> {
  const res = await providerFetch(transport, `${transport.baseUrl}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toAnthropicPayload(request, model)),
    signal: request.signal,
    modelRef: request.modelRef,
  });

  const blocks = new Map<number, { id: string; name: string; json: string }>();
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let finishReason = 'stop';

  for await (const payload of sseChunks(res)) {
    let event: AnthropicEvent;
    try {
      event = JSON.parse(payload) as AnthropicEvent;
    } catch {
      continue;
    }

    switch (event.type) {
      case 'error':
        throw new ProviderError({
          kind: 'server',
          provider: transport.provider,
          modelRef: request.modelRef,
          message: event.error?.message ?? 'Anthropic reported a stream error.',
        });
      case 'message_start':
        tokensIn = event.message?.usage?.input_tokens ?? null;
        break;
      case 'content_block_start':
        if (event.content_block?.type === 'tool_use' && event.index !== undefined) {
          blocks.set(event.index, {
            id: event.content_block.id ?? `call_${event.index}`,
            name: event.content_block.name ?? '',
            json: '',
          });
        }
        break;
      case 'content_block_delta': {
        const delta = event.delta;
        if (!delta) break;
        if (delta.type === 'text_delta' && delta.text) {
          yield { type: 'text', delta: delta.text };
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'reasoning', delta: delta.thinking };
        } else if (delta.type === 'input_json_delta' && event.index !== undefined) {
          const slot = blocks.get(event.index);
          if (slot) slot.json += delta.partial_json ?? '';
        }
        break;
      }
      case 'message_delta':
        if (event.delta?.stop_reason) {
          finishReason =
            event.delta.stop_reason === 'tool_use'
              ? 'tool_calls'
              : event.delta.stop_reason;
        }
        if (event.usage?.output_tokens !== undefined) {
          tokensOut = event.usage.output_tokens;
        }
        break;
      default:
        break;
    }
  }

  for (const [index, slot] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    if (!slot.name) continue;
    yield {
      type: 'tool_call',
      call: {
        id: slot.id || `call_${index}`,
        name: slot.name,
        arguments: slot.json || '{}',
      },
    };
  }

  yield { type: 'usage', tokensIn, tokensOut };
  yield { type: 'done', finishReason };
}

// ---------------------------------------------------------------------------
// Google (Gemini) family
// ---------------------------------------------------------------------------

type GooglePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: unknown } };

function toGooglePayload(request: ChatRequest) {
  const systemText = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const contents: Array<{ role: 'user' | 'model'; parts: GooglePart[] }> = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      let parsed: unknown = message.content;
      try {
        parsed = JSON.parse(message.content);
      } catch {
        parsed = { result: message.content };
      }
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.name ?? message.toolCallId ?? 'tool',
              response: { result: parsed },
            },
          },
        ],
      });
      continue;
    }

    const parts: GooglePart[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const attachment of message.attachments ?? []) {
      if (!attachment.imageUrl) continue;
      const parsed = parseDataUrl(attachment.imageUrl);
      if (parsed) {
        parts.push({
          inlineData: { mimeType: parsed.mime, data: parsed.base64 },
        });
      }
    }
    for (const call of message.toolCalls ?? []) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        args = {};
      }
      parts.push({ functionCall: { name: call.name, args } });
    }
    if (parts.length === 0) parts.push({ text: '' });
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }

  const generationConfig: Record<string, unknown> = {};
  if (request.temperature !== undefined) {
    generationConfig.temperature = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = request.maxTokens;
  }
  if (request.topP !== undefined) generationConfig.topP = request.topP;
  if (request.responseFormat === 'json') {
    generationConfig.responseMimeType = 'application/json';
  }

  const body: Record<string, unknown> = { contents };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  if (request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }
  return body;
}

interface GoogleChunk {
  candidates?: Array<{
    content?: { parts?: Array<Record<string, unknown>> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string };
}

async function* streamGoogle(
  transport: Transport,
  model: string,
  request: ChatRequest,
): AsyncGenerator<ChatEvent> {
  const url = `${transport.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await providerFetch(transport, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toGooglePayload(request)),
    signal: request.signal,
    modelRef: request.modelRef,
  });

  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let finishReason = 'stop';
  const calls: ToolCall[] = [];

  for await (const payload of sseChunks(res)) {
    let chunk: GoogleChunk;
    try {
      chunk = JSON.parse(payload) as GoogleChunk;
    } catch {
      continue;
    }

    if (chunk.error) {
      throw new ProviderError({
        kind: 'server',
        provider: transport.provider,
        modelRef: request.modelRef,
        message: chunk.error.message ?? 'Gemini reported a stream error.',
      });
    }

    if (chunk.usageMetadata) {
      tokensIn = chunk.usageMetadata.promptTokenCount ?? tokensIn;
      tokensOut = chunk.usageMetadata.candidatesTokenCount ?? tokensOut;
    }

    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) {
      finishReason = candidate.finishReason.toLowerCase();
    }
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text) {
        yield { type: 'text', delta: part.text };
      }
      const functionCall = part.functionCall as
        | { name?: string; args?: unknown }
        | undefined;
      if (functionCall?.name) {
        calls.push({
          id: `call_${calls.length}_${functionCall.name}`,
          name: functionCall.name,
          arguments: JSON.stringify(functionCall.args ?? {}),
        });
      }
    }
  }

  for (const call of calls) yield { type: 'tool_call', call };
  if (calls.length > 0) finishReason = 'tool_calls';
  yield { type: 'usage', tokensIn, tokensOut };
  yield { type: 'done', finishReason };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Stream a chat completion as normalized `ChatEvent`s. */
export async function* streamChat(
  userId: string,
  request: ChatRequest,
): AsyncGenerator<ChatEvent> {
  const { provider, model } = parseModelRef(request.modelRef);
  const credentials = await loadCredentials(userId, provider);
  const transport = await resolveTransport(provider, credentials);

  switch (transport.family) {
    case 'anthropic':
      yield* streamAnthropic(transport, model, request);
      return;
    case 'google':
      yield* streamGoogle(transport, model, request);
      return;
    default:
      yield* streamOpenAiCompat(transport, model, request);
  }
}

/**
 * Non-streaming convenience wrapper — used by summarization, fact extraction,
 * planning, skill generation and other internal model calls where there's no
 * UI to stream into.
 */
export async function completeChat(
  userId: string,
  request: ChatRequest,
): Promise<ChatResult> {
  const started = Date.now();
  let content = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let finishReason = 'stop';

  for await (const event of streamChat(userId, request)) {
    switch (event.type) {
      case 'text':
        content += event.delta;
        break;
      case 'reasoning':
        reasoning += event.delta;
        break;
      case 'tool_call':
        toolCalls.push(event.call);
        break;
      case 'usage':
        tokensIn = event.tokensIn ?? tokensIn;
        tokensOut = event.tokensOut ?? tokensOut;
        break;
      case 'done':
        finishReason = event.finishReason;
        break;
    }
  }

  return {
    content,
    reasoning,
    toolCalls,
    tokensIn,
    tokensOut,
    finishReason,
    latencyMs: Date.now() - started,
  };
}

/**
 * Ask a model for JSON and parse it, tolerating fenced output. Used by the
 * planner, fact extractor and skill generator.
 */
export async function completeJson<T>(
  userId: string,
  request: ChatRequest,
): Promise<T> {
  const result = await completeChat(userId, {
    ...request,
    responseFormat: 'json',
  });
  const text = result.content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  // Some models prefix prose before the object — fall back to the outermost
  // brace/bracket span.
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  const slice =
    start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  try {
    return JSON.parse(slice) as T;
  } catch {
    throw new ProviderError({
      kind: 'server',
      modelRef: request.modelRef,
      message: 'The model did not return parseable JSON.',
    });
  }
}
