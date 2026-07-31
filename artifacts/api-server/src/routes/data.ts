import {
  agentRunsTable,
  agentTasksTable,
  artifactsTable,
  conversationsTable,
  db,
  fileChunksTable,
  filesTable,
  foldersTable,
  mcpServersTable,
  memoryFactsTable,
  messagesTable,
  skillsTable,
  summariesTable,
  toolPermissionsTable,
  usageLogTable,
  userSettingsTable,
} from '@workspace/db';
import { eq, inArray } from 'drizzle-orm';
import { Router, type IRouter } from 'express';

import { usageByDay } from '../lib/ai';
import { requireAuth } from '../middlewares/requireAuth';
import { boolOr, handler, intParam, str, userId } from './helpers';

/**
 * Usage accounting and whole-workspace export/import.
 *
 * The export is deliberately credential-free: provider keys, vault secrets and
 * MCP header values are never included, because a portable backup that leaks
 * every API key is a liability. MCP servers export their shape and their
 * secret-name references so an import can be re-armed by re-entering keys.
 */

const router: IRouter = Router();

router.use('/usage', requireAuth);
router.use('/data', requireAuth);

router.get(
  '/usage',
  handler(async (req, res) => {
    const uid = userId(req);
    const days = Math.min(intParam(req.query.days, 30) || 30, 365);
    const buckets = await usageByDay(uid, days);

    const totals = buckets.reduce(
      (accumulator, bucket) => ({
        calls: accumulator.calls + bucket.calls,
        tokensIn: accumulator.tokensIn + bucket.tokensIn,
        tokensOut: accumulator.tokensOut + bucket.tokensOut,
        costEstimate:
          bucket.costEstimate === null
            ? accumulator.costEstimate
            : (accumulator.costEstimate ?? 0) + bucket.costEstimate,
        // Any bucket without pricing makes the total a lower bound.
        costComplete:
          accumulator.costComplete && bucket.costEstimate !== null,
      }),
      {
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        costEstimate: null as number | null,
        costComplete: true,
      },
    );

    res.json({ days, buckets, totals });
  }),
);

router.get(
  '/data/export',
  handler(async (req, res) => {
    const uid = userId(req);
    const includeFiles = boolOr(req.query.includeFileText, true);

    const [
      settings,
      folders,
      conversations,
      facts,
      skills,
      permissions,
      mcpServers,
      runs,
      usage,
    ] = await Promise.all([
      db.select().from(userSettingsTable).where(eq(userSettingsTable.userId, uid)),
      db.select().from(foldersTable).where(eq(foldersTable.userId, uid)),
      db.select().from(conversationsTable).where(eq(conversationsTable.userId, uid)),
      db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, uid)),
      db.select().from(skillsTable).where(eq(skillsTable.userId, uid)),
      db
        .select()
        .from(toolPermissionsTable)
        .where(eq(toolPermissionsTable.userId, uid)),
      db.select().from(mcpServersTable).where(eq(mcpServersTable.userId, uid)),
      db.select().from(agentRunsTable).where(eq(agentRunsTable.userId, uid)),
      db.select().from(usageLogTable).where(eq(usageLogTable.userId, uid)),
    ]);

    const conversationIds = conversations.map((row) => row.id);
    const messages =
      conversationIds.length > 0
        ? await db
            .select()
            .from(messagesTable)
            .where(inArray(messagesTable.conversationId, conversationIds))
        : [];
    const summaries =
      conversationIds.length > 0
        ? await db
            .select()
            .from(summariesTable)
            .where(inArray(summariesTable.conversationId, conversationIds))
        : [];
    const artifacts = await db
      .select()
      .from(artifactsTable)
      .where(eq(artifactsTable.userId, uid));
    const files = await db.select().from(filesTable).where(eq(filesTable.userId, uid));
    const runIds = runs.map((row) => row.id);
    const tasks =
      runIds.length > 0
        ? await db
            .select()
            .from(agentTasksTable)
            .where(inArray(agentTasksTable.runId, runIds))
        : [];

    const payload = {
      format: 'nexus-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      note: 'Credentials are intentionally excluded. Re-enter provider keys and vault secrets after importing.',
      settings: settings[0] ?? null,
      folders,
      conversations,
      // Embeddings are large and regenerable; drop them from the archive.
      messages: messages.map(({ embedding: _embedding, ...rest }) => rest),
      summaries,
      artifacts,
      files: files.map(
        ({ extractedText, segmentsJson, ...rest }) =>
          includeFiles ? { ...rest, extractedText, segmentsJson } : rest,
      ),
      memoryFacts: facts.map(({ embedding: _embedding, ...rest }) => rest),
      skills,
      toolPermissions: permissions,
      mcpServers: mcpServers.map(({ id, userId: _userId, ...rest }) => rest),
      agentRuns: runs,
      agentTasks: tasks,
      usageLog: usage,
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="nexus-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    res.send(JSON.stringify(payload, null, 2));
  }),
);

router.post(
  '/data/import',
  handler(async (req, res) => {
    const uid = userId(req);
    const payload = (req.body ?? {}) as Record<string, unknown>;
    if (payload.format !== 'nexus-export') {
      throw new Error('That file is not a Nexus export.');
    }

    const imported = {
      folders: 0,
      conversations: 0,
      messages: 0,
      memoryFacts: 0,
      skills: 0,
      toolPermissions: 0,
      mcpServers: 0,
    };

    // Folders first, then remap conversation folder ids onto the new rows.
    const folderIdMap = new Map<number, number>();
    for (const entry of asArray(payload.folders)) {
      const name = str(entry.name);
      if (!name) continue;
      const [row] = await db
        .insert(foldersTable)
        .values({ userId: uid, name })
        .returning({ id: foldersTable.id });
      if (typeof entry.id === 'number') folderIdMap.set(entry.id, row.id);
      imported.folders += 1;
    }

    const conversationIdMap = new Map<number, number>();
    for (const entry of asArray(payload.conversations)) {
      const [row] = await db
        .insert(conversationsTable)
        .values({
          userId: uid,
          title: typeof entry.title === 'string' ? entry.title : null,
          folderId:
            typeof entry.folderId === 'number'
              ? (folderIdMap.get(entry.folderId) ?? null)
              : null,
          modelRef: typeof entry.modelRef === 'string' ? entry.modelRef : null,
          systemPrompt:
            typeof entry.systemPrompt === 'string' ? entry.systemPrompt : null,
          pinned: entry.pinned === true,
          archived: entry.archived === true,
        })
        .returning({ id: conversationsTable.id });
      if (typeof entry.id === 'number') conversationIdMap.set(entry.id, row.id);
      imported.conversations += 1;
    }

    const messageRows = asArray(payload.messages)
      .map((entry) => {
        const conversationId =
          typeof entry.conversationId === 'number'
            ? conversationIdMap.get(entry.conversationId)
            : undefined;
        if (!conversationId) return null;
        return {
          conversationId,
          role: str(entry.role, 'user'),
          content: str(entry.content),
          modelRef: typeof entry.modelRef === 'string' ? entry.modelRef : null,
          attachmentsJson: (entry.attachmentsJson as never) ?? null,
          toolCallsJson: (entry.toolCallsJson as never) ?? null,
          citationsJson: (entry.citationsJson as never) ?? null,
          tokenCounts: (entry.tokenCounts as never) ?? null,
          latencyMs: typeof entry.latencyMs === 'number' ? entry.latencyMs : null,
          rating: typeof entry.rating === 'number' ? entry.rating : null,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    for (let i = 0; i < messageRows.length; i += 500) {
      await db.insert(messagesTable).values(messageRows.slice(i, i + 500));
    }
    imported.messages = messageRows.length;

    for (const entry of asArray(payload.memoryFacts)) {
      const text = str(entry.text);
      if (!text) continue;
      await db.insert(memoryFactsTable).values({
        userId: uid,
        text,
        category: str(entry.category, 'fact'),
        pinned: entry.pinned === true,
      });
      imported.memoryFacts += 1;
    }

    for (const entry of asArray(payload.skills)) {
      const name = str(entry.name);
      const instructions = str(entry.instructions);
      if (!name || !instructions) continue;
      await db
        .insert(skillsTable)
        .values({
          userId: uid,
          name,
          slug: str(entry.slug, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
          description: typeof entry.description === 'string' ? entry.description : null,
          whenToUse: typeof entry.whenToUse === 'string' ? entry.whenToUse : null,
          instructions,
          toolKeysJson: (entry.toolKeysJson as never) ?? [],
          mcpServersJson: (entry.mcpServersJson as never) ?? [],
          source: 'user',
        })
        .onConflictDoNothing();
      imported.skills += 1;
    }

    for (const entry of asArray(payload.toolPermissions)) {
      const toolKey = str(entry.toolKey);
      const mode = str(entry.mode, 'ask');
      if (!toolKey || !['ask', 'allow', 'deny'].includes(mode)) continue;
      await db
        .insert(toolPermissionsTable)
        .values({ userId: uid, toolKey, mode })
        .onConflictDoUpdate({
          target: [toolPermissionsTable.userId, toolPermissionsTable.toolKey],
          set: { mode },
        });
      imported.toolPermissions += 1;
    }

    for (const entry of asArray(payload.mcpServers)) {
      const name = str(entry.name);
      if (!name) continue;
      await db
        .insert(mcpServersTable)
        .values({
          userId: uid,
          name,
          description: typeof entry.description === 'string' ? entry.description : null,
          transport: str(entry.transport, 'http'),
          url: typeof entry.url === 'string' ? entry.url : null,
          command: typeof entry.command === 'string' ? entry.command : null,
          argsJson: (entry.argsJson as never) ?? [],
          headerSecretsJson: (entry.headerSecretsJson as never) ?? {},
          envSecretsJson: (entry.envSecretsJson as never) ?? {},
          staticHeadersJson: (entry.staticHeadersJson as never) ?? {},
          // Imported servers start untested: their secrets don't exist yet.
          enabled: false,
          status: 'untested',
          statusMessage:
            'Imported. Add the referenced secrets in Settings → API Keys, then test the connection.',
        })
        .onConflictDoNothing();
      imported.mcpServers += 1;
    }

    res.json({ imported });
  }),
);

/** Delete every row this user owns, but keep the account itself. */
router.post(
  '/data/delete-all',
  handler(async (req, res) => {
    const uid = userId(req);
    if (str(req.body?.confirm) !== 'DELETE') {
      throw new Error(
        'Send { "confirm": "DELETE" } to erase all workspace data. This cannot be undone.',
      );
    }

    // Cascades handle messages, chunks and tasks; provider credentials are left
    // alone so the user isn't locked out of their own models afterwards.
    await db.delete(agentRunsTable).where(eq(agentRunsTable.userId, uid));
    await db.delete(artifactsTable).where(eq(artifactsTable.userId, uid));
    await db.delete(fileChunksTable).where(eq(fileChunksTable.userId, uid));
    await db.delete(filesTable).where(eq(filesTable.userId, uid));
    await db.delete(conversationsTable).where(eq(conversationsTable.userId, uid));
    await db.delete(foldersTable).where(eq(foldersTable.userId, uid));
    await db.delete(memoryFactsTable).where(eq(memoryFactsTable.userId, uid));
    await db.delete(skillsTable).where(eq(skillsTable.userId, uid));
    await db.delete(usageLogTable).where(eq(usageLogTable.userId, uid));

    res.json({ deleted: true });
  }),
);

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  );
}

export default router;
