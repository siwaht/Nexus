import {
  db,
  mcpServersTable,
  mcpToolsTable,
  type McpServerRow,
} from '@workspace/db';
import { and, asc, eq } from 'drizzle-orm';

import { resolveSecretMap } from '../secrets';
import {
  errorResult,
  safeToolName,
  textResult,
  type ToolDefinition,
} from '../tools/types';
import {
  McpClient,
  McpError,
  stdioAvailable,
  stdioUnavailableReason,
  type McpConnectionConfig,
  type McpToolDescriptor,
  type McpTransportKind,
} from './client';

/**
 * MCP server management: CRUD, connection pooling, tool discovery, and the
 * adapter that turns a discovered MCP tool into a Nexus `ToolDefinition`.
 *
 * Credentials for a server are never stored on the server row — the row holds
 * a header/env name → secret-name mapping, and the plaintext is resolved from
 * the vault at connect time only.
 */

export interface McpServerView {
  id: number;
  name: string;
  description: string | null;
  transport: McpTransportKind;
  url: string | null;
  command: string | null;
  args: string[];
  headerSecrets: Record<string, string>;
  envSecrets: Record<string, string>;
  staticHeaders: Record<string, string>;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  serverInfo: Record<string, unknown> | null;
  toolCount: number;
  lastConnectedAt: Date | null;
}

export interface McpToolView {
  id: number;
  serverId: number;
  serverName: string;
  name: string;
  toolKey: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  enabled: boolean;
}

export function toServerView(row: McpServerRow): McpServerView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport as McpTransportKind,
    url: row.url,
    command: row.command,
    args: (row.argsJson as string[] | null) ?? [],
    headerSecrets: (row.headerSecretsJson as Record<string, string> | null) ?? {},
    envSecrets: (row.envSecretsJson as Record<string, string> | null) ?? {},
    staticHeaders:
      (row.staticHeadersJson as Record<string, string> | null) ?? {},
    enabled: row.enabled,
    status: row.status,
    statusMessage: row.statusMessage,
    serverInfo: (row.serverInfoJson as Record<string, unknown> | null) ?? null,
    toolCount: row.toolCount,
    lastConnectedAt: row.lastConnectedAt,
  };
}

export function mcpToolKey(serverId: number, toolName: string): string {
  return `mcp:${serverId}:${toolName}`;
}

export async function listServers(userId: string): Promise<McpServerView[]> {
  const rows = await db
    .select()
    .from(mcpServersTable)
    .where(eq(mcpServersTable.userId, userId))
    .orderBy(asc(mcpServersTable.name));
  return rows.map(toServerView);
}

export async function getServer(
  userId: string,
  id: number,
): Promise<McpServerRow | null> {
  const [row] = await db
    .select()
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.id, id)));
  return row ?? null;
}

export interface SaveServerInput {
  name: string;
  description?: string | null;
  transport: McpTransportKind;
  url?: string | null;
  command?: string | null;
  args?: string[];
  headerSecrets?: Record<string, string>;
  envSecrets?: Record<string, string>;
  staticHeaders?: Record<string, string>;
  enabled?: boolean;
}

export async function saveServer(
  userId: string,
  input: SaveServerInput,
  id?: number,
): Promise<McpServerView> {
  if (input.transport === 'stdio' && !stdioAvailable()) {
    throw new McpError(stdioUnavailableReason());
  }
  if (input.transport !== 'stdio' && !input.url) {
    throw new McpError('Remote MCP servers need a URL.');
  }
  if (input.transport === 'stdio' && !input.command) {
    throw new McpError('stdio MCP servers need a command.');
  }

  const values = {
    userId,
    name: input.name.trim().slice(0, 100),
    description: input.description ?? null,
    transport: input.transport,
    url: input.url ?? null,
    command: input.command ?? null,
    argsJson: input.args ?? [],
    headerSecretsJson: input.headerSecrets ?? {},
    envSecretsJson: input.envSecrets ?? {},
    staticHeadersJson: input.staticHeaders ?? {},
    enabled: input.enabled ?? true,
    // Config changed, so the previous connection result no longer applies.
    status: 'untested',
    statusMessage: null,
  };

  if (id !== undefined) {
    const [row] = await db
      .update(mcpServersTable)
      .set(values)
      .where(
        and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.id, id)),
      )
      .returning();
    if (!row) throw new McpError('That MCP server does not exist.');
    dropPooled(userId, row.id);
    return toServerView(row);
  }

  const [row] = await db
    .insert(mcpServersTable)
    .values(values)
    .onConflictDoUpdate({
      target: [mcpServersTable.userId, mcpServersTable.name],
      set: values,
    })
    .returning();
  dropPooled(userId, row.id);
  return toServerView(row);
}

export async function deleteServer(
  userId: string,
  id: number,
): Promise<boolean> {
  dropPooled(userId, id);
  const deleted = await db
    .delete(mcpServersTable)
    .where(and(eq(mcpServersTable.userId, userId), eq(mcpServersTable.id, id)))
    .returning({ id: mcpServersTable.id });
  return deleted.length > 0;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

interface PooledClient {
  client: McpClient;
  expiresAt: number;
}

const POOL_TTL_MS = 5 * 60 * 1000;
const pool = new Map<string, PooledClient>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pool) {
    if (entry.expiresAt < now) {
      entry.client.close();
      pool.delete(key);
    }
  }
}, 60_000).unref();

function poolKey(userId: string, serverId: number): string {
  return `${userId}:${serverId}`;
}

function dropPooled(userId: string, serverId: number): void {
  const key = poolKey(userId, serverId);
  const entry = pool.get(key);
  if (entry) {
    entry.client.close();
    pool.delete(key);
  }
}

async function connectionConfig(
  userId: string,
  row: McpServerRow,
): Promise<McpConnectionConfig> {
  const headerSecrets =
    (row.headerSecretsJson as Record<string, string> | null) ?? {};
  const envSecrets = (row.envSecretsJson as Record<string, string> | null) ?? {};
  const staticHeaders =
    (row.staticHeadersJson as Record<string, string> | null) ?? {};

  const [resolvedHeaders, resolvedEnv] = await Promise.all([
    resolveSecretMap(userId, headerSecrets),
    resolveSecretMap(userId, envSecrets),
  ]);

  const missing = Object.keys(headerSecrets).filter(
    (key) => resolvedHeaders[key] === undefined,
  );
  if (missing.length > 0) {
    throw new McpError(
      `Missing secrets for headers: ${missing.join(', ')}. Add them in Settings → API Keys.`,
    );
  }

  return {
    transport: row.transport as McpTransportKind,
    url: row.url,
    command: row.command,
    args: (row.argsJson as string[] | null) ?? [],
    headers: { ...staticHeaders, ...resolvedHeaders },
    env: resolvedEnv,
  };
}

async function openClient(
  userId: string,
  row: McpServerRow,
): Promise<McpClient> {
  const key = poolKey(userId, row.id);
  const pooled = pool.get(key);
  if (pooled && pooled.expiresAt > Date.now()) {
    pooled.expiresAt = Date.now() + POOL_TTL_MS;
    return pooled.client;
  }
  if (pooled) {
    pooled.client.close();
    pool.delete(key);
  }

  const client = await McpClient.connect(await connectionConfig(userId, row));
  pool.set(key, { client, expiresAt: Date.now() + POOL_TTL_MS });
  return client;
}

export interface TestOutcome {
  ok: boolean;
  message: string;
  toolCount: number;
  serverInfo: Record<string, unknown> | null;
  tools: McpToolView[];
}

/** Connect, discover tools, cache them, and record the outcome on the row. */
export async function testAndDiscover(
  userId: string,
  serverId: number,
): Promise<TestOutcome> {
  const row = await getServer(userId, serverId);
  if (!row) throw new McpError('That MCP server does not exist.');

  try {
    dropPooled(userId, serverId);
    const client = await openClient(userId, row);
    const descriptors = await client.listTools();
    await cacheTools(userId, serverId, descriptors);

    const serverInfo = {
      name: client.serverInfo.name,
      version: client.serverInfo.version,
      protocolVersion: client.serverInfo.protocolVersion,
      instructions: client.serverInfo.instructions,
    };

    await db
      .update(mcpServersTable)
      .set({
        status: 'connected',
        statusMessage: `Connected to ${client.serverInfo.name} ${client.serverInfo.version} — ${descriptors.length} tools`,
        serverInfoJson: serverInfo,
        toolCount: descriptors.length,
        lastConnectedAt: new Date(),
      })
      .where(eq(mcpServersTable.id, serverId));

    return {
      ok: true,
      message: `Connected to ${client.serverInfo.name} — ${descriptors.length} tools discovered.`,
      toolCount: descriptors.length,
      serverInfo,
      tools: await listServerTools(userId, serverId),
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Could not connect to the MCP server.';
    await db
      .update(mcpServersTable)
      .set({ status: 'error', statusMessage: message })
      .where(eq(mcpServersTable.id, serverId));
    return {
      ok: false,
      message,
      toolCount: 0,
      serverInfo: null,
      tools: [],
    };
  }
}

async function cacheTools(
  userId: string,
  serverId: number,
  descriptors: McpToolDescriptor[],
): Promise<void> {
  // Preserve the user's per-tool enable/disable choices across rediscovery.
  const existing = await db
    .select({ name: mcpToolsTable.name, enabled: mcpToolsTable.enabled })
    .from(mcpToolsTable)
    .where(eq(mcpToolsTable.serverId, serverId));
  const enabledByName = new Map(existing.map((t) => [t.name, t.enabled]));

  await db.delete(mcpToolsTable).where(eq(mcpToolsTable.serverId, serverId));
  if (descriptors.length === 0) return;

  await db.insert(mcpToolsTable).values(
    descriptors.map((tool) => ({
      serverId,
      userId,
      name: tool.name,
      description: tool.description,
      inputSchemaJson: tool.inputSchema,
      readOnlyHint: tool.readOnlyHint,
      destructiveHint: tool.destructiveHint,
      enabled: enabledByName.get(tool.name) ?? true,
    })),
  );
}

export async function listServerTools(
  userId: string,
  serverId?: number,
): Promise<McpToolView[]> {
  const rows = await db
    .select({
      id: mcpToolsTable.id,
      serverId: mcpToolsTable.serverId,
      serverName: mcpServersTable.name,
      serverEnabled: mcpServersTable.enabled,
      name: mcpToolsTable.name,
      description: mcpToolsTable.description,
      inputSchemaJson: mcpToolsTable.inputSchemaJson,
      readOnlyHint: mcpToolsTable.readOnlyHint,
      destructiveHint: mcpToolsTable.destructiveHint,
      enabled: mcpToolsTable.enabled,
    })
    .from(mcpToolsTable)
    .innerJoin(mcpServersTable, eq(mcpToolsTable.serverId, mcpServersTable.id))
    .where(
      serverId === undefined
        ? eq(mcpToolsTable.userId, userId)
        : and(
            eq(mcpToolsTable.userId, userId),
            eq(mcpToolsTable.serverId, serverId),
          ),
    )
    .orderBy(asc(mcpServersTable.name), asc(mcpToolsTable.name));

  return rows.map((row) => ({
    id: row.id,
    serverId: row.serverId,
    serverName: row.serverName,
    name: row.name,
    toolKey: mcpToolKey(row.serverId, row.name),
    description: row.description,
    inputSchema:
      (row.inputSchemaJson as Record<string, unknown> | null) ?? {
        type: 'object',
        properties: {},
      },
    readOnlyHint: row.readOnlyHint,
    destructiveHint: row.destructiveHint,
    enabled: row.enabled && row.serverEnabled,
  }));
}

export async function setToolEnabled(
  userId: string,
  toolId: number,
  enabled: boolean,
): Promise<boolean> {
  const updated = await db
    .update(mcpToolsTable)
    .set({ enabled })
    .where(and(eq(mcpToolsTable.userId, userId), eq(mcpToolsTable.id, toolId)))
    .returning({ id: mcpToolsTable.id });
  return updated.length > 0;
}

/** Invoke a cached MCP tool by server id and tool name. */
export async function callMcpTool(
  userId: string,
  serverId: number,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; blocks: Array<Record<string, unknown>>; isError: boolean }> {
  const row = await getServer(userId, serverId);
  if (!row) throw new McpError('That MCP server is no longer configured.');
  if (!row.enabled) throw new McpError(`The MCP server "${row.name}" is disabled.`);
  const client = await openClient(userId, row);
  return client.callTool(toolName, args);
}

/**
 * Adapt every enabled, discovered MCP tool into a Nexus tool definition so the
 * chat loop and agents can call them exactly like built-ins.
 */
export async function mcpToolDefinitions(
  userId: string,
): Promise<ToolDefinition[]> {
  const tools = await listServerTools(userId);
  const usedNames = new Set<string>();

  return tools
    .filter((tool) => tool.enabled)
    .map((tool) => {
      // Namespace the model-facing name so two servers can expose "search".
      let name = safeToolName(`mcp_${tool.serverName}_${tool.name}`);
      if (usedNames.has(name)) {
        name = safeToolName(`${name}_${tool.serverId}`);
      }
      usedNames.add(name);

      const schema = tool.inputSchema;
      const parameters =
        schema && typeof schema === 'object' && 'type' in schema
          ? schema
          : { type: 'object', properties: {} };

      return {
        key: tool.toolKey,
        name,
        title: `${tool.serverName} › ${tool.name}`,
        description:
          tool.description ||
          `The "${tool.name}" tool from the ${tool.serverName} MCP server.`,
        group: 'mcp' as const,
        parameters: parameters as Record<string, unknown>,
        readOnly: tool.readOnlyHint,
        destructive: tool.destructiveHint,
        execute: async (_ctx, args) => {
          try {
            const result = await callMcpTool(
              userId,
              tool.serverId,
              tool.name,
              args,
            );
            if (result.isError) {
              return errorResult(
                result.text || `${tool.name} reported an error.`,
              );
            }
            return textResult(result.text || 'The tool returned no content.', {
              data: result.blocks.length > 0 ? { blocks: result.blocks } : undefined,
            });
          } catch (err) {
            return errorResult(
              err instanceof Error
                ? err.message
                : `Could not call ${tool.name}.`,
            );
          }
        },
      } satisfies ToolDefinition;
    });
}

export { McpError, stdioAvailable, stdioUnavailableReason } from './client';
export type { McpTransportKind } from './client';
