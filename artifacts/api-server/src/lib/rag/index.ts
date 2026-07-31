import {
  db,
  fileChunksTable,
  filesTable,
  searchVectors,
  syncVector,
} from '@workspace/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  embed,
  logUsage,
  ProviderError,
  rerank,
  resolveModelForTask,
} from '../ai';
import type { Citation } from '../tools/types';

/**
 * Retrieval-augmented generation.
 *
 * Pipeline: embed the query → vector search the top 20 → rerank down to the
 * top 5 → hand back passages with citation metadata. The reranker is optional;
 * if the user has no reranking model the vector order is kept and the result
 * says so rather than pretending it reranked.
 */

export const VECTOR_CANDIDATES = 20;
export const FINAL_PASSAGES = 5;

export interface RetrievedPassage {
  chunkId: number;
  fileId: number;
  filename: string;
  locator: string | null;
  text: string;
  vectorScore: number;
  rerankScore: number | null;
}

export interface RetrievalOutcome {
  passages: RetrievedPassage[];
  reranked: boolean;
  embeddingModel: string;
  note: string | null;
}

/** Embed one query string, reusing the user's configured embedding model. */
export async function embedQuery(
  userId: string,
  text: string,
): Promise<{ embedding: number[]; modelRef: string }> {
  const modelRef = await resolveModelForTask(userId, 'embedding');
  const result = await embed(userId, { modelRef, input: [text] });
  if (result.embeddings.length === 0) {
    throw new ProviderError({
      kind: 'server',
      modelRef,
      message: 'The embedding model returned no vector for the query.',
    });
  }
  await logUsage({
    userId,
    modelRef,
    operation: 'embed',
    tokensIn: result.tokensIn,
    units: 1,
  });
  return { embedding: result.embeddings[0], modelRef };
}

/** Embed and persist chunk vectors in batches. */
export async function embedChunks(
  userId: string,
  chunkIds: number[],
  texts: string[],
): Promise<{ modelRef: string; embedded: number }> {
  const modelRef = await resolveModelForTask(userId, 'embedding');
  const BATCH = 32;
  let embedded = 0;

  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const ids = chunkIds.slice(i, i + BATCH);
    const result = await embed(userId, { modelRef, input: slice });
    await logUsage({
      userId,
      modelRef,
      operation: 'embed',
      tokensIn: result.tokensIn,
      units: slice.length,
    });

    for (let j = 0; j < result.embeddings.length && j < ids.length; j += 1) {
      const vector = result.embeddings[j];
      await db
        .update(fileChunksTable)
        .set({ embedding: vector, embeddingModel: modelRef })
        .where(eq(fileChunksTable.id, ids[j]));
      await syncVector('file_chunks', ids[j], vector);
      embedded += 1;
    }
  }
  return { modelRef, embedded };
}

export interface RetrieveOptions {
  /** Restrict to specific library files (document-scoped chat). */
  fileIds?: number[] | null;
  candidates?: number;
  final?: number;
  /** Drop passages below this cosine score. */
  minScore?: number;
}

export async function retrieve(
  userId: string,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalOutcome> {
  const candidates = options.candidates ?? VECTOR_CANDIDATES;
  const final = options.final ?? FINAL_PASSAGES;
  const { embedding, modelRef } = await embedQuery(userId, query);

  // Server-constructed predicate only — no user text reaches the SQL string.
  const escapedUserId = userId.replace(/'/g, "''");
  const fileFilter =
    options.fileIds && options.fileIds.length > 0
      ? ` AND file_id IN (${options.fileIds.map((id) => Number(id)).join(',')})`
      : '';
  const matches = await searchVectors({
    table: 'file_chunks',
    embedding,
    limit: candidates,
    filterSql: `user_id = '${escapedUserId}'${fileFilter}`,
  });

  if (matches.length === 0) {
    return {
      passages: [],
      reranked: false,
      embeddingModel: modelRef,
      note: 'Nothing in the library matched this query.',
    };
  }

  const scoreById = new Map(matches.map((m) => [m.id, m.score]));
  const rows = await db
    .select({
      id: fileChunksTable.id,
      fileId: fileChunksTable.fileId,
      locator: fileChunksTable.pageOrTimestamp,
      text: fileChunksTable.text,
      filename: filesTable.filename,
    })
    .from(fileChunksTable)
    .innerJoin(filesTable, eq(fileChunksTable.fileId, filesTable.id))
    .where(
      and(
        eq(fileChunksTable.userId, userId),
        inArray(
          fileChunksTable.id,
          matches.map((m) => m.id),
        ),
      ),
    );

  const minScore = options.minScore ?? 0;
  let passages: RetrievedPassage[] = rows
    .map((row) => ({
      chunkId: row.id,
      fileId: row.fileId,
      filename: row.filename,
      locator: row.locator,
      text: row.text,
      vectorScore: scoreById.get(row.id) ?? 0,
      rerankScore: null as number | null,
    }))
    .filter((p) => p.vectorScore >= minScore)
    .sort((a, b) => b.vectorScore - a.vectorScore);

  if (passages.length === 0) {
    return {
      passages: [],
      reranked: false,
      embeddingModel: modelRef,
      note: 'Matches were below the similarity threshold.',
    };
  }

  // Rerank the candidate set down to the passages actually injected.
  let reranked = false;
  let note: string | null = null;
  try {
    const rerankModel = await resolveModelForTask(userId, 'rerank');
    const outcome = await rerank(userId, {
      modelRef: rerankModel,
      query,
      documents: passages.map((p) => p.text),
      topK: final,
    });
    if (outcome.ranking.length > 0) {
      const ordered: RetrievedPassage[] = [];
      for (const entry of outcome.ranking) {
        const passage = passages[entry.index];
        if (passage) {
          ordered.push({ ...passage, rerankScore: entry.score });
        }
      }
      if (ordered.length > 0) {
        passages = ordered;
        reranked = true;
      }
    }
    await logUsage({
      userId,
      modelRef: rerankModel,
      operation: 'rerank',
      units: passages.length,
    });
  } catch (err) {
    // No reranker available is normal — say so instead of silently degrading.
    note =
      err instanceof ProviderError && err.kind === 'unsupported'
        ? 'Ranked by vector similarity only — no reranking model is configured.'
        : null;
  }

  return {
    passages: passages.slice(0, final),
    reranked,
    embeddingModel: modelRef,
    note,
  };
}

export function toCitations(passages: RetrievedPassage[]): Citation[] {
  return passages.map((passage) => ({
    sourceType: 'file' as const,
    fileId: passage.fileId,
    title: passage.filename,
    locator: passage.locator,
    snippet: passage.text.slice(0, 400),
    score: passage.rerankScore ?? passage.vectorScore,
  }));
}

/**
 * Render retrieved passages as a context block with explicit citation labels
 * so the model can reference them and the UI can match them to sources.
 */
export function formatContextBlock(passages: RetrievedPassage[]): string {
  if (passages.length === 0) return '';
  const blocks = passages.map((passage, index) => {
    const anchor = passage.locator ? ` — ${passage.locator}` : '';
    return `[${index + 1}] ${passage.filename}${anchor}\n${passage.text}`;
  });
  return [
    'Retrieved context from the user\'s library. Cite it as [1], [2] and so on.',
    'If the context does not answer the question, say so instead of guessing.',
    '',
    ...blocks,
  ].join('\n');
}

/** Bump the "used in N chats" counter shown in the Library. */
export async function markFilesUsed(fileIds: number[]): Promise<void> {
  if (fileIds.length === 0) return;
  await db
    .update(filesTable)
    .set({ usedInChats: sql`${filesTable.usedInChats} + 1` })
    .where(inArray(filesTable.id, fileIds))
    .catch(() => undefined);
}

export { chunkSegments, chunkText, type Chunk, type SourceSegment } from './chunk';
