import { sql } from 'drizzle-orm';
import { db } from './index';

/**
 * Vector storage behind one repository interface with two drivers.
 *
 *   pgvector — used when the extension is available. Embeddings are mirrored
 *              into a `vector` column and similarity runs in Postgres.
 *   json     — the portable fallback. Embeddings live in the existing `jsonb`
 *              columns and cosine similarity runs in-process.
 *
 * Callers never branch on the driver: they call `searchVectors` and get
 * ranked ids back either way. `initVectorStore()` decides once at boot.
 */

export type VectorDriver = 'pgvector' | 'json';

export interface VectorMatch {
  id: number;
  score: number;
}

/** Tables that carry embeddings, and the column each one uses. */
export const VECTOR_TARGETS = {
  file_chunks: { jsonColumn: 'embedding', vecColumn: 'embedding_vec' },
  messages: { jsonColumn: 'embedding', vecColumn: 'embedding_vec' },
  memory_facts: { jsonColumn: 'embedding', vecColumn: 'embedding_vec' },
} as const;

export type VectorTable = keyof typeof VECTOR_TARGETS;

let driver: VectorDriver | null = null;

export function vectorDriver(): VectorDriver {
  return driver ?? 'json';
}

/**
 * Probe for pgvector and, if present, add the mirror columns. Safe to call
 * repeatedly — every statement is idempotent. Any failure (no superuser, no
 * extension available) silently selects the JSON driver.
 */
export async function initVectorStore(): Promise<VectorDriver> {
  if (driver) return driver;
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    for (const [table, cols] of Object.entries(VECTOR_TARGETS)) {
      await db.execute(
        sql.raw(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${cols.vecColumn} vector`,
        ),
      );
    }
    driver = 'pgvector';
  } catch {
    driver = 'json';
  }
  return driver;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Mirror an embedding into the pgvector column. No-op on the JSON driver. */
export async function syncVector(
  table: VectorTable,
  id: number,
  embedding: number[],
): Promise<void> {
  if (vectorDriver() !== 'pgvector') return;
  const cols = VECTOR_TARGETS[table];
  try {
    await db.execute(
      sql.raw(
        `UPDATE ${table} SET ${cols.vecColumn} = '${toVectorLiteral(embedding)}'::vector WHERE id = ${Number(id)}`,
      ),
    );
  } catch {
    // A dimension mismatch against existing rows shouldn't break ingestion —
    // the JSON column is still authoritative and search falls back to it.
  }
}

export interface VectorSearchOptions {
  table: VectorTable;
  embedding: number[];
  limit: number;
  /** Raw SQL predicate, already parameter-free and server-constructed. */
  filterSql?: string;
  /** Candidate cap for the in-process driver. */
  candidateLimit?: number;
}

/**
 * Rank rows by cosine similarity to `embedding`. Returns `{ id, score }`
 * with score in [0,1] (1 = identical direction) regardless of driver.
 */
export async function searchVectors({
  table,
  embedding,
  limit,
  filterSql,
  candidateLimit = 5000,
}: VectorSearchOptions): Promise<VectorMatch[]> {
  if (embedding.length === 0) return [];
  const cols = VECTOR_TARGETS[table];
  const where = filterSql ? `WHERE ${filterSql}` : '';

  if (vectorDriver() === 'pgvector') {
    try {
      const literal = toVectorLiteral(embedding);
      const predicate = filterSql
        ? `${where} AND ${cols.vecColumn} IS NOT NULL`
        : `WHERE ${cols.vecColumn} IS NOT NULL`;
      const result = await db.execute(
        sql.raw(
          `SELECT id, 1 - (${cols.vecColumn} <=> '${literal}'::vector) AS score
           FROM ${table} ${predicate}
           ORDER BY ${cols.vecColumn} <=> '${literal}'::vector
           LIMIT ${Number(limit)}`,
        ),
      );
      const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
      const matches = (rows as { id: number; score: string | number }[]).map(
        (r) => ({ id: Number(r.id), score: Number(r.score) }),
      );
      if (matches.length > 0) return matches;
    } catch {
      // Fall through to the in-process path.
    }
  }

  const result = await db.execute(
    sql.raw(
      `SELECT id, ${cols.jsonColumn} AS embedding
       FROM ${table} ${where}${where ? ' AND' : 'WHERE'} ${cols.jsonColumn} IS NOT NULL
       LIMIT ${Number(candidateLimit)}`,
    ),
  );
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
  return (rows as { id: number; embedding: unknown }[])
    .map((row) => {
      const vec = Array.isArray(row.embedding)
        ? (row.embedding as number[])
        : typeof row.embedding === 'string'
          ? (JSON.parse(row.embedding) as number[])
          : null;
      if (!vec) return null;
      return { id: Number(row.id), score: cosineSimilarity(embedding, vec) };
    })
    .filter((m): m is VectorMatch => m !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
