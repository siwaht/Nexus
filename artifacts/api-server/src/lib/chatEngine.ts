import {
  artifactsTable,
  conversationsTable,
  db,
  messagesTable,
  type ConversationRow,
} from '@workspace/db';
import { and, asc, eq } from 'drizzle-orm';

import {
  contextWindowFor,
  getUserSettings,
  logUsage,
  ProviderError,
  resolveModelForTask,
  streamChat,
  supportsVision,
  type ChatMessage,
  type ToolCall,
  type ToolSchema,
} from './ai';
import { browserCapabilities } from './browser';
import {
  assembleContext,
  embedMessage,
  extractFacts,
  summarizeIfNeeded,
} from './memory';
import {
  formatContextBlock,
  markFilesUsed,
  retrieve,
  toCitations,
} from './rag';
import { getSkill, markSkillUsed, skillPromptBlock, suggestSkills } from './skills';
import { executeTool, toolSchemasFor } from './tools/registry';
import type {
  ArtifactDraft,
  Citation,
  ToolContext,
  ToolProgressEvent,
} from './tools/types';

/**
 * The chat engine.
 *
 * One turn: assemble context (memory + summaries + recall + RAG + skill) →
 * stream tokens → run any tools the model asks for → stream again → persist.
 * Everything is yielded as an event so the route can forward it over SSE
 * without knowing anything about providers or tools.
 *
 * Tool approval doesn't block the stream. When a tool needs the user's consent
 * the turn ends with `awaiting-approval`, the pending calls are persisted on the
 * assistant message, and `resumeTurn` picks up from there once the user
 * answers. That keeps the request short-lived and survives a page reload.
 */

export type ChatStreamEvent =
  | { type: 'start'; messageId: number; modelRef: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'context'; recalled: number; facts: number; summarized: boolean }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'tool'; event: ToolProgressEvent }
  | {
      type: 'tool-approval';
      calls: Array<{
        callId: string;
        toolKey: string;
        toolTitle: string;
        toolName: string;
        args: unknown;
      }>;
    }
  | { type: 'artifact'; artifact: ArtifactDraft & { id: number } }
  | { type: 'usage'; tokensIn: number | null; tokensOut: number | null }
  | { type: 'memory'; facts: Array<{ id: number; text: string }> }
  | {
      type: 'done';
      messageId: number;
      finishReason: string;
      latencyMs: number;
      modelRef: string;
    }
  | { type: 'error'; error: string; kind: string; hint: string | null };

export interface SendMessageInput {
  conversationId: number;
  content: string;
  attachments?: Array<{ imageUrl?: string; text?: string; fileId?: number }>;
  modelRefOverride?: string | null;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  skillId?: number | null;
  useLibrary?: boolean;
  webSearch?: boolean;
  toolsEnabled?: boolean;
  /** Continue from an existing user message instead of creating one. */
  existingUserMessageId?: number | null;
  signal?: AbortSignal;
}

const MAX_TOOL_ROUNDS = 8;

interface PersistedToolCall extends ToolCall {
  status: 'ok' | 'error' | 'pending-approval' | 'denied';
  toolKey?: string;
  toolTitle?: string;
  result?: string;
}

async function loadConversation(
  userId: string,
  conversationId: number,
): Promise<ConversationRow> {
  const [row] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.userId, userId),
        eq(conversationsTable.id, conversationId),
      ),
    );
  if (!row) throw new Error('That conversation does not exist.');
  return row;
}

async function persistArtifacts(
  userId: string,
  messageId: number,
  drafts: ArtifactDraft[],
): Promise<Array<ArtifactDraft & { id: number }>> {
  if (drafts.length === 0) return [];
  const rows = await db
    .insert(artifactsTable)
    .values(
      drafts.map((draft) => ({
        userId,
        messageId,
        kind: draft.kind,
        title: draft.title,
        language: draft.language ?? null,
        content: draft.content ?? null,
        mime: draft.mime ?? null,
        storageKey: draft.storageKey ?? null,
        metadataJson: draft.metadata ?? null,
      })),
    )
    .returning({ id: artifactsTable.id });
  return drafts.map((draft, index) => ({ ...draft, id: rows[index]?.id ?? 0 }));
}

/** The house rules every turn gets, on top of any user or skill prompt. */
function baseSystemPrompt(options: {
  toolsAvailable: boolean;
  browserControl: boolean;
  modelRef: string;
}): string {
  const lines = [
    'You are Nexus, a self-hosted AI workspace assistant.',
    '',
    'Match the output format to the request:',
    '- Tables for comparisons. Fenced code blocks with a language tag for code.',
    '- create_chart when numbers are clearer as a chart, create_diagram for flows and architecture.',
    '- create_document for anything long (summaries, outlines, reports, drafts) so it lands in the side panel rather than the chat scroll.',
    '- LaTeX in $…$ or $$…$$ for maths.',
    '',
    'Be accurate over agreeable. If retrieved context or a tool result does not support an answer, say so plainly rather than filling the gap. Cite library passages as [1], [2] matching the provided context.',
  ];
  if (options.toolsAvailable) {
    lines.push(
      '',
      'You have tools. Use them when they would give a better answer than guessing — search the web for anything current, search the library for anything the user uploaded. Do not narrate that you are about to use a tool; just use it.',
    );
    if (!options.browserControl) {
      lines.push(
        'Browser control is not available on this install, so you can read pages but cannot click or type in them.',
      );
    }
  }
  return lines.join('\n');
}

/**
 * Stream one assistant turn. Yields events; persists the message as it goes so
 * a dropped connection still leaves a complete record.
 */
export async function* sendMessage(
  userId: string,
  input: SendMessageInput,
): AsyncGenerator<ChatStreamEvent> {
  const startedAt = Date.now();
  let assistantMessageId = 0;
  let modelRef = '';

  try {
    const conversation = await loadConversation(userId, input.conversationId);
    const settings = await getUserSettings(userId);

    modelRef =
      input.modelRefOverride ??
      conversation.modelRef ??
      (await resolveModelForTask(userId, 'chat'));

    // A turn with images needs a vision-capable model; switch automatically
    // rather than sending images a text model will ignore.
    const hasImages = (input.attachments ?? []).some((a) => a.imageUrl);
    if (hasImages && settings.autoRouteModel) {
      const visionOk = await supportsVision(userId, modelRef);
      if (!visionOk) {
        modelRef = await resolveModelForTask(userId, 'vision').catch(() => modelRef);
      }
    }

    // Persist the user turn first so the record survives any later failure.
    let userMessageId = input.existingUserMessageId ?? 0;
    if (!userMessageId) {
      const [userRow] = await db
        .insert(messagesTable)
        .values({
          conversationId: input.conversationId,
          role: 'user',
          content: input.content,
          attachmentsJson:
            input.attachments && input.attachments.length > 0
              ? input.attachments
              : null,
        })
        .returning({ id: messagesTable.id });
      userMessageId = userRow.id;
      void embedMessage(userId, userMessageId, input.content);
    }

    // Fold old turns into a summary if the thread has outgrown the window.
    const summarized = await summarizeIfNeeded(
      userId,
      input.conversationId,
      modelRef,
    );

    // Skill selection: explicit choice wins, otherwise suggest by keyword.
    const skillId = input.skillId ?? conversation.skillId ?? null;
    const skills = skillId
      ? [await getSkill(userId, skillId)].filter((skill) => skill !== null)
      : await suggestSkills(userId, input.content);
    const skillBlocks = skills.map((skill) => skillPromptBlock(skill!));
    const skillToolKeys = skills.flatMap((skill) => skill!.toolKeys);
    for (const skill of skills) void markSkillUsed(userId, skill!.id);

    const toolsEnabled =
      input.toolsEnabled ?? conversation.toolsEnabled ?? true;
    const capabilities = browserCapabilities();

    let schemas: ToolSchema[] = [];
    if (toolsEnabled) {
      schemas = await toolSchemasFor(
        userId,
        skillToolKeys.length > 0 ? skillToolKeys : null,
      );
    }

    // Retrieval: explicit toggle, or a document-scoped conversation.
    const useLibrary = input.useLibrary ?? conversation.useLibrary ?? false;
    let ragBlock = '';
    let citations: Citation[] = [];
    if (useLibrary || conversation.scopedFileId) {
      try {
        const outcome = await retrieve(userId, input.content, {
          fileIds: conversation.scopedFileId ? [conversation.scopedFileId] : null,
        });
        if (outcome.passages.length > 0) {
          ragBlock = formatContextBlock(outcome.passages);
          citations = toCitations(outcome.passages);
          void markFilesUsed([
            ...new Set(outcome.passages.map((passage) => passage.fileId)),
          ]);
        }
      } catch {
        // Retrieval failing shouldn't kill the turn — answer without it.
      }
    }

    const context = await assembleContext(userId, {
      conversationId: input.conversationId,
      modelRef,
      systemPrompt: [
        baseSystemPrompt({
          toolsAvailable: schemas.length > 0,
          browserControl: capabilities.canControl,
          modelRef,
        }),
        ...skillBlocks,
        conversation.systemPrompt ?? '',
        ragBlock,
      ]
        .filter((part) => part.trim().length > 0)
        .join('\n\n---\n\n'),
      latestUserText: input.content,
      reserveForResponse: input.maxTokens ?? 2000,
    });

    yield {
      type: 'context',
      recalled: context.recalled.length,
      facts: context.factsUsed.length,
      summarized: summarized.summarized,
    };
    if (citations.length > 0) yield { type: 'citations', citations };

    // Open the assistant row now so tool results and artifacts can attach.
    const [assistantRow] = await db
      .insert(messagesTable)
      .values({
        conversationId: input.conversationId,
        role: 'assistant',
        content: '',
        modelRef,
        parentMessageId: userMessageId,
        citationsJson: citations.length > 0 ? citations : null,
      })
      .returning({ id: messagesTable.id });
    assistantMessageId = assistantRow.id;

    yield { type: 'start', messageId: assistantMessageId, modelRef };

    const toolContext: ToolContext = {
      userId,
      conversationId: input.conversationId,
      messageId: assistantMessageId,
      signal: input.signal,
      modelRef,
    };

    const transcript: ChatMessage[] = [...context.messages];
    const persistedCalls: PersistedToolCall[] = [];
    const allArtifacts: ArtifactDraft[] = [];
    let answer = '';
    let reasoning = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let finishReason = 'stop';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const pendingCalls: ToolCall[] = [];
      let roundText = '';

      for await (const event of streamChat(userId, {
        modelRef,
        messages: transcript,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        topP: input.topP,
        tools: schemas.length > 0 ? schemas : undefined,
        signal: input.signal,
      })) {
        switch (event.type) {
          case 'text':
            roundText += event.delta;
            answer += event.delta;
            yield { type: 'delta', text: event.delta };
            break;
          case 'reasoning':
            reasoning += event.delta;
            yield { type: 'reasoning', text: event.delta };
            break;
          case 'tool_call':
            pendingCalls.push(event.call);
            break;
          case 'usage':
            tokensIn += event.tokensIn ?? 0;
            tokensOut += event.tokensOut ?? 0;
            yield {
              type: 'usage',
              tokensIn: event.tokensIn,
              tokensOut: event.tokensOut,
            };
            break;
          case 'done':
            finishReason = event.finishReason;
            break;
        }
      }

      // Checkpoint the text so far.
      await db
        .update(messagesTable)
        .set({ content: answer, reasoning: reasoning || null })
        .where(eq(messagesTable.id, assistantMessageId));

      if (pendingCalls.length === 0) break;

      transcript.push({
        role: 'assistant',
        content: roundText,
        toolCalls: pendingCalls,
      });

      const awaitingApproval: Array<{
        callId: string;
        toolKey: string;
        toolTitle: string;
        toolName: string;
        args: unknown;
      }> = [];

      for (const call of pendingCalls) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          transcript.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content:
              'Those arguments were not valid JSON. Retry with a well-formed object.',
          });
          persistedCalls.push({ ...call, status: 'error', result: 'Invalid JSON arguments.' });
          continue;
        }

        const outcome = await executeTool(toolContext, call.name, args, {
          runAllowlist: skillToolKeys.length > 0 ? new Set(skillToolKeys) : null,
        });

        if (outcome.needsApproval) {
          awaitingApproval.push({
            callId: call.id,
            toolKey: outcome.toolKey,
            toolTitle: outcome.toolTitle,
            toolName: call.name,
            args,
          });
          persistedCalls.push({
            ...call,
            status: 'pending-approval',
            toolKey: outcome.toolKey,
            toolTitle: outcome.toolTitle,
          });
          continue;
        }

        if (outcome.result.artifacts?.length) {
          const saved = await persistArtifacts(
            userId,
            assistantMessageId,
            outcome.result.artifacts,
          );
          allArtifacts.push(...outcome.result.artifacts);
          for (const artifact of saved) yield { type: 'artifact', artifact };
        }
        if (outcome.result.citations?.length) {
          citations = [...citations, ...outcome.result.citations];
          yield { type: 'citations', citations: outcome.result.citations };
        }

        persistedCalls.push({
          ...call,
          status: outcome.result.isError ? 'error' : 'ok',
          toolKey: outcome.toolKey,
          toolTitle: outcome.toolTitle,
          result: outcome.result.content.slice(0, 4000),
        });
        transcript.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: outcome.result.content.slice(0, 20_000),
        });
      }

      if (awaitingApproval.length > 0) {
        // Pause here. `resumeTurn` continues once the user decides.
        await db
          .update(messagesTable)
          .set({
            content: answer,
            reasoning: reasoning || null,
            toolCallsJson: persistedCalls,
            citationsJson: citations.length > 0 ? citations : null,
            finishReason: 'awaiting-approval',
            tokenCounts: { tokensIn, tokensOut },
            latencyMs: Date.now() - startedAt,
          })
          .where(eq(messagesTable.id, assistantMessageId));

        yield { type: 'tool-approval', calls: awaitingApproval };
        yield {
          type: 'done',
          messageId: assistantMessageId,
          finishReason: 'awaiting-approval',
          latencyMs: Date.now() - startedAt,
          modelRef,
        };
        return;
      }
    }

    const latencyMs = Date.now() - startedAt;
    await db
      .update(messagesTable)
      .set({
        content: answer,
        reasoning: reasoning || null,
        toolCallsJson: persistedCalls.length > 0 ? persistedCalls : null,
        citationsJson: citations.length > 0 ? citations : null,
        tokenCounts: { tokensIn, tokensOut },
        latencyMs,
        finishReason,
      })
      .where(eq(messagesTable.id, assistantMessageId));

    await logUsage({
      userId,
      modelRef,
      operation: 'chat',
      tokensIn,
      tokensOut,
      latencyMs,
      conversationId: input.conversationId,
    });

    void embedMessage(userId, assistantMessageId, answer);
    void autoTitle(userId, input.conversationId, input.content);

    // Long-term fact extraction runs after the answer is delivered.
    const saved = await extractFacts(
      userId,
      [
        { role: 'user', content: input.content },
        { role: 'assistant', content: answer },
      ],
      userMessageId,
    ).catch(() => []);
    if (saved.length > 0) {
      yield {
        type: 'memory',
        facts: saved.map((fact) => ({ id: fact.id, text: fact.text })),
      };
    }

    yield {
      type: 'done',
      messageId: assistantMessageId,
      finishReason,
      latencyMs,
      modelRef,
    };
  } catch (err) {
    const message =
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'The turn failed.';
    const kind = err instanceof ProviderError ? err.kind : 'unknown';
    const hint = err instanceof ProviderError ? err.hint : null;

    if (assistantMessageId) {
      await db
        .update(messagesTable)
        .set({ error: message, finishReason: 'error' })
        .where(eq(messagesTable.id, assistantMessageId))
        .catch(() => undefined);
    }
    yield { type: 'error', error: message, kind, hint };
  }
}

/**
 * Continue a turn that paused for tool approval.
 *
 * `approvals` maps callId → allow/deny. Approved calls run with the gate
 * bypassed (the user just consented); denied calls report back so the model can
 * work around them.
 */
export async function* resumeTurn(
  userId: string,
  input: {
    conversationId: number;
    messageId: number;
    approvals: Record<string, boolean>;
    signal?: AbortSignal;
  },
): AsyncGenerator<ChatStreamEvent> {
  const startedAt = Date.now();
  try {
    const [assistantRow] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, input.messageId));
    if (!assistantRow || assistantRow.conversationId !== input.conversationId) {
      throw new Error('That message does not exist.');
    }
    const conversation = await loadConversation(userId, input.conversationId);
    const modelRef =
      assistantRow.modelRef ??
      conversation.modelRef ??
      (await resolveModelForTask(userId, 'chat'));

    const persistedCalls =
      (assistantRow.toolCallsJson as PersistedToolCall[] | null) ?? [];
    const pending = persistedCalls.filter(
      (call) => call.status === 'pending-approval',
    );
    if (pending.length === 0) {
      throw new Error('That message is not waiting for approval.');
    }

    yield { type: 'start', messageId: input.messageId, modelRef };

    const toolContext: ToolContext = {
      userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      signal: input.signal,
      modelRef,
    };

    // Rebuild the transcript, then replay the paused round's results.
    const history = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, input.conversationId))
      .orderBy(asc(messagesTable.id));

    const transcript: ChatMessage[] = [];
    for (const row of history) {
      if (row.id === input.messageId) break;
      if (row.role === 'system') continue;
      transcript.push({
        role: row.role as ChatMessage['role'],
        content: row.content,
        ...((row.attachmentsJson as never) ? { attachments: row.attachmentsJson as never } : {}),
      });
    }
    transcript.push({
      role: 'assistant',
      content: assistantRow.content,
      toolCalls: persistedCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    });

    // Results already gathered before the pause.
    for (const call of persistedCalls) {
      if (call.status === 'ok' || call.status === 'error') {
        transcript.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: call.result ?? '',
        });
      }
    }

    let citations = (assistantRow.citationsJson as Citation[] | null) ?? [];
    const updatedCalls = [...persistedCalls];

    for (const call of pending) {
      const approved = input.approvals[call.id] === true;
      const index = updatedCalls.findIndex(
        (candidate) => candidate.id === call.id,
      );

      if (!approved) {
        const denial = `The user declined to run ${call.toolTitle ?? call.name}. Continue without it and say what you could not do.`;
        if (index >= 0) {
          updatedCalls[index] = { ...call, status: 'denied', result: denial };
        }
        transcript.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: denial,
        });
        continue;
      }

      let args: unknown = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        args = {};
      }
      const outcome = await executeTool(toolContext, call.name, args, {
        preApproved: true,
      });

      if (outcome.result.artifacts?.length) {
        const saved = await persistArtifacts(
          userId,
          input.messageId,
          outcome.result.artifacts,
        );
        for (const artifact of saved) yield { type: 'artifact', artifact };
      }
      if (outcome.result.citations?.length) {
        citations = [...citations, ...outcome.result.citations];
        yield { type: 'citations', citations: outcome.result.citations };
      }
      if (index >= 0) {
        updatedCalls[index] = {
          ...call,
          status: outcome.result.isError ? 'error' : 'ok',
          result: outcome.result.content.slice(0, 4000),
        };
      }
      transcript.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: outcome.result.content.slice(0, 20_000),
      });
    }

    // One more model pass to turn the tool results into the answer.
    const schemas = conversation.toolsEnabled
      ? await toolSchemasFor(userId, null)
      : [];
    let answer = assistantRow.content;
    let tokensIn = 0;
    let tokensOut = 0;
    let finishReason = 'stop';

    for await (const event of streamChat(userId, {
      modelRef,
      messages: transcript,
      tools: schemas.length > 0 ? schemas : undefined,
      signal: input.signal,
    })) {
      switch (event.type) {
        case 'text':
          answer += event.delta;
          yield { type: 'delta', text: event.delta };
          break;
        case 'reasoning':
          yield { type: 'reasoning', text: event.delta };
          break;
        case 'usage':
          tokensIn += event.tokensIn ?? 0;
          tokensOut += event.tokensOut ?? 0;
          break;
        case 'done':
          finishReason = event.finishReason;
          break;
      }
    }

    const latencyMs = Date.now() - startedAt;
    await db
      .update(messagesTable)
      .set({
        content: answer,
        toolCallsJson: updatedCalls,
        citationsJson: citations.length > 0 ? citations : null,
        finishReason,
        latencyMs,
        tokenCounts: { tokensIn, tokensOut },
      })
      .where(eq(messagesTable.id, input.messageId));

    await logUsage({
      userId,
      modelRef,
      operation: 'chat',
      tokensIn,
      tokensOut,
      latencyMs,
      conversationId: input.conversationId,
    });

    yield {
      type: 'done',
      messageId: input.messageId,
      finishReason,
      latencyMs,
      modelRef,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Resuming failed.';
    yield {
      type: 'error',
      error: message,
      kind: err instanceof ProviderError ? err.kind : 'unknown',
      hint: err instanceof ProviderError ? err.hint : null,
    };
  }
}

/** Name a conversation from its first exchange, once. */
async function autoTitle(
  userId: string,
  conversationId: number,
  firstMessage: string,
): Promise<void> {
  try {
    const [row] = await db
      .select({ title: conversationsTable.title })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    if (row?.title) return;

    const modelRef = await resolveModelForTask(userId, 'chat');
    const { completeChat } = await import('./ai');
    const result = await completeChat(userId, {
      modelRef,
      temperature: 0.3,
      maxTokens: 30,
      messages: [
        {
          role: 'system',
          content:
            'Write a 3-6 word title for this conversation. Title case, no quotes, no trailing punctuation, no preamble.',
        },
        { role: 'user', content: firstMessage.slice(0, 1000) },
      ],
    });
    const title = result.content.replace(/^["']|["']$|\.$/g, '').trim();
    if (title) {
      await db
        .update(conversationsTable)
        .set({ title: title.slice(0, 120) })
        .where(eq(conversationsTable.id, conversationId));
    }
  } catch {
    // A missing title is cosmetic — the sidebar falls back to the first message.
  }
}

/** Token budget report for the composer's context meter. */
export async function contextUsage(
  userId: string,
  conversationId: number,
  modelRef: string,
): Promise<{ used: number; window: number }> {
  const window = await contextWindowFor(userId, modelRef);
  const context = await assembleContext(userId, {
    conversationId,
    modelRef,
    latestUserText: '',
  });
  return { used: context.tokenEstimate, window };
}
