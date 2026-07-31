import { Router, type IRouter } from 'express';

import {
  browserCapabilities,
  captureScreenshot,
  closeSession,
  listSessions,
  readPage,
  runBrowserAction,
  type BrowserAction,
} from '../lib/browser';
import { searchWeb } from '../lib/browser/search';
import { rateLimit } from '../lib/rateLimit';
import { storage } from '../lib/storage';
import { requireAuth } from '../middlewares/requireAuth';
import {
  boolOr,
  handler,
  intParam,
  numberOr,
  str,
  userId,
} from './helpers';

/**
 * Browser control and web access, exposed directly so the user can drive a
 * page themselves from the Browser panel rather than only through the model.
 *
 * Every URL passes the same SSRF guard the tools use, and every response says
 * which driver served it so nothing implies interaction that didn't happen.
 */

const router: IRouter = Router();

router.use('/browser', requireAuth);
router.use('/web', requireAuth);

const webLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many web requests in a short window.',
});

router.get(
  '/browser/capabilities',
  handler(async (req, res) => {
    res.json({
      ...browserCapabilities(),
      sessions: listSessions(userId(req)),
    });
  }),
);

router.post(
  '/browser/act',
  webLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = str(body.action, 'snapshot');

    let action: BrowserAction;
    switch (kind) {
      case 'navigate':
        action = { kind: 'navigate', url: str(body.url) };
        if (!action.url) throw new Error('navigate needs a url.');
        break;
      case 'click':
        action = { kind: 'click', selector: str(body.selector) };
        if (!action.selector) throw new Error('click needs a selector.');
        break;
      case 'type':
        action = {
          kind: 'type',
          selector: str(body.selector),
          text: str(body.text),
          submit: boolOr(body.submit, false),
        };
        if (!action.selector) throw new Error('type needs a selector.');
        break;
      case 'scroll':
        action = { kind: 'scroll', deltaY: numberOr(body.deltaY, 600) };
        break;
      case 'press':
        action = { kind: 'press', key: str(body.key, 'Enter') };
        break;
      case 'evaluate':
        action = { kind: 'evaluate', expression: str(body.expression) };
        if (!action.expression) throw new Error('evaluate needs an expression.');
        break;
      default:
        action = { kind: 'snapshot' };
    }

    const result = await runBrowserAction(uid, action, {
      sessionId: str(body.sessionId, 'default'),
      screenshot: boolOr(body.screenshot, true),
    });
    res.json(result);
  }),
);

router.post(
  '/browser/screenshot',
  webLimiter,
  handler(async (req, res) => {
    const key = await captureScreenshot(userId(req), {
      sessionId: str(req.body?.sessionId, 'default'),
      fullPage: boolOr(req.body?.fullPage, false),
    });
    res.json({ storageKey: key });
  }),
);

/** Serve a stored screenshot back to the panel. */
router.get(
  '/browser/screenshot/:key',
  handler(async (req, res) => {
    // Keys are server-generated; `storage.get` rejects anything else.
    const key = `screenshots/${str(req.params.key)}`;
    const data = await storage.get(key);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }),
);

router.delete(
  '/browser/session',
  handler(async (req, res) => {
    await closeSession(userId(req), str(req.query.sessionId, 'default'));
    res.json({ closed: true });
  }),
);

router.post(
  '/web/read',
  webLimiter,
  handler(async (req, res) => {
    const url = str(req.body?.url);
    if (!url) throw new Error('A url is required.');
    const page = await readPage(userId(req), url, {
      refresh: boolOr(req.body?.refresh, false),
      render: boolOr(req.body?.render, true),
    });
    res.json({ page });
  }),
);

router.post(
  '/web/search',
  webLimiter,
  handler(async (req, res) => {
    const query = str(req.body?.query).trim();
    if (!query) throw new Error('A query is required.');
    const outcome = await searchWeb(
      userId(req),
      query,
      intParam(req.body?.limit, 8) || 8,
    );
    res.json(outcome);
  }),
);

export default router;
