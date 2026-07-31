import { db, messagesTable } from '@workspace/db';
import { asc, eq } from 'drizzle-orm';
import { Router, type IRouter } from 'express';

import { contextUsage, resumeTurn, sendMessage } from '../lib/chatEngine';
import { cancel, registerCancellable } from '../lib/events';
import { rateLimit } from '../lib/rateLimit';
import { requireAuth } from '../middlewares/requireAuth';
import { assertOwnsConversation } from './conversations';
import {
  boolOr,
  handler,
  intParam,
  numberOr,
  openSse,
  optionalStr,
  requireIntParam,
  str,
  userId,
} from './helpers';

/**
 * Streaming chat.
 *
 * Token-by-token output over SSE. Rate-limited per session because each call
 * costs the user money upstream. A stop request aborts the in-flight generation
 * through the same cancellation registry the agent runs use.
 */

const router: IRouter = Router();

router.use('/chat', requireAuth);

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  message: 'Too many messages in a short window — wait a moment and retry.',
});

interface AttachmentInput {
  imageUrl?: string;
  text?: string;
  fileId?: number;
}

function parseAttachments(value: unknown): AttachmentInput[] {
  if (!Array.isArray(value)) return [];
  const out: AttachmentInput[] = [];
  for (const entry of value.slice(0, 12)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const attachment: AttachmentInput = {};
    if (typeof record.imageUrl === 'string') {
      // Only inline data URLs and https images are accepted, so a crafted
      // attachment can't make the server fetch an internal address.
      if (/^data:image\/(png|jpe?g|webp|gif);base64,/.test(record.imageUrl)) {
        attachment.imageUrl = record.imageUrl;
      } else if (/^https:\/\//.test(record.imageUrl)) {
        attachment.imageUrl = record.imageUrl;
      }
    }
    if (typeof record.text === 'string') attachment.text = record.text.slice(0, 100_000);
    if (typeof record.fileId === 'number') attachment.fileId = record.fileId;
    if (attachment.imageUrl || attachment.text || attachment.fileId) {
      out.push(attachment);
    }
  }
  return out;
}

router.post(
  '/chat/:conversationId/stream',
  chatLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const conversationId = requireIntParam(req.params.conversationId, 'conversationId');
    await assertOwnsConversation(uid, conversationId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const content = str(body.content).trim();
    const attachments = parseAttachments(body.attachments);
    const existingUserMessageId = intParam(body.existingUserMessageId) || null;

    if (!content && attachments.length === 0 && !existingUserMessageId) {
      throw new Error('A message needs text or an attachment.');
    }

    const sse = openSse(req, res);
    const cancelKey = `chat:${uid}:${conversationId}`;
    const controller = registerCancellable(cancelKey);
    const signal = AbortSignal.any([sse.signal, controller.signal]);

    try {
      for await (const event of sendMessage(uid, {
        conversationId,
        content,
        attachments,
        modelRefOverride: optionalStr(body.modelRef),
        temperature:
          body.temperature === undefined
            ? undefined
            : numberOr(body.temperature, 0.7),
        maxTokens:
          body.maxTokens === undefined ? undefined : numberOr(body.maxTokens, 2000),
        topP: body.topP === undefined ? undefined : numberOr(body.topP, 1),
        skillId: intParam(body.skillId) || null,
        useLibrary:
          body.useLibrary === undefined ? undefined : boolOr(body.useLibrary, false),
        webSearch:
          body.webSearch === undefined ? undefined : boolOr(body.webSearch, false),
        toolsEnabled:
          body.toolsEnabled === undefined
            ? undefined
            : boolOr(body.toolsEnabled, true),
        existingUserMessageId,
        signal,
      })) {
        if (sse.closed) break;
        sse.send(event.type, event);
      }
    } finally {
      sse.close();
    }
  }),
);

router.post(
  '/chat/:conversationId/resume',
  chatLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const conversationId = requireIntParam(req.params.conversationId, 'conversationId');
    await assertOwnsConversation(uid, conversationId);

    const messageId = requireIntParam(req.body?.messageId, 'messageId');
    const rawApprovals = (req.body?.approvals ?? {}) as Record<string, unknown>;
    const approvals: Record<string, boolean> = {};
    for (const [callId, value] of Object.entries(rawApprovals)) {
      approvals[callId] = value === true;
    }

    const sse = openSse(req, res);
    try {
      for await (const event of resumeTurn(uid, {
        conversationId,
        messageId,
        approvals,
        signal: sse.signal,
      })) {
        if (sse.closed) break;
        sse.send(event.type, event);
      }
    } finally {
      sse.close();
    }
  }),
);

router.post(
  '/chat/:conversationId/stop',
  handler(async (req, res) => {
    const uid = userId(req);
    const conversationId = requireIntParam(req.params.conversationId, 'conversationId');
    const stopped = cancel(`chat:${uid}:${conversationId}`);
    res.json({ stopped });
  }),
);

/**
 * Regenerate the last assistant turn: drop it and everything after, then
 * re-run from the preceding user message.
 */
router.post(
  '/chat/:conversationId/regenerate',
  chatLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const conversationId = requireIntParam(req.params.conversationId, 'conversationId');
    await assertOwnsConversation(uid, conversationId);

    const messages = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(asc(messagesTable.id));

    const fromMessageId = intParam(req.body?.fromMessageId) || null;
    const targetIndex = fromMessageId
      ? messages.findIndex((message) => message.id === fromMessageId)
      : messages.map((message) => message.role).lastIndexOf('assistant');
    if (targetIndex <= 0) {
      throw new Error('There is no assistant message to regenerate.');
    }

    // Walk back to the user turn that prompted it.
    let userIndex = targetIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== 'user') userIndex -= 1;
    if (userIndex < 0) throw new Error('No user message precedes that turn.');
    const userMessage = messages[userIndex];

    for (const message of messages.slice(targetIndex)) {
      await db.delete(messagesTable).where(eq(messagesTable.id, message.id));
    }

    const attachments =
      (userMessage.attachmentsJson as AttachmentInput[] | null) ?? [];
    const sse = openSse(req, res);
    const cancelKey = `chat:${uid}:${conversationId}`;
    const controller = registerCancellable(cancelKey);
    const signal = AbortSignal.any([sse.signal, controller.signal]);

    try {
      for await (const event of sendMessage(uid, {
        conversationId,
        content: userMessage.content,
        attachments,
        modelRefOverride: optionalStr(req.body?.modelRef),
        temperature:
          req.body?.temperature === undefined
            ? undefined
            : numberOr(req.body.temperature, 0.7),
        existingUserMessageId: userMessage.id,
        signal,
      })) {
        if (sse.closed) break;
        sse.send(event.type, event);
      }
    } finally {
      sse.close();
    }
  }),
);

router.get(
  '/chat/:conversationId/context',
  handler(async (req, res) => {
    const uid = userId(req);
    const conversationId = requireIntParam(req.params.conversationId, 'conversationId');
    await assertOwnsConversation(uid, conversationId);
    const modelRef = str(req.query.modelRef);
    if (!modelRef) throw new Error('modelRef is required.');
    res.json(await contextUsage(uid, conversationId, modelRef));
  }),
);

export default router;
