import {
  completeChat,
  logUsage,
  ProviderError,
  type ChatMessage,
  type ToolSchema,
} from '../ai';
import { executeTool, toolSchemasFor } from '../tools/registry';
import type {
  ArtifactDraft,
  Citation,
  ToolContext,
  ToolProgressEvent,
} from '../tools/types';

/**
 * The agent tool-calling loop.
 *
 * One worker agent: give it a goal, a model, and a set of tools, and it
 * iterates model → tool → model until it produces a final answer or hits its
 * step budget. Used by the multi-agent orchestrator and by `delegate_task`.
 *
 * The chat path has its own streaming loop (`lib/chatEngine.ts`) because it
 * needs token-by-token output; this one reports progress through `emit`
 * instead, since nobody is watching an individual worker's tokens.
 */

export interface AgentLoopOptions {
  userId: string;
  modelRef: string;
  systemPrompt: string;
  messages: ChatMessage[];
  /** Restrict which tools this agent may call. Empty/undefined = all. */
  toolKeys?: string[] | null;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  context: Omit<ToolContext, 'userId' | 'emit' | 'signal'>;
  emit?: (event: ToolProgressEvent) => void;
  onStep?: (step: {
    index: number;
    text: string;
    toolNames: string[];
  }) => void;
}

export interface AgentLoopResult {
  content: string;
  steps: number;
  artifacts: ArtifactDraft[];
  citations: Citation[];
  toolCallsMade: Array<{ name: string; ok: boolean; summary: string }>;
  tokensIn: number;
  tokensOut: number;
  stoppedBecause: 'answered' | 'step-limit' | 'cancelled' | 'error';
  error: string | null;
}

const DEFAULT_MAX_STEPS = 12;

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const schemas: ToolSchema[] = await toolSchemasFor(
    options.userId,
    options.toolKeys,
  );

  const transcript: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    ...options.messages,
  ];

  const artifacts: ArtifactDraft[] = [];
  const citations: Citation[] = [];
  const toolCallsMade: AgentLoopResult['toolCallsMade'] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let lastText = '';

  const toolContext: ToolContext = {
    ...options.context,
    userId: options.userId,
    signal: options.signal,
    emit: options.emit,
    modelRef: options.modelRef,
  };

  // Tools the run pre-authorized don't stop to ask mid-flight.
  const runAllowlist = options.toolKeys?.length
    ? new Set(options.toolKeys)
    : null;

  for (let step = 0; step < maxSteps; step += 1) {
    if (options.signal?.aborted) {
      return {
        content: lastText,
        steps: step,
        artifacts,
        citations,
        toolCallsMade,
        tokensIn,
        tokensOut,
        stoppedBecause: 'cancelled',
        error: null,
      };
    }

    let result;
    try {
      result = await completeChat(options.userId, {
        modelRef: options.modelRef,
        messages: transcript,
        temperature: options.temperature ?? 0.3,
        maxTokens: options.maxTokens ?? 3000,
        tools: schemas.length > 0 ? schemas : undefined,
        signal: options.signal,
      });
    } catch (err) {
      const message =
        err instanceof ProviderError
          ? `${err.message}${err.hint ? ` ${err.hint}` : ''}`
          : err instanceof Error
            ? err.message
            : 'The model call failed.';
      return {
        content: lastText,
        steps: step,
        artifacts,
        citations,
        toolCallsMade,
        tokensIn,
        tokensOut,
        stoppedBecause: 'error',
        error: message,
      };
    }

    tokensIn += result.tokensIn ?? 0;
    tokensOut += result.tokensOut ?? 0;
    await logUsage({
      userId: options.userId,
      modelRef: options.modelRef,
      operation: 'chat',
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      conversationId: options.context.conversationId ?? null,
      agentRunId: options.context.agentRunId ?? null,
    });

    if (result.content.trim()) lastText = result.content.trim();
    options.onStep?.({
      index: step,
      text: result.content,
      toolNames: result.toolCalls.map((call) => call.name),
    });

    // No tools requested — the agent is done.
    if (result.toolCalls.length === 0) {
      return {
        content: lastText,
        steps: step + 1,
        artifacts,
        citations,
        toolCallsMade,
        tokensIn,
        tokensOut,
        stoppedBecause: 'answered',
        error: null,
      };
    }

    transcript.push({
      role: 'assistant',
      content: result.content,
      toolCalls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        transcript.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content:
            'Your arguments were not valid JSON. Retry with a well-formed object.',
        });
        continue;
      }

      const outcome = await executeTool(toolContext, call.name, args, {
        runAllowlist,
        // A background agent has no user watching, so an approval prompt would
        // deadlock it. Anything not pre-authorized is refused with an
        // explanation the agent can work around or report.
        sessionApprovals: undefined,
      });

      toolCallsMade.push({
        name: call.name,
        ok: !outcome.result.isError,
        summary: outcome.result.content.slice(0, 300),
      });
      if (outcome.result.artifacts) artifacts.push(...outcome.result.artifacts);
      if (outcome.result.citations) citations.push(...outcome.result.citations);

      transcript.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: outcome.needsApproval
          ? `${outcome.result.content} This tool requires interactive approval, which isn't available in a background run. Either continue without it or tell the user to allow "${outcome.toolTitle}" in Settings → Tools.`
          : outcome.result.content.slice(0, 20_000),
      });
    }
  }

  return {
    content:
      lastText ||
      'Reached the step limit without producing a final answer.',
    steps: maxSteps,
    artifacts,
    citations,
    toolCallsMade,
    tokensIn,
    tokensOut,
    stoppedBecause: 'step-limit',
    error: null,
  };
}
