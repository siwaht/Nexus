import { db, modelCatalogueTable, usageLogTable } from '@workspace/db';
import { and, eq, gte, sql } from 'drizzle-orm';

/**
 * Usage and cost tracking.
 *
 * Cost is an estimate derived from whatever pricing the provider publishes in
 * its catalogue (OpenRouter reports per-token prices; most others report
 * nothing). When pricing is unknown the row still records tokens and the
 * estimate stays null — the UI labels it as unavailable rather than guessing.
 */

export interface UsageEntry {
  userId: string;
  modelRef: string;
  operation: 'chat' | 'embed' | 'transcribe' | 'image' | 'tts' | 'rerank';
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Non-token units: seconds of audio, images generated, characters spoken. */
  units?: number | null;
  latencyMs?: number | null;
  conversationId?: number | null;
  agentRunId?: number | null;
}

function parsePrice(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function estimateCost(
  userId: string,
  modelRef: string,
  tokensIn: number | null,
  tokensOut: number | null,
): Promise<number | null> {
  if (tokensIn === null && tokensOut === null) return null;
  const [row] = await db
    .select({ pricing: modelCatalogueTable.pricing })
    .from(modelCatalogueTable)
    .where(
      and(
        eq(modelCatalogueTable.userId, userId),
        eq(modelCatalogueTable.modelRef, modelRef),
      ),
    );
  const pricing = row?.pricing as Record<string, unknown> | null | undefined;
  if (!pricing) return null;

  // OpenRouter reports USD per token as strings.
  const promptPrice = parsePrice(pricing.prompt ?? pricing.input);
  const completionPrice = parsePrice(pricing.completion ?? pricing.output);
  if (promptPrice === null && completionPrice === null) return null;

  return (
    (tokensIn ?? 0) * (promptPrice ?? 0) +
    (tokensOut ?? 0) * (completionPrice ?? 0)
  );
}

export async function logUsage(entry: UsageEntry): Promise<void> {
  const providerName = entry.modelRef.slice(0, entry.modelRef.indexOf(':'));
  const costEstimate = await estimateCost(
    entry.userId,
    entry.modelRef,
    entry.tokensIn ?? null,
    entry.tokensOut ?? null,
  ).catch(() => null);

  await db
    .insert(usageLogTable)
    .values({
      userId: entry.userId,
      modelRef: entry.modelRef,
      providerName: providerName || null,
      operation: entry.operation,
      tokensIn: entry.tokensIn ?? null,
      tokensOut: entry.tokensOut ?? null,
      units: entry.units ?? null,
      costEstimate,
      latencyMs: entry.latencyMs ?? null,
      conversationId: entry.conversationId ?? null,
      agentRunId: entry.agentRunId ?? null,
    })
    .catch(() => {
      // Usage accounting must never break a working chat turn.
    });
}

export interface UsageBucket {
  day: string;
  modelRef: string;
  providerName: string | null;
  operation: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costEstimate: number | null;
}

/** Tokens and estimated spend per model per day, for the usage panel. */
export async function usageByDay(
  userId: string,
  days = 30,
): Promise<UsageBucket[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${usageLogTable.createdAt}), 'YYYY-MM-DD')`,
      modelRef: usageLogTable.modelRef,
      providerName: usageLogTable.providerName,
      operation: usageLogTable.operation,
      calls: sql<number>`count(*)::int`,
      tokensIn: sql<number>`coalesce(sum(${usageLogTable.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${usageLogTable.tokensOut}), 0)::int`,
      costEstimate: sql<
        number | null
      >`case when count(${usageLogTable.costEstimate}) = 0 then null else sum(${usageLogTable.costEstimate}) end`,
    })
    .from(usageLogTable)
    .where(
      and(eq(usageLogTable.userId, userId), gte(usageLogTable.createdAt, since)),
    )
    .groupBy(
      sql`date_trunc('day', ${usageLogTable.createdAt})`,
      usageLogTable.modelRef,
      usageLogTable.providerName,
      usageLogTable.operation,
    )
    .orderBy(sql`date_trunc('day', ${usageLogTable.createdAt}) desc`);

  return rows.map((row) => ({
    day: row.day,
    modelRef: row.modelRef,
    providerName: row.providerName,
    operation: row.operation,
    calls: Number(row.calls),
    tokensIn: Number(row.tokensIn),
    tokensOut: Number(row.tokensOut),
    costEstimate: row.costEstimate === null ? null : Number(row.costEstimate),
  }));
}
