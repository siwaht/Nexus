import { Router, type IRouter } from 'express';

import {
  deleteFact,
  listFacts,
  recallRelated,
  updateFact,
  upsertFact,
  wipeMemory,
} from '../lib/memory';
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
 * Long-term memory: every remembered fact is listable, editable and deletable,
 * which is the point — memory the user can't inspect isn't trustworthy.
 */

const router: IRouter = Router();

router.use('/memory', requireAuth);

router.get(
  '/memory',
  handler(async (req, res) => {
    res.json({ facts: await listFacts(userId(req)) });
  }),
);

router.post(
  '/memory',
  handler(async (req, res) => {
    const text = str(req.body?.text).trim();
    if (text.length < 4) throw new Error('A memory needs some text.');
    const fact = await upsertFact(userId(req), {
      text,
      category: str(req.body?.category, 'fact'),
      confidence:
        req.body?.confidence === undefined
          ? null
          : numberOr(req.body.confidence, 1),
      pinned: boolOr(req.body?.pinned, false),
    });
    res.json({ fact });
  }),
);

router.patch(
  '/memory/:id',
  handler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fact = await updateFact(
      userId(req),
      requireIntParam(req.params.id, 'id'),
      {
        ...(typeof body.text === 'string' ? { text: body.text } : {}),
        ...(typeof body.category === 'string' ? { category: body.category } : {}),
        ...('pinned' in body ? { pinned: boolOr(body.pinned, false) } : {}),
      },
    );
    if (!fact) throw new Error('That memory does not exist.');
    res.json({ fact });
  }),
);

router.delete(
  '/memory/:id',
  handler(async (req, res) => {
    const deleted = await deleteFact(
      userId(req),
      requireIntParam(req.params.id, 'id'),
    );
    res.json({ deleted });
  }),
);

/** Wipe everything. Deliberately requires an explicit confirmation flag. */
router.post(
  '/memory/wipe',
  handler(async (req, res) => {
    if (!boolOr(req.body?.confirm, false)) {
      throw new Error(
        'Send { "confirm": true } to wipe all remembered facts. This cannot be undone.',
      );
    }
    const deleted = await wipeMemory(userId(req));
    res.json({ deleted });
  }),
);

router.get(
  '/memory/recall',
  handler(async (req, res) => {
    const query = str(req.query.query).trim();
    if (!query) throw new Error('A recall lookup needs a query.');
    const recalled = await recallRelated(userId(req), query, {
      conversationId: intParam(req.query.conversationId) || null,
      limit: Math.min(intParam(req.query.limit, 8) || 8, 25),
    });
    res.json({ recalled });
  }),
);

export default router;
