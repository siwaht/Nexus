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
  (table) => [index('models_user_idx').on(table.userId)],
);

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
  (table) => [index('conversations_user_idx').on(table.userId)],
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
    attachmentsJson: jsonb('attachments_json'),
    modelRef: varchar('model_ref'),
    tokenCounts: jsonb('token_counts'),
    latencyMs: integer('latency_ms'),
    rating: integer('rating'),
    parentMessageId: integer('parent_message_id'),
    embedding: jsonb('embedding'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('messages_conversation_idx').on(table.conversationId)],
);

export const summariesTable = pgTable(
  'summaries',
  {
    id: serial('id').primaryKey(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversationsTable.id, { onDelete: 'cascade' }),
    upToMessageId: integer('up_to_message_id').notNull(),
    text: text('text').notNull(),
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
    status: varchar('status').notNull().default('queued'),
    error: text('error'),
    extractedText: text('extracted_text'),
    pageCount: integer('page_count'),
    durationS: doublePrecision('duration_s'),
    tags: jsonb('tags'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('files_user_idx').on(table.userId)],
);

export const fileChunksTable = pgTable(
  'file_chunks',
  {
    id: serial('id').primaryKey(),
    fileId: integer('file_id')
      .notNull()
      .references(() => filesTable.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    pageOrTimestamp: varchar('page_or_timestamp'),
    text: text('text').notNull(),
    embedding: jsonb('embedding'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('file_chunks_file_idx').on(table.fileId)],
);

export const booksTable = pgTable(
  'books',
  {
    id: serial('id').primaryKey(),
    fileId: integer('file_id')
      .notNull()
      .references(() => filesTable.id, { onDelete: 'cascade' }),
    title: varchar('title'),
    author: varchar('author'),
    isbn: varchar('isbn'),
    coverUrl: varchar('cover_url'),
    externalRatingsJson: jsonb('external_ratings_json'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique('books_file_unique').on(table.fileId)],
);

export const memoryFactsTable = pgTable(
  'memory_facts',
  {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    sourceMessageId: integer('source_message_id'),
    confidence: real('confidence'),
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
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costEstimate: doublePrecision('cost_estimate'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('usage_log_user_idx').on(table.userId)],
);

export type ProviderRow = typeof providersTable.$inferSelect;
export type ModelRow = typeof modelsTable.$inferSelect;
export type FolderRow = typeof foldersTable.$inferSelect;
export type ConversationRow = typeof conversationsTable.$inferSelect;
export type MessageRow = typeof messagesTable.$inferSelect;
export type FileRow = typeof filesTable.$inferSelect;
export type FileChunkRow = typeof fileChunksTable.$inferSelect;
export type BookRow = typeof booksTable.$inferSelect;
export type MemoryFactRow = typeof memoryFactsTable.$inferSelect;
export type UsageLogRow = typeof usageLogTable.$inferSelect;
