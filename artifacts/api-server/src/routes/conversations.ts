import {
  artifactsTable,
  conversationsTable,
  db,
  foldersTable,
  messagesTable,
} from '@workspace/db';
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { Router, type IRouter } from 'express';

import { listSummaries } from '../lib/memory';
import { requireAuth } from '../middlewares/requireAuth';
import {
  boolOr,
  handler,
  intParam,
  numberOr,
  optionalStr,
  requireIntParam,
  str,
  userId,
} from './helpers';

/**
 * Conversations, folders and messages.
 *
 * Covers everything the sidebar and message thread need: search, folders,
 * rename/pin/archive/delete, per-message rating, edit-and-resend, branching,
 * and Markdown/JSON export.
 */

const router: IRouter = Router();

router.use('/conversations', requireAuth);
router.use('/folders', requireAuth);

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

router.get(
  '/folders',
  handler(async (req, res) => {
    const rows = await db
      .select()
      .from(foldersTable)
      .where(eq(foldersTable.userId, userId(req)))
      .orderBy(asc(foldersTable.name));
    res.json({ folders: rows });
  }),
);

router.post(
  '/folders',
  handler(async (req, res) => {
    const name = str(req.body?.name).trim();
    if (!name) throw new Error('A folder needs a name.');
    const [row] = await db
      .insert(foldersTable)
      .values({ userId: userId(req), name: name.slice(0, 100) })
      .returning();
    res.json({ folder: row });
  }),
);

router.patch(
  '/folders/:id',
  handler(async (req, res) => {
    const id = requireIntParam(req.params.id, 'id');
    const name = str(req.body?.name).trim();
    if (!name) throw new Error('A folder needs a name.');
    const [row] = await db
      .update(foldersTable)
      .set({ name: name.slice(0, 100) })
      .where(and(eq(foldersTable.userId, userId(req)), eq(foldersTable.id, id)))
      .returning();
    if (!row) throw new Error('That folder does not exist.');
    res.json({ folder: row });
  }),
);

router.delete(
  '/folders/:id',
  handler(async (req, res) => {
    const id = requireIntParam(req.params.id, 'id');
    await db
      .delete(foldersTable)
      .where(and(eq(foldersTable.userId, userId(req)), eq(foldersTable.id, id)));
    res.json({ deleted: true });
  }),
);

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

router.get(
  '/conversations',
  handler(async (req, res) => {
    const uid = userId(req);
    const search = optionalStr(req.query.search);
    const includeArchived = boolOr(req.query.archived, false);

    const rows = await db
      .select({
        id: conversationsTable.id,
        title: conversationsTable.title,
        folderId: conversationsTable.folderId,
        modelRef: conversationsTable.modelRef,
        pinned: conversationsTable.pinned,
        archived: conversationsTable.archived,
        scopedFileId: conversationsTable.scopedFileId,
        skillId: conversationsTable.skillId,
        useLibrary: conversationsTable.useLibrary,
        webSearch: conversationsTable.webSearch,
        toolsEnabled: conversationsTable.toolsEnabled,
        createdAt: conversationsTable.createdAt,
        updatedAt: conversationsTable.updatedAt,
      })
      .from(conversationsTable)
      .where(eq(conversationsTable.userId, uid))
      .orderBy(desc(conversationsTable.pinned), desc(conversationsTable.updatedAt));

    let list = includeArchived ? rows : rows.filter((row) => !row.archived);

    // Search covers titles and message bodies, so an untitled thread is findable.
    if (search) {
      const pattern = `%${search}%`;
      const matches = await db
        .selectDistinct({ conversationId: messagesTable.conversationId })
        .from(messagesTable)
        .where(
          and(
            inArray(
              messagesTable.conversationId,
              list.map((row) => row.id),
            ),
            ilike(messagesTable.content, pattern),
          ),
        );
      const matchedIds = new Set(matches.map((row) => row.conversationId));
      const lower = search.toLowerCase();
      list = list.filter(
        (row) =>
          matchedIds.has(row.id) ||
          (row.title ?? '').toLowerCase().includes(lower),
      );
    }

    res.json({ conversations: list });
  }),
);

router.post(
  '/conversations',
  handler(async (req, res) => {
    const uid = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const [row] = await db
      .insert(conversationsTable)
      .values({
        userId: uid,
        title: optionalStr(body.title),
        folderId: body.folderId === null ? null : intParam(body.folderId) || null,
        modelRef: optionalStr(body.modelRef),
        systemPrompt: optionalStr(body.systemPrompt),
        scopedFileId: intParam(body.scopedFileId) || null,
        skillId: intParam(body.skillId) || null,
        useLibrary: boolOr(body.useLibrary, false),
        webSearch: boolOr(body.webSearch, false),
        toolsEnabled: boolOr(body.toolsEnabled, true),
        settingsJson: (body.settings as never) ?? null,
      })
      .returning();
    res.json({ conversation: row });
  }),
);

router.get(
  '/conversations/:id',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const [conversation] = await db
      .select()
      .from(conversationsTable)
      .where(
        and(eq(conversationsTable.userId, uid), eq(conversationsTable.id, id)),
      );
    if (!conversation) throw new Error('That conversation does not exist.');

    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, id))
      .orderBy(asc(messagesTable.id));

    const artifacts =
      messages.length > 0
        ? await db
            .select()
            .from(artifactsTable)
            .where(
              inArray(
                artifactsTable.messageId,
                messages.map((message) => message.id),
              ),
            )
        : [];

    const summaries = await listSummaries(id);

    res.json({
      conversation,
      // Embeddings are large and only used server-side.
      messages: messages.map(({ embedding: _embedding, ...rest }) => rest),
      artifacts,
      summaries,
    });
  }),
);

router.patch(
  '/conversations/:id',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const body = (req.body ?? {}) as Record<string, unknown>;

    const patch: Record<string, unknown> = {};
    if ('title' in body) patch.title = optionalStr(body.title);
    if ('folderId' in body) {
      patch.folderId = body.folderId === null ? null : intParam(body.folderId) || null;
    }
    if ('modelRef' in body) patch.modelRef = optionalStr(body.modelRef);
    if ('systemPrompt' in body) patch.systemPrompt = optionalStr(body.systemPrompt);
    if ('skillId' in body) {
      patch.skillId = body.skillId === null ? null : intParam(body.skillId) || null;
    }
    if ('scopedFileId' in body) {
      patch.scopedFileId =
        body.scopedFileId === null ? null : intParam(body.scopedFileId) || null;
    }
    if ('pinned' in body) patch.pinned = boolOr(body.pinned, false);
    if ('archived' in body) patch.archived = boolOr(body.archived, false);
    if ('useLibrary' in body) patch.useLibrary = boolOr(body.useLibrary, false);
    if ('webSearch' in body) patch.webSearch = boolOr(body.webSearch, false);
    if ('toolsEnabled' in body) {
      patch.toolsEnabled = boolOr(body.toolsEnabled, true);
    }
    if ('settings' in body) patch.settingsJson = body.settings ?? null;

    if (Object.keys(patch).length === 0) {
      throw new Error('Nothing to update.');
    }

    const [row] = await db
      .update(conversationsTable)
      .set(patch)
      .where(
        and(eq(conversationsTable.userId, uid), eq(conversationsTable.id, id)),
      )
      .returning();
    if (!row) throw new Error('That conversation does not exist.');
    res.json({ conversation: row });
  }),
);

router.delete(
  '/conversations/:id',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const deleted = await db
      .delete(conversationsTable)
      .where(
        and(eq(conversationsTable.userId, uid), eq(conversationsTable.id, id)),
      )
      .returning({ id: conversationsTable.id });
    res.json({ deleted: deleted.length > 0 });
  }),
);

/** Copy a thread up to a chosen message — "branch from here". */
router.post(
  '/conversations/:id/branch',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const fromMessageId = requireIntParam(req.body?.fromMessageId, 'fromMessageId');

    const [source] = await db
      .select()
      .from(conversationsTable)
      .where(
        and(eq(conversationsTable.userId, uid), eq(conversationsTable.id, id)),
      );
    if (!source) throw new Error('That conversation does not exist.');

    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, id))
      .orderBy(asc(messagesTable.id));
    const cutoff = messages.findIndex((message) => message.id === fromMessageId);
    if (cutoff === -1) throw new Error('That message is not in this conversation.');
    const kept = messages.slice(0, cutoff + 1);

    const [branch] = await db
      .insert(conversationsTable)
      .values({
        userId: uid,
        title: source.title ? `${source.title} (branch)` : null,
        folderId: source.folderId,
        modelRef: source.modelRef,
        systemPrompt: source.systemPrompt,
        settingsJson: source.settingsJson,
        scopedFileId: source.scopedFileId,
        skillId: source.skillId,
        useLibrary: source.useLibrary,
        webSearch: source.webSearch,
        toolsEnabled: source.toolsEnabled,
      })
      .returning();

    if (kept.length > 0) {
      await db.insert(messagesTable).values(
        kept.map((message) => ({
          conversationId: branch.id,
          role: message.role,
          content: message.content,
          reasoning: message.reasoning,
          attachmentsJson: message.attachmentsJson,
          toolCallsJson: message.toolCallsJson,
          citationsJson: message.citationsJson,
          modelRef: message.modelRef,
          tokenCounts: message.tokenCounts,
          latencyMs: message.latencyMs,
        })),
      );
    }
    res.json({ conversation: branch, copiedMessages: kept.length });
  }),
);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

router.patch(
  '/conversations/:id/messages/:messageId',
  handler(async (req, res) => {
    const uid = userId(req);
    const conversationId = requireIntParam(req.params.id, 'id');
    const messageId = requireIntParam(req.params.messageId, 'messageId');
    await assertOwnsConversation(uid, conversationId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if ('content' in body) patch.content = str(body.content);
    if ('rating' in body) {
      const rating = numberOr(body.rating, 0);
      patch.rating = rating === 0 ? null : rating > 0 ? 1 : -1;
    }
    if (Object.keys(patch).length === 0) throw new Error('Nothing to update.');

    const [row] = await db
      .update(messagesTable)
      .set(patch)
      .where(
        and(
          eq(messagesTable.id, messageId),
          eq(messagesTable.conversationId, conversationId),
        ),
      )
      .returning();
    if (!row) throw new Error('That message does not exist.');
    const { embedding: _embedding, ...rest } = row;
    res.json({ message: rest });
  }),
);

/** Delete a message and everything after it — used by edit-and-resend. */
router.delete(
  '/conversations/:id/messages/:messageId',
  handler(async (req, res) => {
    const uid = userId(req);
    const conversationId = requireIntParam(req.params.id, 'id');
    const messageId = requireIntParam(req.params.messageId, 'messageId');
    await assertOwnsConversation(uid, conversationId);
    const cascade = boolOr(req.query.cascade, false);

    if (!cascade) {
      const deleted = await db
        .delete(messagesTable)
        .where(
          and(
            eq(messagesTable.id, messageId),
            eq(messagesTable.conversationId, conversationId),
          ),
        )
        .returning({ id: messagesTable.id });
      res.json({ deleted: deleted.length });
      return;
    }

    const messages = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(asc(messagesTable.id));
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) throw new Error('That message does not exist.');
    const ids = messages.slice(index).map((message) => message.id);

    await db.delete(messagesTable).where(inArray(messagesTable.id, ids));
    res.json({ deleted: ids.length });
  }),
);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

router.get(
  '/conversations/:id/export',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const format = str(req.query.format, 'markdown');

    const [conversation] = await db
      .select()
      .from(conversationsTable)
      .where(
        and(eq(conversationsTable.userId, uid), eq(conversationsTable.id, id)),
      );
    if (!conversation) throw new Error('That conversation does not exist.');

    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, id))
      .orderBy(asc(messagesTable.id));

    const title = conversation.title ?? `conversation-${id}`;
    const safeName = title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || `conversation-${id}`;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeName}.json"`,
      );
      res.send(
        JSON.stringify(
          {
            conversation,
            messages: messages.map(({ embedding: _embedding, ...rest }) => rest),
          },
          null,
          2,
        ),
      );
      return;
    }

    const lines = [
      `# ${title}`,
      '',
      `- Model: ${conversation.modelRef ?? 'default'}`,
      `- Created: ${conversation.createdAt.toISOString()}`,
      `- Messages: ${messages.length}`,
      '',
      '---',
      '',
    ];
    for (const message of messages) {
      const label =
        message.role === 'user'
          ? 'You'
          : message.role === 'assistant'
            ? `Assistant${message.modelRef ? ` (${message.modelRef})` : ''}`
            : message.role;
      lines.push(`## ${label}`, '');
      if (message.content) lines.push(message.content, '');
      const calls = message.toolCallsJson as
        | Array<{ name: string; status: string; result?: string }>
        | null;
      if (calls?.length) {
        lines.push('<details><summary>Tool calls</summary>', '');
        for (const call of calls) {
          lines.push(`- \`${call.name}\` — ${call.status}`);
        }
        lines.push('', '</details>', '');
      }
      const citations = message.citationsJson as
        | Array<{ title: string; locator: string | null; url?: string }>
        | null;
      if (citations?.length) {
        lines.push('Sources:', '');
        citations.forEach((citation, index) => {
          const anchor = citation.locator ? ` — ${citation.locator}` : '';
          lines.push(
            `${index + 1}. ${citation.title}${anchor}${citation.url ? ` (${citation.url})` : ''}`,
          );
        });
        lines.push('');
      }
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
    res.send(lines.join('\n'));
  }),
);

export async function assertOwnsConversation(
  uid: string,
  conversationId: number,
): Promise<void> {
  const [row] = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.userId, uid),
        eq(conversationsTable.id, conversationId),
      ),
    );
  if (!row) throw new Error('That conversation does not exist.');
}

export default router;
