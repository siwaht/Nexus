import { Router, type IRouter } from 'express';

import { browserCapabilities } from '../lib/browser';
import {
  listAudit,
  listPermissions,
  setPermission,
  type PermissionMode,
} from '../lib/permissions';
import { invalidateToolCache, toolCatalogue } from '../lib/tools/registry';
import { requireAuth } from '../middlewares/requireAuth';
import { handler, intParam, str, userId } from './helpers';

/**
 * Tools and permissions.
 *
 * The catalogue is the source of truth for the Settings → Tools screen: what
 * exists, whether its prerequisites are met, and the current allow/ask/deny.
 * The audit endpoint backs the activity log.
 */

const router: IRouter = Router();

router.use('/tools', requireAuth);

router.get(
  '/tools',
  handler(async (req, res) => {
    const uid = userId(req);
    const [catalogue, permissions] = await Promise.all([
      toolCatalogue(uid),
      listPermissions(uid),
    ]);
    res.json({
      tools: catalogue,
      permissions,
      browser: browserCapabilities(),
    });
  }),
);

router.put(
  '/tools/permissions',
  handler(async (req, res) => {
    const uid = userId(req);
    const toolKey = str(req.body?.toolKey);
    const mode = str(req.body?.mode) as PermissionMode;
    if (!toolKey) throw new Error('toolKey is required.');
    if (!['ask', 'allow', 'deny'].includes(mode)) {
      throw new Error('mode must be one of: ask, allow, deny.');
    }
    const record = await setPermission(
      uid,
      toolKey,
      mode,
      (req.body?.constraints as Record<string, unknown> | undefined) ?? null,
    );
    invalidateToolCache(uid);
    res.json({ permission: record });
  }),
);

/** Bulk set — used by the "allow all read-only" style shortcuts. */
router.put(
  '/tools/permissions/bulk',
  handler(async (req, res) => {
    const uid = userId(req);
    const entries = Array.isArray(req.body?.permissions)
      ? req.body.permissions
      : [];
    const saved = [];
    for (const entry of entries) {
      const record = entry as Record<string, unknown>;
      const toolKey = str(record.toolKey);
      const mode = str(record.mode) as PermissionMode;
      if (!toolKey || !['ask', 'allow', 'deny'].includes(mode)) continue;
      saved.push(await setPermission(uid, toolKey, mode));
    }
    invalidateToolCache(uid);
    res.json({ permissions: saved });
  }),
);

router.get(
  '/tools/audit',
  handler(async (req, res) => {
    const uid = userId(req);
    const entries = await listAudit(uid, intParam(req.query.limit, 100));
    res.json({ entries });
  }),
);

export default router;
