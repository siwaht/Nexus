import { db, fileChunksTable, filesTable } from '@workspace/db';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { Router, type IRouter } from 'express';
import multer from 'multer';

import { subscribe } from '../lib/events';
import {
  classifyFile,
  createFileRecord,
  ingestFile,
  isUploadAllowed,
  MAX_UPLOAD_BYTES,
  mediaToolsAvailable,
  reindexFile,
} from '../lib/ingest';
import { rateLimit } from '../lib/rateLimit';
import { retrieve } from '../lib/rag';
import { storage } from '../lib/storage';
import { requireAuth } from '../middlewares/requireAuth';
import {
  boolOr,
  handler,
  intParam,
  openSse,
  optionalStr,
  requireIntParam,
  str,
  userId,
} from './helpers';

/**
 * The Library: uploads, ingestion status, viewers and retrieval.
 *
 * Uploads are capped, MIME-allowlisted and stored under server-generated names.
 * Ingestion runs asynchronously — the route returns as soon as the row exists so
 * the UI never blocks on a long PDF or a video transcription.
 */

const router: IRouter = Router();

router.use('/files', requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many uploads in a short window — wait a moment and retry.',
});

router.get(
  '/files',
  handler(async (req, res) => {
    const uid = userId(req);
    const kind = optionalStr(req.query.kind);
    const search = optionalStr(req.query.search);

    const conditions = [eq(filesTable.userId, uid)];
    if (kind) conditions.push(eq(filesTable.kind, kind));
    if (search) {
      const pattern = `%${search}%`;
      const match = or(
        ilike(filesTable.filename, pattern),
        ilike(filesTable.extractedText, pattern),
      );
      if (match) conditions.push(match);
    }

    const rows = await db
      .select({
        id: filesTable.id,
        filename: filesTable.filename,
        mime: filesTable.mime,
        size: filesTable.size,
        kind: filesTable.kind,
        status: filesTable.status,
        progress: filesTable.progress,
        error: filesTable.error,
        pageCount: filesTable.pageCount,
        durationS: filesTable.durationS,
        tags: filesTable.tags,
        usedInChats: filesTable.usedInChats,
        metadataJson: filesTable.metadataJson,
        createdAt: filesTable.createdAt,
        updatedAt: filesTable.updatedAt,
      })
      .from(filesTable)
      .where(and(...conditions))
      .orderBy(desc(filesTable.createdAt));

    const tools = await mediaToolsAvailable();
    res.json({ files: rows, media: tools });
  }),
);

router.post(
  '/files',
  uploadLimiter,
  upload.array('files', 10),
  handler(async (req, res) => {
    const uid = userId(req);
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (uploaded.length === 0) throw new Error('No files were uploaded.');

    const accepted: Array<{ id: number; filename: string; kind: string }> = [];
    const rejected: Array<{ filename: string; reason: string }> = [];

    for (const file of uploaded) {
      // multer gives the browser-supplied name; treat it as untrusted.
      const originalName = file.originalname ?? 'upload';
      const check = isUploadAllowed(originalName, file.mimetype ?? '');
      if (!check.ok) {
        rejected.push({ filename: originalName, reason: check.reason });
        continue;
      }
      const fileId = await createFileRecord(uid, {
        filename: originalName,
        mime: file.mimetype ?? '',
        data: file.buffer,
      });
      accepted.push({
        id: fileId,
        filename: originalName,
        kind: classifyFile(originalName, file.mimetype ?? ''),
      });
      // Fire and forget: the client watches progress over SSE.
      void ingestFile(uid, fileId);
    }

    res.json({ accepted, rejected });
  }),
);

router.get(
  '/files/:id',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const [row] = await db
      .select()
      .from(filesTable)
      .where(and(eq(filesTable.userId, uid), eq(filesTable.id, id)));
    if (!row) throw new Error('That file does not exist.');

    const includeChunks = boolOr(req.query.chunks, false);
    const chunks = includeChunks
      ? await db
          .select({
            id: fileChunksTable.id,
            ordinal: fileChunksTable.ordinal,
            pageOrTimestamp: fileChunksTable.pageOrTimestamp,
            text: fileChunksTable.text,
          })
          .from(fileChunksTable)
          .where(eq(fileChunksTable.fileId, id))
          .orderBy(asc(fileChunksTable.ordinal))
      : [];

    const [counts] = await db
      .select({ chunkCount: sql<number>`count(*)::int` })
      .from(fileChunksTable)
      .where(eq(fileChunksTable.fileId, id));

    res.json({
      file: row,
      chunks,
      chunkCount: Number(counts?.chunkCount ?? 0),
    });
  }),
);

/** Stream the raw bytes back for the viewers (PDF, image, audio, video). */
router.get(
  '/files/:id/raw',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const [row] = await db
      .select()
      .from(filesTable)
      .where(and(eq(filesTable.userId, uid), eq(filesTable.id, id)));
    if (!row) throw new Error('That file does not exist.');

    const data = await storage.get(row.storageKey);
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('Content-Length', String(data.length));
    res.setHeader(
      'Content-Disposition',
      `${boolOr(req.query.download, false) ? 'attachment' : 'inline'}; filename="${row.filename.replace(/"/g, '')}"`,
    );
    // Served from our own origin; don't let a stored SVG or HTML run scripts.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }),
);

router.patch(
  '/files/:id',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if ('filename' in body) {
      const filename = str(body.filename).trim();
      if (!filename) throw new Error('A file needs a name.');
      patch.filename = filename.slice(0, 200);
    }
    if ('tags' in body) {
      patch.tags = Array.isArray(body.tags)
        ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 30)
        : [];
    }
    if (Object.keys(patch).length === 0) throw new Error('Nothing to update.');

    const [row] = await db
      .update(filesTable)
      .set(patch)
      .where(and(eq(filesTable.userId, uid), eq(filesTable.id, id)))
      .returning();
    if (!row) throw new Error('That file does not exist.');
    res.json({ file: row });
  }),
);

router.delete(
  '/files/:id',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const [row] = await db
      .select({ storageKey: filesTable.storageKey })
      .from(filesTable)
      .where(and(eq(filesTable.userId, uid), eq(filesTable.id, id)));
    if (!row) throw new Error('That file does not exist.');

    await db
      .delete(filesTable)
      .where(and(eq(filesTable.userId, uid), eq(filesTable.id, id)));
    await storage.delete(row.storageKey).catch(() => undefined);
    res.json({ deleted: true });
  }),
);

router.post(
  '/files/:id/reindex',
  uploadLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const [row] = await db
      .select({ id: filesTable.id })
      .from(filesTable)
      .where(and(eq(filesTable.userId, uid), eq(filesTable.id, id)));
    if (!row) throw new Error('That file does not exist.');
    void reindexFile(uid, id);
    res.json({ queued: true });
  }),
);

/** Live ingestion progress for one file. */
router.get(
  '/files/:id/events',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const [row] = await db
      .select({ status: filesTable.status, progress: filesTable.progress })
      .from(filesTable)
      .where(and(eq(filesTable.userId, uid), eq(filesTable.id, id)));
    if (!row) throw new Error('That file does not exist.');

    const sse = openSse(req, res);
    sse.send('status', { fileId: id, ...row });

    const subscription = subscribe(
      `file:${id}`,
      (event) => sse.send(event.type, event.data),
      { afterSeq: intParam(req.query.afterSeq) },
    );
    for (const event of subscription.replay) sse.send(event.type, event.data);
    sse.signal.addEventListener('abort', () => {
      subscription.unsubscribe();
      sse.close();
    });
  }),
);

/** Retrieval endpoint for the sources panel and manual library search. */
router.post(
  '/files/search',
  handler(async (req, res) => {
    const uid = userId(req);
    const query = str(req.body?.query).trim();
    if (!query) throw new Error('A search needs a query.');
    const rawIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : null;
    const fileIds = rawIds
      ? rawIds.map((id: unknown) => intParam(id)).filter((id: number) => id > 0)
      : null;

    const outcome = await retrieve(uid, query, {
      fileIds,
      final: Math.min(intParam(req.body?.limit, 5) || 5, 20),
    });
    res.json(outcome);
  }),
);

export default router;
