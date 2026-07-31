import {
  conversationsTable,
  cosineSimilarity,
  db,
  memoryFactsTable,
  messagesTable,
  searchVectors,
  summariesTable,
  syncVector,
  type MemoryFactRow,
} from '@workspace/db';
import { and, asc, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';

import {
  completeChat,
  completeJson,
  contextWindowFor,
  embed,
  estimateTokens,
  getUserSettings,
  logUsage,
  resolveModelForTask,
  type ChatMessage,
} from './ai';

/**
 * Three layers of memory, all inspectable and editable by the user.
 *
 *  1. Thread memory — the full persisted history. Once a thread passes the
 *     configured share of the model's context window, the oldest turns are
 *     folded into a rolling summary and the recent turns stay verbatim. The
 *     summary is a row in `summaries`, so the UI can show a marker that
 *     expands back to the original messages.
 *  2. Semantic recall — every message is embedded. On each turn the most
 *     relevant older messages (this thread and others) are pulled in and
 *     clearly labelled as recalled, never blended into the live transcript.
 *  3. Long-term facts — durable preferences, projects, people and goals are
 *     extracted after each exchange, deduped against what's already known,
 *     and injected into the system prompt.
 *
 * Switching models mid-thread re-derives the budget against the new context
 * window instead of resetting the conversation.
 */

// ---------------------------------------------------------------------------
// Message embeddings
// ---------------------------------------------------------------------------

export async function embedMessage(
  userId: string,
  messageId: number,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (trimmed.length < 24) return;
  try {
    const modelRef = await resolveModelForTask(userId, 'embedding');
    const result = await embed(userId, {
      modelRef,
      input: [trimmed.slice(0, 8000)],
    });
    const vector = result.embeddings[0];
    if (!vector) return;
    await db
      .update(messagesTable)
      .set({ embedding: vector })
      .where(eq(messagesTable.id, messageId));
    await syncVector('messages', messageId, vector);
    await logUsage({
      userId,
      modelRef,
      operation: 'embed',
      tokensIn: result.tokensIn,
      units: 1,
    });
  } catch {
    // Recall is a nice-to-have; never fail a chat turn over it.
  }
}

// ---------------------------------------------------------------------------
// Semantic recall
// ---------------------------------------------------------------------------

export interface RecalledMessage {
  messageId: number;
  conversationId: number;
  conversationTitle: string | null;
  role: string;
  content: string;
  score: number;
  sameThread: boolean;
  createdAt: Date;
}

/**
 * Pull the most relevant older messages for this query. Excludes the current
 * thread's recent tail, which is already present verbatim.
 */
export async function recallRelated(
  userId: string,
  query: string,
  options: {
    conversationId?: number | null;
    excludeMessageIds?: number[];
    limit?: number;
  } = {},
): Promise<RecalledMessage[]> {
  const limit = options.limit ?? 5;
  if (query.trim().length < 8) return [];

  try {
    const modelRef = await resolveModelForTask(userId, 'embedding');
    const result = await embed(userId, { modelRef, input: [query.slice(0, 4000)] });
    const vector = result.embeddings[0];
    if (!vector) return [];

    const escapedUserId = userId.replace(/'/g, "''");
    const matches = await searchVectors({
      table: 'messages',
      embedding: vector,
      limit: limit * 6,
      filterSql: `conversation_id IN (SELECT id FROM conversations WHERE user_id = '${escapedUserId}')`,
    });

    const excluded = new Set(options.excludeMessageIds ?? []);
    const ids = matches.map((m) => m.id).filter((id) => !excluded.has(id));
    if (ids.length === 0) return [];

    const scoreById = new Map(matches.map((m) => [m.id, m.score]));
    const rows = await db
      .select({
        id: messagesTable.id,
        conversationId: messagesTable.conversationId,
        role: messagesTable.role,
        content: messagesTable.content,
        createdAt: messagesTable.createdAt,
      })
      .from(messagesTable)
      .where(inArray(messagesTable.id, ids));

    const conversationIds = [...new Set(rows.map((r) => r.conversationId))];
    const titles = new Map<number, string | null>();
    if (conversationIds.length > 0) {
      const conversationRows = await db
        .select({
          id: conversationsTable.id,
          title: conversationsTable.title,
        })
        .from(conversationsTable)
        .where(inArray(conversationsTable.id, conversationIds));
      for (const row of conversationRows) titles.set(row.id, row.title);
    }

    return rows
      .filter((row) => row.content.trim().length > 0)
      .map((row) => ({
        messageId: row.id,
        conversationId: row.conversationId,
        conversationTitle: titles.get(row.conversationId) ?? null,
        role: row.role,
        content: row.content.slice(0, 1200),
        score: scoreById.get(row.id) ?? 0,
        sameThread: row.conversationId === options.conversationId,
        createdAt: row.createdAt,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function formatRecall(recalled: RecalledMessage[]): string {
  if (recalled.length === 0) return '';
  const lines = recalled.map((item) => {
    const where = item.sameThread
      ? 'earlier in this conversation'
      : `from "${item.conversationTitle ?? 'another conversation'}"`;
    return `- (${where}, ${item.role}) ${item.content}`;
  });
  return [
    'Recalled context — older messages retrieved because they look relevant.',
    'Treat these as background, not as part of the current exchange.',
    '',
    ...lines,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Long-term facts
// ---------------------------------------------------------------------------

export interface FactView {
  id: number;
  text: string;
  category: string;
  confidence: number | null;
  pinned: boolean;
  sourceMessageId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function toFactView(row: MemoryFactRow): FactView {
  return {
    id: row.id,
    text: row.text,
    category: row.category,
    confidence: row.confidence,
    pinned: row.pinned,
    sourceMessageId: row.sourceMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listFacts(userId: string): Promise<FactView[]> {
  // Superseded facts are kept for history but never presented as current.
  const rows = await db
    .select()
    .from(memoryFactsTable)
    .where(
      and(
        eq(memoryFactsTable.userId, userId),
        isNull(memoryFactsTable.supersededById),
      ),
    )
    .orderBy(desc(memoryFactsTable.pinned), desc(memoryFactsTable.updatedAt));
  return rows.map(toFactView);
}

export async function upsertFact(
  userId: string,
  input: {
    text: string;
    category?: string;
    confidence?: number | null;
    sourceMessageId?: number | null;
    pinned?: boolean;
  },
): Promise<FactView> {
  const [row] = await db
    .insert(memoryFactsTable)
    .values({
      userId,
      text: input.text.trim().slice(0, 2000),
      category: input.category ?? 'fact',
      confidence: input.confidence ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      pinned: input.pinned ?? false,
    })
    .returning();
  void embedFact(userId, row.id, row.text);
  return toFactView(row);
}

export async function updateFact(
  userId: string,
  id: number,
  patch: { text?: string; category?: string; pinned?: boolean },
): Promise<FactView | null> {
  const [row] = await db
    .update(memoryFactsTable)
    .set({
      ...(patch.text !== undefined
        ? { text: patch.text.trim().slice(0, 2000) }
        : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    })
    .where(and(eq(memoryFactsTable.userId, userId), eq(memoryFactsTable.id, id)))
    .returning();
  if (!row) return null;
  if (patch.text !== undefined) void embedFact(userId, row.id, row.text);
  return toFactView(row);
}

export async function deleteFact(userId: string, id: number): Promise<boolean> {
  const deleted = await db
    .delete(memoryFactsTable)
    .where(and(eq(memoryFactsTable.userId, userId), eq(memoryFactsTable.id, id)))
    .returning({ id: memoryFactsTable.id });
  return deleted.length > 0;
}

export async function wipeMemory(userId: string): Promise<number> {
  const deleted = await db
    .delete(memoryFactsTable)
    .where(eq(memoryFactsTable.userId, userId))
    .returning({ id: memoryFactsTable.id });
  return deleted.length;
}

async function embedFact(
  userId: string,
  factId: number,
  text: string,
): Promise<void> {
  try {
    const modelRef = await resolveModelForTask(userId, 'embedding');
    const result = await embed(userId, { modelRef, input: [text] });
    const vector = result.embeddings[0];
    if (!vector) return;
    await db
      .update(memoryFactsTable)
      .set({ embedding: vector })
      .where(eq(memoryFactsTable.id, factId));
    await syncVector('memory_facts', factId, vector);
  } catch {
    // Facts still work without vectors — dedupe just falls back to text.
  }
}

interface ExtractedFact {
  text: string;
  category?: string;
  confidence?: number;
  replaces?: string;
}

/**
 * Extract durable facts from the latest exchange, then dedupe and supersede.
 * A fact that contradicts an existing one replaces it rather than piling up.
 */
export async function extractFacts(
  userId: string,
  exchange: ChatMessage[],
  sourceMessageId: number | null,
): Promise<FactView[]> {
  const settings = await getUserSettings(userId);
  if (!settings.autoMemory) return [];

  const transcript = exchange
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-4)
    .map((m) => `${m.role}: ${m.content.slice(0, 2000)}`)
    .join('\n\n');
  if (transcript.trim().length < 40) return [];

  const existing = await listFacts(userId);
  const known = existing.map((f) => `- ${f.text}`).join('\n');

  let extracted: { facts?: ExtractedFact[] };
  try {
    const modelRef = await resolveModelForTask(userId, 'chat');
    extracted = await completeJson<{ facts?: ExtractedFact[] }>(userId, {
      modelRef,
      temperature: 0,
      maxTokens: 700,
      messages: [
        {
          role: 'system',
          content: [
            'Extract only durable facts about the user worth remembering across conversations:',
            'stable preferences, ongoing projects, people they work with, recurring goals, constraints.',
            '',
            'Rules:',
            '- Ignore one-off task details, transient questions and anything about the assistant.',
            '- Write each fact as a short standalone third-person statement about the user.',
            '- If a new fact contradicts a known one, set "replaces" to the exact known fact text.',
            '- Return {"facts": []} when nothing durable was said. Do not invent facts.',
            '',
            'Respond as JSON: {"facts":[{"text":"…","category":"preference|project|person|goal|fact","confidence":0.0-1.0,"replaces":"…"}]}',
            '',
            known ? `Already known:\n${known}` : 'Nothing is known yet.',
          ].join('\n'),
        },
        { role: 'user', content: transcript },
      ],
    });
  } catch {
    return [];
  }

  const candidates = (extracted.facts ?? [])
    .filter((f) => typeof f.text === 'string' && f.text.trim().length > 8)
    .slice(0, 8);
  if (candidates.length === 0) return [];

  const saved: FactView[] = [];
  const knownByText = new Map(
    existing.map((f) => [f.text.trim().toLowerCase(), f]),
  );

  for (const candidate of candidates) {
    const text = candidate.text.trim().slice(0, 2000);
    const normalized = text.toLowerCase();
    if (knownByText.has(normalized)) continue;

    // Near-duplicate guard: a very similar existing fact gets updated in place.
    const similar = existing.find(
      (f) => textSimilarity(f.text, text) > 0.85,
    );
    const replacesText = candidate.replaces?.trim().toLowerCase();
    const superseded =
      (replacesText && knownByText.get(replacesText)) || similar || null;

    if (superseded) {
      const updated = await updateFact(userId, superseded.id, {
        text,
        category: candidate.category ?? superseded.category,
      });
      if (updated) saved.push(updated);
      continue;
    }

    saved.push(
      await upsertFact(userId, {
        text,
        category: candidate.category ?? 'fact',
        confidence: candidate.confidence ?? null,
        sourceMessageId,
      }),
    );
  }
  return saved;
}

/** Cheap token-overlap similarity, used only for dedupe. */
function textSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2),
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  return shared / Math.max(setA.size, setB.size);
}

/** Facts relevant to this turn, ranked by embedding when available. */
async function relevantFacts(
  userId: string,
  query: string,
  limit: number,
): Promise<FactView[]> {
  const facts = await listFacts(userId);
  if (facts.length <= limit) return facts;

  const pinned = facts.filter((f) => f.pinned);
  const rest = facts.filter((f) => !f.pinned);

  try {
    const modelRef = await resolveModelForTask(userId, 'embedding');
    const result = await embed(userId, { modelRef, input: [query.slice(0, 2000)] });
    const queryVector = result.embeddings[0];
    if (queryVector) {
      const rows = await db
        .select({
          id: memoryFactsTable.id,
          embedding: memoryFactsTable.embedding,
        })
        .from(memoryFactsTable)
        .where(eq(memoryFactsTable.userId, userId));
      const scores = new Map<number, number>();
      for (const row of rows) {
        const vector = row.embedding as number[] | null;
        if (Array.isArray(vector)) {
          scores.set(row.id, cosineSimilarity(queryVector, vector));
        }
      }
      const ranked = rest
        .slice()
        .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
      return [...pinned, ...ranked].slice(0, limit);
    }
  } catch {
    // Fall through to recency.
  }
  return [...pinned, ...rest].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Rolling summaries + context assembly
// ---------------------------------------------------------------------------

export interface AssembledContext {
  messages: ChatMessage[];
  /** Blocks the UI shows as provenance for what the model was given. */
  summaryMarkers: Array<{ upToMessageId: number; text: string }>;
  recalled: RecalledMessage[];
  factsUsed: FactView[];
  droppedMessageCount: number;
  tokenEstimate: number;
}

function messageTokens(message: { role: string; content: string }): number {
  return estimateTokens(message.content) + 8;
}

/**
 * Fold the oldest turns of a thread into a rolling summary once it exceeds the
 * configured share of the model's context window.
 */
export async function summarizeIfNeeded(
  userId: string,
  conversationId: number,
  modelRef: string,
): Promise<{ summarized: boolean; upToMessageId: number | null }> {
  const settings = await getUserSettings(userId);
  const contextWindow = await contextWindowFor(userId, modelRef);
  const budget = Math.floor(contextWindow * settings.summarizeThreshold);

  const [latestSummary] = await db
    .select()
    .from(summariesTable)
    .where(eq(summariesTable.conversationId, conversationId))
    .orderBy(desc(summariesTable.upToMessageId))
    .limit(1);

  const rows = await db
    .select()
    .from(messagesTable)
    .where(
      latestSummary
        ? and(
            eq(messagesTable.conversationId, conversationId),
            gt(messagesTable.id, latestSummary.upToMessageId),
          )
        : eq(messagesTable.conversationId, conversationId),
    )
    .orderBy(asc(messagesTable.id));

  const total = rows.reduce((sum, row) => sum + messageTokens(row), 0);
  if (total <= budget || rows.length < 8) {
    return { summarized: false, upToMessageId: null };
  }

  // Keep the most recent ~40% of the budget verbatim, summarize the rest.
  const keepBudget = Math.floor(budget * 0.4);
  let kept = 0;
  let splitIndex = rows.length;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    kept += messageTokens(rows[i]);
    if (kept > keepBudget) {
      splitIndex = i + 1;
      break;
    }
  }
  const toSummarize = rows.slice(0, splitIndex);
  if (toSummarize.length === 0) {
    return { summarized: false, upToMessageId: null };
  }

  const transcript = toSummarize
    .map((row) => `${row.role}: ${row.content.slice(0, 4000)}`)
    .join('\n\n');

  try {
    const result = await completeChat(userId, {
      modelRef,
      temperature: 0.2,
      maxTokens: 900,
      messages: [
        {
          role: 'system',
          content: [
            'Summarize this conversation segment so it can replace the original turns.',
            'Preserve: decisions made, facts established, constraints, open questions,',
            'names, numbers, file and code references, and anything the user asked to remember.',
            'Drop pleasantries and repetition. Write compact prose or bullets, no preamble.',
            latestSummary
              ? `\nThis continues an earlier summary:\n${latestSummary.text}`
              : '',
          ].join('\n'),
        },
        { role: 'user', content: transcript },
      ],
    });

    const upToMessageId = toSummarize[toSummarize.length - 1].id;
    await db.insert(summariesTable).values({
      conversationId,
      upToMessageId,
      text: result.content.trim(),
      tokenEstimate: estimateTokens(result.content),
    });
    await logUsage({
      userId,
      modelRef,
      operation: 'chat',
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      conversationId,
    });
    return { summarized: true, upToMessageId };
  } catch {
    return { summarized: false, upToMessageId: null };
  }
}

/**
 * Build the message array to send to the model: system prompt + facts,
 * rolling summaries, recalled context, then the verbatim tail. Trims from the
 * oldest verbatim turn if the result still doesn't fit.
 */
export async function assembleContext(
  userId: string,
  options: {
    conversationId: number;
    modelRef: string;
    systemPrompt?: string | null;
    latestUserText: string;
    reserveForResponse?: number;
  },
): Promise<AssembledContext> {
  const settings = await getUserSettings(userId);
  const contextWindow = await contextWindowFor(userId, options.modelRef);
  const reserve = options.reserveForResponse ?? 1500;
  const budget = Math.max(contextWindow - reserve, 1000);

  const summaries = await db
    .select()
    .from(summariesTable)
    .where(eq(summariesTable.conversationId, options.conversationId))
    .orderBy(asc(summariesTable.upToMessageId));
  const latestSummary = summaries[summaries.length - 1] ?? null;

  const verbatimRows = await db
    .select()
    .from(messagesTable)
    .where(
      latestSummary
        ? and(
            eq(messagesTable.conversationId, options.conversationId),
            gt(messagesTable.id, latestSummary.upToMessageId),
            ne(messagesTable.role, 'system'),
          )
        : and(
            eq(messagesTable.conversationId, options.conversationId),
            ne(messagesTable.role, 'system'),
          ),
    )
    .orderBy(asc(messagesTable.id));

  const facts = await relevantFacts(userId, options.latestUserText, 12);
  const recalled = settings.semanticRecall
    ? await recallRelated(userId, options.latestUserText, {
        conversationId: options.conversationId,
        excludeMessageIds: verbatimRows.map((r) => r.id),
        limit: settings.recallLimit,
      })
    : [];

  const systemParts: string[] = [];
  if (options.systemPrompt?.trim()) systemParts.push(options.systemPrompt.trim());
  if (facts.length > 0) {
    systemParts.push(
      [
        'What you already know about this user (from long-term memory):',
        ...facts.map((f) => `- ${f.text}`),
        '',
        'Use these when relevant. If the user contradicts one, trust the user and say so.',
      ].join('\n'),
    );
  }
  if (latestSummary) {
    systemParts.push(
      `Summary of earlier messages in this conversation:\n${latestSummary.text}`,
    );
  }
  const recallBlock = formatRecall(recalled);
  if (recallBlock) systemParts.push(recallBlock);

  const messages: ChatMessage[] = [];
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n---\n\n') });
  }

  // Fit the verbatim tail into whatever budget remains.
  const systemTokens = messages.reduce((sum, m) => sum + messageTokens(m), 0);
  let remaining = budget - systemTokens;
  const tail: ChatMessage[] = [];
  let dropped = 0;

  for (let i = verbatimRows.length - 1; i >= 0; i -= 1) {
    const row = verbatimRows[i];
    const cost = messageTokens(row);
    if (cost > remaining && tail.length > 0) {
      dropped = i + 1;
      break;
    }
    remaining -= cost;
    const attachments = (row.attachmentsJson as
      | Array<{ imageUrl?: string; text?: string }>
      | null) ?? undefined;
    const toolCalls = (row.toolCallsJson as
      | Array<{ id: string; name: string; arguments: string }>
      | null) ?? undefined;
    tail.unshift({
      role: row.role as ChatMessage['role'],
      content: row.content,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }

  messages.push(...tail);

  return {
    messages,
    summaryMarkers: summaries.map((s) => ({
      upToMessageId: s.upToMessageId,
      text: s.text,
    })),
    recalled,
    factsUsed: facts,
    droppedMessageCount: dropped,
    tokenEstimate: messages.reduce((sum, m) => sum + messageTokens(m), 0),
  };
}

export async function listSummaries(conversationId: number) {
  return db
    .select()
    .from(summariesTable)
    .where(eq(summariesTable.conversationId, conversationId))
    .orderBy(asc(summariesTable.upToMessageId));
}
