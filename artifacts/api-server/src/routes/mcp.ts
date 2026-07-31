import { Router, type IRouter } from 'express';

import {
  deleteServer,
  listServerTools,
  listServers,
  saveServer,
  setToolEnabled,
  stdioAvailable,
  stdioUnavailableReason,
  testAndDiscover,
  type McpTransportKind,
} from '../lib/mcp';
import { rateLimit } from '../lib/rateLimit';
import { invalidateToolCache } from '../lib/tools/registry';
import { requireAuth } from '../middlewares/requireAuth';
import {
  boolOr,
  handler,
  optionalStr,
  requireIntParam,
  str,
  stringArray,
  stringRecord,
  userId,
} from './helpers';

/**
 * MCP server management.
 *
 * Server rows never hold credentials — they hold a header/env name → vault
 * secret-name mapping, resolved server-side at connect time. Connection tests
 * are rate-limited because each one reaches an external host.
 */

const router: IRouter = Router();

router.use('/mcp', requireAuth);

const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  message: 'Too many MCP connection tests — wait a moment and retry.',
});

const TRANSPORTS: McpTransportKind[] = ['http', 'sse', 'stdio'];

function parseTransport(value: unknown): McpTransportKind {
  const transport = str(value, 'http') as McpTransportKind;
  if (!TRANSPORTS.includes(transport)) {
    throw new Error('transport must be one of: http, sse, stdio.');
  }
  return transport;
}

router.get(
  '/mcp/servers',
  handler(async (req, res) => {
    const uid = userId(req);
    const [servers, tools] = await Promise.all([
      listServers(uid),
      listServerTools(uid),
    ]);
    res.json({
      servers,
      tools,
      stdio: {
        available: stdioAvailable(),
        reason: stdioAvailable() ? null : stdioUnavailableReason(),
      },
    });
  }),
);

router.post(
  '/mcp/servers',
  handler(async (req, res) => {
    const uid = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const server = await saveServer(uid, {
      name: str(body.name),
      description: optionalStr(body.description),
      transport: parseTransport(body.transport),
      url: optionalStr(body.url),
      command: optionalStr(body.command),
      args: stringArray(body.args),
      headerSecrets: stringRecord(body.headerSecrets),
      envSecrets: stringRecord(body.envSecrets),
      staticHeaders: stringRecord(body.staticHeaders),
      enabled: boolOr(body.enabled, true),
    });
    invalidateToolCache(uid);
    res.json({ server });
  }),
);

router.put(
  '/mcp/servers/:id',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const server = await saveServer(
      uid,
      {
        name: str(body.name),
        description: optionalStr(body.description),
        transport: parseTransport(body.transport),
        url: optionalStr(body.url),
        command: optionalStr(body.command),
        args: stringArray(body.args),
        headerSecrets: stringRecord(body.headerSecrets),
        envSecrets: stringRecord(body.envSecrets),
        staticHeaders: stringRecord(body.staticHeaders),
        enabled: boolOr(body.enabled, true),
      },
      id,
    );
    invalidateToolCache(uid);
    res.json({ server });
  }),
);

router.delete(
  '/mcp/servers/:id',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const deleted = await deleteServer(uid, id);
    invalidateToolCache(uid);
    res.json({ deleted });
  }),
);

router.post(
  '/mcp/servers/:id/test',
  testLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    const outcome = await testAndDiscover(uid, id);
    invalidateToolCache(uid);
    req.log.info(
      { serverId: id, ok: outcome.ok, toolCount: outcome.toolCount },
      'MCP connection test',
    );
    res.json(outcome);
  }),
);

router.get(
  '/mcp/servers/:id/tools',
  handler(async (req, res) => {
    const uid = userId(req);
    const id = requireIntParam(req.params.id, 'id');
    res.json({ tools: await listServerTools(uid, id) });
  }),
);

router.patch(
  '/mcp/tools/:toolId',
  handler(async (req, res) => {
    const uid = userId(req);
    const toolId = requireIntParam(req.params.toolId, 'toolId');
    const enabled = boolOr(req.body?.enabled, true);
    const updated = await setToolEnabled(uid, toolId, enabled);
    invalidateToolCache(uid);
    if (!updated) throw new Error('That tool does not exist.');
    res.json({ toolId, enabled });
  }),
);

export default router;
