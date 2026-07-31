import { db, toolInvocationsTable, toolPermissionsTable } from '@workspace/db';
import { and, desc, eq } from 'drizzle-orm';

import { redactSecrets } from './secrets';
import type { ToolDefinition } from './tools/types';

/**
 * Tool authorization — default deny-by-ask.
 *
 * A tool runs only when the user has an explicit `allow`, or approves the
 * specific call. Read-only tools may be auto-allowed (they can't change
 * anything), but anything that writes, spends money, or reaches an external
 * system asks the first time and remembers the answer if the user says
 * "always". Every attempt — approved, denied or failed — lands in the audit
 * log.
 *
 * This matters because MCP servers and browser control are arbitrary remote
 * code paths reachable from a publicly-hosted app. The gate is not optional.
 */

export type PermissionMode = 'ask' | 'allow' | 'deny';

export interface PermissionRecord {
  toolKey: string;
  mode: PermissionMode;
  constraints: Record<string, unknown> | null;
  updatedAt: Date | null;
}

export interface PermissionDecision {
  allowed: boolean;
  /** True when the client must prompt the user before the call proceeds. */
  needsApproval: boolean;
  mode: PermissionMode;
  reason: string | null;
}

export async function listPermissions(
  userId: string,
): Promise<PermissionRecord[]> {
  const rows = await db
    .select()
    .from(toolPermissionsTable)
    .where(eq(toolPermissionsTable.userId, userId));
  return rows.map((row) => ({
    toolKey: row.toolKey,
    mode: row.mode as PermissionMode,
    constraints: (row.constraintsJson as Record<string, unknown> | null) ?? null,
    updatedAt: row.updatedAt,
  }));
}

export async function setPermission(
  userId: string,
  toolKey: string,
  mode: PermissionMode,
  constraints?: Record<string, unknown> | null,
): Promise<PermissionRecord> {
  const [row] = await db
    .insert(toolPermissionsTable)
    .values({
      userId,
      toolKey,
      mode,
      constraintsJson: constraints ?? null,
    })
    .onConflictDoUpdate({
      target: [toolPermissionsTable.userId, toolPermissionsTable.toolKey],
      set: { mode, constraintsJson: constraints ?? null },
    })
    .returning();
  return {
    toolKey: row.toolKey,
    mode: row.mode as PermissionMode,
    constraints: (row.constraintsJson as Record<string, unknown> | null) ?? null,
    updatedAt: row.updatedAt,
  };
}

export async function getPermission(
  userId: string,
  toolKey: string,
): Promise<PermissionRecord | null> {
  const [row] = await db
    .select()
    .from(toolPermissionsTable)
    .where(
      and(
        eq(toolPermissionsTable.userId, userId),
        eq(toolPermissionsTable.toolKey, toolKey),
      ),
    );
  if (!row) return null;
  return {
    toolKey: row.toolKey,
    mode: row.mode as PermissionMode,
    constraints: (row.constraintsJson as Record<string, unknown> | null) ?? null,
    updatedAt: row.updatedAt,
  };
}

export interface AuthorizeOptions {
  /** Approvals the user already granted for this specific turn. */
  sessionApprovals?: Set<string>;
  /** Agent runs pre-authorize a tool allowlist so they don't block mid-run. */
  runAllowlist?: Set<string> | null;
}

/**
 * Decide whether `tool` may execute now.
 *
 * Order: explicit deny wins over everything → explicit allow → an approval
 * already granted this turn → read-only tools auto-allow → otherwise ask.
 */
export async function authorizeTool(
  userId: string,
  tool: ToolDefinition,
  options: AuthorizeOptions = {},
): Promise<PermissionDecision> {
  const record = await getPermission(userId, tool.key);

  if (record?.mode === 'deny') {
    return {
      allowed: false,
      needsApproval: false,
      mode: 'deny',
      reason: `${tool.title} is blocked in Settings → Tools.`,
    };
  }
  if (record?.mode === 'allow') {
    return { allowed: true, needsApproval: false, mode: 'allow', reason: null };
  }

  if (options.sessionApprovals?.has(tool.key)) {
    return { allowed: true, needsApproval: false, mode: 'allow', reason: null };
  }
  if (options.runAllowlist?.has(tool.key)) {
    return { allowed: true, needsApproval: false, mode: 'allow', reason: null };
  }

  // Read-only tools can't mutate anything, so they don't need a prompt.
  // Destructive tools always ask, even when marked read-only by a server.
  if (tool.readOnly && !tool.destructive) {
    return { allowed: true, needsApproval: false, mode: 'allow', reason: null };
  }

  // Safe workspace-local writes proceed without interrupting.
  if (tool.autoApprove && !tool.destructive) {
    return { allowed: true, needsApproval: false, mode: 'allow', reason: null };
  }

  return {
    allowed: false,
    needsApproval: true,
    mode: 'ask',
    reason: `${tool.title} needs your approval before it runs.`,
  };
}

export interface InvocationRecordInput {
  userId: string;
  toolKey: string;
  args: unknown;
  conversationId?: number | null;
  messageId?: number | null;
  agentRunId?: number | null;
  agentTaskId?: number | null;
  status: 'pending' | 'approved' | 'denied' | 'ok' | 'error';
}

/** Open an audit row before a tool runs; returns its id for later completion. */
export async function recordInvocation(
  input: InvocationRecordInput,
): Promise<number | null> {
  try {
    const [row] = await db
      .insert(toolInvocationsTable)
      .values({
        userId: input.userId,
        toolKey: input.toolKey,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        agentRunId: input.agentRunId ?? null,
        agentTaskId: input.agentTaskId ?? null,
        // Never persist raw credential-looking values.
        argsJson: redactSecrets(input.args) as never,
        status: input.status,
      })
      .returning({ id: toolInvocationsTable.id });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export async function completeInvocation(
  id: number | null,
  update: {
    status: 'ok' | 'error' | 'denied';
    resultSummary?: string | null;
    error?: string | null;
    durationMs?: number | null;
  },
): Promise<void> {
  if (id === null) return;
  try {
    await db
      .update(toolInvocationsTable)
      .set({
        status: update.status,
        resultSummary: update.resultSummary?.slice(0, 2000) ?? null,
        error: update.error ?? null,
        durationMs: update.durationMs ?? null,
      })
      .where(eq(toolInvocationsTable.id, id));
  } catch {
    // Audit failures must not break the tool call itself.
  }
}

export interface AuditEntry {
  id: number;
  toolKey: string;
  status: string;
  args: unknown;
  resultSummary: string | null;
  error: string | null;
  durationMs: number | null;
  conversationId: number | null;
  agentRunId: number | null;
  createdAt: Date;
}

export async function listAudit(
  userId: string,
  limit = 100,
): Promise<AuditEntry[]> {
  const rows = await db
    .select()
    .from(toolInvocationsTable)
    .where(eq(toolInvocationsTable.userId, userId))
    .orderBy(desc(toolInvocationsTable.createdAt))
    .limit(Math.min(limit, 500));
  return rows.map((row) => ({
    id: row.id,
    toolKey: row.toolKey,
    status: row.status,
    args: row.argsJson,
    resultSummary: row.resultSummary,
    error: row.error,
    durationMs: row.durationMs,
    conversationId: row.conversationId,
    agentRunId: row.agentRunId,
    createdAt: row.createdAt,
  }));
}
