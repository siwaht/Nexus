import { db, filesTable } from '@workspace/db';
import { and, eq, sql } from 'drizzle-orm';

import { browserCapabilities } from '../browser';
import { mcpToolDefinitions } from '../mcp';
import {
  authorizeTool,
  completeInvocation,
  listPermissions,
  recordInvocation,
  type AuthorizeOptions,
  type PermissionMode,
} from '../permissions';
import { BUILTIN_TOOLS, isToolAvailable } from './builtin';
import {
  errorResult,
  toToolSchema,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from './types';

/**
 * The tool registry.
 *
 * Assembles every tool available to a user — built-ins plus whatever their
 * connected MCP servers expose — filters out ones whose prerequisites aren't
 * configured, and exposes a single `executeTool` that always goes through the
 * permission gate and always writes an audit row.
 */

export interface ToolCatalogueEntry {
  key: string;
  name: string;
  title: string;
  description: string;
  group: string;
  readOnly: boolean;
  destructive: boolean;
  autoApprove: boolean;
  available: boolean;
  unavailableReason: string | null;
  permission: PermissionMode;
  parameters: Record<string, unknown>;
}

interface RegistrySnapshot {
  tools: ToolDefinition[];
  byName: Map<string, ToolDefinition>;
  byKey: Map<string, ToolDefinition>;
  expiresAt: number;
}

const CACHE_TTL_MS = 20_000;
const snapshots = new Map<string, RegistrySnapshot>();

export function invalidateToolCache(userId?: string): void {
  if (userId) snapshots.delete(userId);
  else snapshots.clear();
}

async function hasLibraryFiles(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(filesTable)
    .where(and(eq(filesTable.userId, userId), eq(filesTable.status, 'ready')));
  return Number(row?.count ?? 0) > 0;
}

async function buildSnapshot(userId: string): Promise<RegistrySnapshot> {
  const [libraryReady, mcpTools] = await Promise.all([
    hasLibraryFiles(userId),
    mcpToolDefinitions(userId).catch(() => [] as ToolDefinition[]),
  ]);
  const capabilities = browserCapabilities();

  const available = BUILTIN_TOOLS.filter((tool) =>
    isToolAvailable(tool, {
      hasLibraryFiles: libraryReady,
      browserControl: capabilities.canControl,
    }),
  );

  const tools = [...available, ...mcpTools];
  return {
    tools,
    byName: new Map(tools.map((tool) => [tool.name, tool])),
    byKey: new Map(tools.map((tool) => [tool.key, tool])),
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
}

async function snapshot(userId: string): Promise<RegistrySnapshot> {
  const cached = snapshots.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const fresh = await buildSnapshot(userId);
  snapshots.set(userId, fresh);
  return fresh;
}

/** Every tool this user can currently call. */
export async function availableTools(
  userId: string,
): Promise<ToolDefinition[]> {
  return (await snapshot(userId)).tools;
}

export async function findToolByName(
  userId: string,
  name: string,
): Promise<ToolDefinition | null> {
  return (await snapshot(userId)).byName.get(name) ?? null;
}

export async function findToolByKey(
  userId: string,
  key: string,
): Promise<ToolDefinition | null> {
  return (await snapshot(userId)).byKey.get(key) ?? null;
}

/** Model-facing schemas, optionally narrowed to an allowlist of tool keys. */
export async function toolSchemasFor(
  userId: string,
  allowedKeys?: string[] | null,
) {
  const tools = await availableTools(userId);
  const filtered =
    allowedKeys && allowedKeys.length > 0
      ? tools.filter((tool) => allowedKeys.includes(tool.key))
      : tools;
  return filtered.map(toToolSchema);
}

/**
 * The full catalogue for the settings UI: what exists, whether it's usable
 * right now, and the user's current permission for it.
 */
export async function toolCatalogue(
  userId: string,
): Promise<ToolCatalogueEntry[]> {
  const [libraryReady, mcpTools, permissions] = await Promise.all([
    hasLibraryFiles(userId),
    mcpToolDefinitions(userId).catch(() => [] as ToolDefinition[]),
    listPermissions(userId),
  ]);
  const capabilities = browserCapabilities();
  const permissionByKey = new Map(permissions.map((p) => [p.toolKey, p.mode]));

  const describe = (tool: ToolDefinition): ToolCatalogueEntry => {
    let available = true;
    let unavailableReason: string | null = null;
    if (tool.requires === 'library' && !libraryReady) {
      available = false;
      unavailableReason = 'Upload a file to the Library to enable this.';
    }
    if (tool.requires === 'browser' && !capabilities.canControl) {
      available = false;
      unavailableReason = capabilities.reason;
    }

    const defaultMode: PermissionMode =
      (tool.readOnly || tool.autoApprove) && !tool.destructive ? 'allow' : 'ask';

    return {
      key: tool.key,
      name: tool.name,
      title: tool.title,
      description: tool.description,
      group: tool.group,
      readOnly: tool.readOnly,
      destructive: tool.destructive,
      autoApprove: tool.autoApprove === true,
      available,
      unavailableReason,
      permission: permissionByKey.get(tool.key) ?? defaultMode,
      parameters: tool.parameters,
    };
  };

  return [...BUILTIN_TOOLS, ...mcpTools].map(describe);
}

export interface ExecuteOptions extends AuthorizeOptions {
  /** Skip the gate because the user just approved this exact call. */
  preApproved?: boolean;
}

export interface ExecuteOutcome {
  result: ToolResult;
  /** Set when the call was blocked pending approval. */
  needsApproval: boolean;
  toolKey: string;
  toolTitle: string;
  durationMs: number;
}

/**
 * Run a tool by its model-facing name. Handles authorization, argument
 * validation, the audit row, and error normalization — callers just await it.
 */
export async function executeTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
  options: ExecuteOptions = {},
): Promise<ExecuteOutcome> {
  const tool = await findToolByName(ctx.userId, name);
  if (!tool) {
    return {
      result: errorResult(
        `There is no tool called "${name}". Use one of the tools you were given.`,
      ),
      needsApproval: false,
      toolKey: `unknown:${name}`,
      toolTitle: name,
      durationMs: 0,
    };
  }

  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  if (!options.preApproved) {
    const decision = await authorizeTool(ctx.userId, tool, options);
    if (!decision.allowed) {
      await recordInvocation({
        userId: ctx.userId,
        toolKey: tool.key,
        args,
        conversationId: ctx.conversationId ?? null,
        messageId: ctx.messageId ?? null,
        agentRunId: ctx.agentRunId ?? null,
        agentTaskId: ctx.agentTaskId ?? null,
        status: decision.needsApproval ? 'pending' : 'denied',
      });
      return {
        result: errorResult(
          decision.needsApproval
            ? `${tool.title} needs approval before it can run.`
            : (decision.reason ?? `${tool.title} is not permitted.`),
        ),
        needsApproval: decision.needsApproval,
        toolKey: tool.key,
        toolTitle: tool.title,
        durationMs: 0,
      };
    }
  }

  const invocationId = await recordInvocation({
    userId: ctx.userId,
    toolKey: tool.key,
    args,
    conversationId: ctx.conversationId ?? null,
    messageId: ctx.messageId ?? null,
    agentRunId: ctx.agentRunId ?? null,
    agentTaskId: ctx.agentTaskId ?? null,
    status: 'approved',
  });

  const started = Date.now();
  ctx.emit?.({
    toolKey: tool.key,
    toolName: tool.name,
    callId: String(invocationId ?? ''),
    phase: 'started',
    message: tool.title,
  });

  try {
    const result = await tool.execute(ctx, args);
    const durationMs = Date.now() - started;
    await completeInvocation(invocationId, {
      status: result.isError ? 'error' : 'ok',
      resultSummary: result.content.slice(0, 2000),
      error: result.isError ? result.content.slice(0, 1000) : null,
      durationMs,
    });
    ctx.emit?.({
      toolKey: tool.key,
      toolName: tool.name,
      callId: String(invocationId ?? ''),
      phase: result.isError ? 'error' : 'finished',
      message: result.content.slice(0, 300),
      data: result.data,
    });
    return {
      result,
      needsApproval: false,
      toolKey: tool.key,
      toolTitle: tool.title,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message =
      err instanceof Error ? err.message : `${tool.title} failed unexpectedly.`;
    await completeInvocation(invocationId, {
      status: 'error',
      error: message.slice(0, 1000),
      durationMs,
    });
    ctx.emit?.({
      toolKey: tool.key,
      toolName: tool.name,
      callId: String(invocationId ?? ''),
      phase: 'error',
      message,
    });
    return {
      result: errorResult(message),
      needsApproval: false,
      toolKey: tool.key,
      toolTitle: tool.title,
      durationMs,
    };
  }
}

export { BUILTIN_TOOLS } from './builtin';
export * from './types';
