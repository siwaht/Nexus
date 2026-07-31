import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';
import { usersTable } from './auth';
import { conversationsTable } from './nexus';

/**
 * Generic encrypted secret vault — separate from `providers`, which only
 * holds model-provider credentials. This is where keys for tools and MCP
 * servers live (Brave Search, GitHub PAT, Browserbase, a customer's own
 * API…). Values are AES-256-GCM encrypted and write-only over the API:
 * responses carry only `maskedPreview`.
 */
export const secretsTable = pgTable(
  'secrets',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    /** Stable reference used in configs, e.g. `BRAVE_API_KEY`. */
    name: varchar('name').notNull(),
    label: varchar('label'),
    description: text('description'),
    encryptedValue: text('encrypted_value').notNull(),
    maskedPreview: varchar('masked_preview').notNull(),
    /** Free-form grouping so the UI can show "used by" hints. */
    scope: varchar('scope').notNull().default('tool'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('secrets_user_name_unique').on(table.userId, table.name),
    index('secrets_user_idx').on(table.userId),
  ],
);

/**
 * A configured Model Context Protocol server.
 *
 * `transport` is one of:
 *   http  — Streamable HTTP (the portable default; works on serverless hosts)
 *   sse   — legacy HTTP+SSE remote servers
 *   stdio — spawns a local child process; only available when the API runs on
 *           a long-lived host (see `mcp/transport.ts` for the capability probe)
 */
export const mcpServersTable = pgTable(
  'mcp_servers',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    name: varchar('name').notNull(),
    description: text('description'),
    transport: varchar('transport').notNull().default('http'),
    url: text('url'),
    command: varchar('command'),
    argsJson: jsonb('args_json'),
    /** Header name → secret name (resolved server-side at call time). */
    headerSecretsJson: jsonb('header_secrets_json'),
    /** Env var name → secret name, for stdio servers. */
    envSecretsJson: jsonb('env_secrets_json'),
    staticHeadersJson: jsonb('static_headers_json'),
    enabled: boolean('enabled').notNull().default(true),
    /** untested | connected | error */
    status: varchar('status').notNull().default('untested'),
    statusMessage: text('status_message'),
    serverInfoJson: jsonb('server_info_json'),
    toolCount: integer('tool_count').notNull().default(0),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('mcp_servers_user_name_unique').on(table.userId, table.name),
    index('mcp_servers_user_idx').on(table.userId),
  ],
);

/** Tools discovered from an MCP server, cached so chat turns stay fast. */
export const mcpToolsTable = pgTable(
  'mcp_tools',
  {
    id: serial('id').primaryKey(),
    serverId: integer('server_id')
      .notNull()
      .references(() => mcpServersTable.id, { onDelete: 'cascade' }),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    name: varchar('name').notNull(),
    description: text('description'),
    inputSchemaJson: jsonb('input_schema_json'),
    /** Set by the server when a tool only reads (safe to auto-allow). */
    readOnlyHint: boolean('read_only_hint').notNull().default(false),
    destructiveHint: boolean('destructive_hint').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    discoveredAt: timestamp('discovered_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('mcp_tools_server_name_unique').on(table.serverId, table.name),
    index('mcp_tools_user_idx').on(table.userId),
  ],
);

/**
 * Per-tool authorization. Default is deny-by-ask: anything without a row
 * requires explicit user approval at call time. `toolKey` is the fully
 * qualified key — `builtin:web_fetch` or `mcp:<serverId>:<toolName>`.
 */
export const toolPermissionsTable = pgTable(
  'tool_permissions',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    toolKey: varchar('tool_key').notNull(),
    /** ask | allow | deny — `ask` is the default when no row exists. */
    mode: varchar('mode').notNull().default('ask'),
    /** Optional narrowing, e.g. allowed hostnames for web tools. */
    constraintsJson: jsonb('constraints_json'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('tool_permissions_user_key_unique').on(table.userId, table.toolKey),
    index('tool_permissions_user_idx').on(table.userId),
  ],
);

/** Append-only audit trail of every tool execution. */
export const toolInvocationsTable = pgTable(
  'tool_invocations',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    toolKey: varchar('tool_key').notNull(),
    conversationId: integer('conversation_id'),
    messageId: integer('message_id'),
    agentRunId: integer('agent_run_id'),
    agentTaskId: integer('agent_task_id'),
    /** Arguments with secret-looking values redacted before persisting. */
    argsJson: jsonb('args_json'),
    resultSummary: text('result_summary'),
    /** pending | approved | denied | ok | error */
    status: varchar('status').notNull().default('pending'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('tool_invocations_user_idx').on(table.userId),
    index('tool_invocations_run_idx').on(table.agentRunId),
  ],
);

/**
 * A skill is a reusable, named capability: an instruction block plus an
 * allowlist of tools and optional model/parameter binding. Skills can be
 * hand-authored or generated by the model from a description.
 */
export const skillsTable = pgTable(
  'skills',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    name: varchar('name').notNull(),
    slug: varchar('slug').notNull(),
    description: text('description'),
    /** When to reach for this skill — used for automatic selection. */
    whenToUse: text('when_to_use'),
    instructions: text('instructions').notNull(),
    /** Tool keys this skill is allowed to call. */
    toolKeysJson: jsonb('tool_keys_json'),
    /** Names of MCP servers this skill expects to be connected. */
    mcpServersJson: jsonb('mcp_servers_json'),
    modelRef: varchar('model_ref'),
    temperature: varchar('temperature'),
    /** user | generated */
    source: varchar('source').notNull().default('user'),
    enabled: boolean('enabled').notNull().default(true),
    /** Auto-attach when the model judges the skill relevant. */
    autoSelect: boolean('auto_select').notNull().default(true),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('skills_user_slug_unique').on(table.userId, table.slug),
    index('skills_user_idx').on(table.userId),
  ],
);

/**
 * A multi-agent run. The planner decomposes `goal` into `agent_tasks`,
 * workers execute them (in parallel where the plan says they're
 * independent), and all state lives here so a run survives a restart and
 * can be resumed, cancelled, or partially undone.
 */
export const agentRunsTable = pgTable(
  'agent_runs',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    conversationId: integer('conversation_id').references(
      () => conversationsTable.id,
      { onDelete: 'set null' },
    ),
    goal: text('goal').notNull(),
    /** planning | running | paused | done | failed | cancelled */
    status: varchar('status').notNull().default('planning'),
    plannerModelRef: varchar('planner_model_ref'),
    workerModelRef: varchar('worker_model_ref'),
    maxParallel: integer('max_parallel').notNull().default(3),
    maxSteps: integer('max_steps').notNull().default(40),
    stepsUsed: integer('steps_used').notNull().default(0),
    /** Tool keys the whole run is allowed to touch. */
    toolKeysJson: jsonb('tool_keys_json'),
    skillIdsJson: jsonb('skill_ids_json'),
    resultSummary: text('result_summary'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('agent_runs_user_idx').on(table.userId),
    index('agent_runs_status_idx').on(table.status),
  ],
);

/**
 * One node of a run's to-do tree. `dependsOnJson` holds sibling ordinals
 * that must finish first — anything with no outstanding dependency can be
 * dispatched in parallel.
 */
export const agentTasksTable = pgTable(
  'agent_tasks',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => agentRunsTable.id, { onDelete: 'cascade' }),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    parentTaskId: integer('parent_task_id'),
    ordinal: integer('ordinal').notNull(),
    title: varchar('title').notNull(),
    description: text('description'),
    /** Named worker persona, e.g. `researcher`, `writer`, `reviewer`. */
    agentRole: varchar('agent_role').notNull().default('worker'),
    /** pending | running | done | failed | cancelled | skipped | undone */
    status: varchar('status').notNull().default('pending'),
    dependsOnJson: jsonb('depends_on_json'),
    toolKeysJson: jsonb('tool_keys_json'),
    result: text('result'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    /** Snapshot of prior state so a completed task can be undone. */
    undoSnapshotJson: jsonb('undo_snapshot_json'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('agent_tasks_run_idx').on(table.runId),
    index('agent_tasks_user_idx').on(table.userId),
  ],
);

export type SecretRow = typeof secretsTable.$inferSelect;
export type McpServerRow = typeof mcpServersTable.$inferSelect;
export type McpToolRow = typeof mcpToolsTable.$inferSelect;
export type ToolPermissionRow = typeof toolPermissionsTable.$inferSelect;
export type ToolInvocationRow = typeof toolInvocationsTable.$inferSelect;
export type SkillRow = typeof skillsTable.$inferSelect;
export type AgentRunRow = typeof agentRunsTable.$inferSelect;
export type AgentTaskRow = typeof agentTasksTable.$inferSelect;
