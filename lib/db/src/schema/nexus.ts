import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';
import { usersTable } from './auth';

export const providersTable = pgTable(
  'providers',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    name: varchar('name').notNull(),
    encryptedCredentials: text('encrypted_credentials').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    status: varchar('status').notNull().default('untested'),
    statusMessage: text('status_message'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('providers_user_name_unique').on(table.userId, table.name),
    index('providers_user_idx').on(table.userId),
  ],
);

/**
 * Live model catalogue, refreshed from each provider's discovery endpoint
 * (Cloudflare `/ai/models/search`, OpenRouter `/models`, OpenAI `/models`, …).
 * Never hardcoded — `modelsTable` below holds only the user's per-model
 * overrides (enable/disable), this table holds what the provider reports.
 */
export const modelCatalogueTable = pgTable(
  'model_catalogue',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    providerName: varchar('provider_name').notNull(),
    modelRef: varchar('model_ref').notNull(),
    displayName: varchar('display_name'),
    task: varchar('task').notNull().default('Text Generation'),
    description: text('description'),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    modalities: jsonb('modalities'),
    capabilities: jsonb('capabilities'),
    pricing: jsonb('pricing'),
    experimental: boolean('experimental').notNull().default(false),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('model_catalogue_unique').on(
      table.userId,
      table.providerName,
      table.modelRef,
    ),
    index('model_catalogue_user_idx').on(table.userId),
    index('model_catalogue_task_idx').on(table.userId, table.task),
  ],
);

export const modelsTable = pgTable(
  'models',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    providerId: integer('provider_id').references(() => providersTable.id, {
      onDelete: 'cascade',
    }),
    modelRef: varchar('model_ref').notNull(),
    task: varchar('task'),
    contextWindow: integer('context_window'),
    modalities: jsonb('modalities'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('models_user_idx').on(table.userId),
    unique('models_user_ref_unique').on(table.userId, table.modelRef),
  ],
);

/**
 * One row per user: default model per task, memory tuning, appearance, and
 * agent limits. Everything the Settings screen writes that isn't a credential.
 */
export const userSettingsTable = pgTable('user_settings', {
  userId: varchar('user_id')
    .primaryKey()
    .references(() => usersTable.id, { onDelete: 'cascade' }),
  defaultChatModel: varchar('default_chat_model'),
  defaultVisionModel: varchar('default_vision_model'),
  defaultTranscriptionModel: varchar('default_transcription_model'),
  defaultEmbeddingModel: varchar('default_embedding_model'),
  defaultRerankModel: varchar('default_rerank_model'),
  defaultImageModel: varchar('default_image_model'),
  defaultTtsModel: varchar('default_tts_model'),
  autoMemory: boolean('auto_memory').notNull().default(true),
  semanticRecall: boolean('semantic_recall').notNull().default(true),
  summarizeThreshold: real('summarize_threshold').notNull().default(0.6),
  recallLimit: integer('recall_limit').notNull().default(5),
  autoRouteModel: boolean('auto_route_model').notNull().default(true),
  theme: varchar('theme').notNull().default('system'),
  accentColor: varchar('accent_color').notNull().default('default'),
  fontSize: varchar('font_size').notNull().default('md'),
  density: varchar('density').notNull().default('comfortable'),
  codeTheme: varchar('code_theme').notNull().default('github-dark'),
  maxParallelAgents: integer('max_parallel_agents').notNull().default(3),
  maxAgentSteps: integer('max_agent_steps').notNull().default(40),
  browserDriver: varchar('browser_driver').notNull().default('auto'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const foldersTable = pgTable(
  'folders',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    name: varchar('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('folders_user_idx').on(table.userId)],
);

export const conversationsTable = pgTable(
  'conversations',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    folderId: integer('folder_id').references(() => foldersTable.id, {
      onDelete: 'set null',
    }),
    title: varchar('title'),
    modelRef: varchar('model_ref'),
    systemPrompt: text('system_prompt'),
    settingsJson: jsonb('settings_json'),
    scopedFileId: integer('scoped_file_id'),
    skillId: integer('skill_id'),
    useLibrary: boolean('use_library').notNull().default(false),
    webSearch: boolean('web_search').notNull().default(false),
    toolsEnabled: boolean('tools_enabled').notNull().default(true),
    pinned: boolean('pinned').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('conversations_user_idx').on(table.userId),
    index('conversations_user_updated_idx').on(table.userId, table.updatedAt),
  ],
);

export const messagesTable = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversationsTable.id, { onDelete: 'cascade' }),
    role: varchar('role').notNull(),
    content: text('content').notNull(),
    /** Model-visible reasoning trace, when the provider returns one. */
    reasoning: text('reasoning'),
    attachmentsJson: jsonb('attachments_json'),
    /** Tool calls the assistant requested on this turn, with results. */
    toolCallsJson: jsonb('tool_calls_json'),
    /** RAG citations backing this answer: file, page/timestamp, score. */
    citationsJson: jsonb('citations_json'),
    modelRef: varchar('model_ref'),
    tokenCounts: jsonb('token_counts'),
    latencyMs: integer('latency_ms'),
    rating: integer('rating'),
    parentMessageId: integer('parent_message_id'),
    /** Set when this message was produced inside an agent run. */
    agentRunId: integer('agent_run_id'),
    finishReason: varchar('finish_reason'),
    error: text('error'),
    /** Message embedding for cross-thread semantic recall. */
    embedding: jsonb('embedding'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('messages_conversation_idx').on(table.conversationId),
    index('messages_conversation_created_idx').on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

/** Rolling summaries of the oldest turns once a thread outgrows its window. */
export const summariesTable = pgTable(
  'summaries',
  {
    id: serial('id').primaryKey(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversationsTable.id, { onDelete: 'cascade' }),
    upToMessageId: integer('up_to_message_id').notNull(),
    text: text('text').notNull(),
    tokenEstimate: integer('token_estimate'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('summaries_conversation_idx').on(table.conversationId)],
);

export const filesTable = pgTable(
  'files',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    filename: varchar('filename').notNull(),
    mime: varchar('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    storageKey: varchar('storage_key').notNull(),
    kind: varchar('kind').notNull().default('other'),
    /** queued → extracting → chunking → embedding → ready | failed */
    status: varchar('status').notNull().default('queued'),
    progress: integer('progress').notNull().default(0),
    error: text('error'),
    extractedText: text('extracted_text'),
    /** Per-page / per-segment structure kept for citations and viewers. */
    segmentsJson: jsonb('segments_json'),
    metadataJson: jsonb('metadata_json'),
    pageCount: integer('page_count'),
    durationS: doublePrecision('duration_s'),
    tags: jsonb('tags'),
    usedInChats: integer('used_in_chats').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('files_user_idx').on(table.userId),
    index('files_user_status_idx').on(table.userId, table.status),
  ],
);

export const fileChunksTable = pgTable(
  'file_chunks',
  {
    id: serial('id').primaryKey(),
    fileId: integer('file_id')
      .notNull()
      .references(() => filesTable.id, { onDelete: 'cascade' }),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    /** Page number, chapter title, or `mm:ss` timestamp — citation anchor. */
    pageOrTimestamp: varchar('page_or_timestamp'),
    text: text('text').notNull(),
    tokenEstimate: integer('token_estimate'),
    embedding: jsonb('embedding'),
    embeddingModel: varchar('embedding_model'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('file_chunks_file_idx').on(table.fileId),
    index('file_chunks_user_idx').on(table.userId),
  ],
);

/**
 * Rendered side-panel artifacts produced by a message: long documents,
 * chart specs, mermaid sources, generated images, TTS audio.
 */
export const artifactsTable = pgTable(
  'artifacts',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    messageId: integer('message_id').references(() => messagesTable.id, {
      onDelete: 'cascade',
    }),
    /** markdown | code | chart | mermaid | image | audio | table | html */
    kind: varchar('kind').notNull(),
    title: varchar('title'),
    language: varchar('language'),
    content: text('content'),
    mime: varchar('mime'),
    storageKey: varchar('storage_key'),
    metadataJson: jsonb('metadata_json'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('artifacts_user_idx').on(table.userId),
    index('artifacts_message_idx').on(table.messageId),
  ],
);

/** Cache of fetched/scraped web pages so repeat tool calls stay cheap. */
export const webPagesTable = pgTable(
  'web_pages',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    finalUrl: text('final_url'),
    title: varchar('title'),
    siteName: varchar('site_name'),
    contentText: text('content_text'),
    contentMarkdown: text('content_markdown'),
    screenshotKey: varchar('screenshot_key'),
    statusCode: integer('status_code'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('web_pages_user_url_idx').on(table.userId, table.url)],
);

export const memoryFactsTable = pgTable(
  'memory_facts',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** preference | project | person | goal | fact */
    category: varchar('category').notNull().default('fact'),
    sourceMessageId: integer('source_message_id'),
    confidence: real('confidence'),
    embedding: jsonb('embedding'),
    pinned: boolean('pinned').notNull().default(false),
    supersededById: integer('superseded_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('memory_facts_user_idx').on(table.userId)],
);

export const usageLogTable = pgTable(
  'usage_log',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    modelRef: varchar('model_ref').notNull(),
    providerName: varchar('provider_name'),
    /** chat | embed | transcribe | image | tts | rerank */
    operation: varchar('operation').notNull().default('chat'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    units: doublePrecision('units'),
    costEstimate: doublePrecision('cost_estimate'),
    latencyMs: integer('latency_ms'),
    conversationId: integer('conversation_id'),
    agentRunId: integer('agent_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('usage_log_user_idx').on(table.userId),
    index('usage_log_user_created_idx').on(table.userId, table.createdAt),
  ],
);

export type ProviderRow = typeof providersTable.$inferSelect;
export type ModelRow = typeof modelsTable.$inferSelect;
export type ModelCatalogueRow = typeof modelCatalogueTable.$inferSelect;
export type UserSettingsRow = typeof userSettingsTable.$inferSelect;
export type FolderRow = typeof foldersTable.$inferSelect;
export type ConversationRow = typeof conversationsTable.$inferSelect;
export type MessageRow = typeof messagesTable.$inferSelect;
export type SummaryRow = typeof summariesTable.$inferSelect;
export type FileRow = typeof filesTable.$inferSelect;
export type FileChunkRow = typeof fileChunksTable.$inferSelect;
export type ArtifactRow = typeof artifactsTable.$inferSelect;
export type WebPageRow = typeof webPagesTable.$inferSelect;
export type MemoryFactRow = typeof memoryFactsTable.$inferSelect;
export type UsageLogRow = typeof usageLogTable.$inferSelect;
