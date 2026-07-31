import { Router, type IRouter } from 'express';

import {
  deleteSecret,
  listSecrets,
  normalizeSecretName,
  upsertSecret,
} from '../lib/secrets';
import { requireAuth } from '../middlewares/requireAuth';
import { handler, optionalStr, str, userId } from './helpers';

/**
 * The API key vault.
 *
 * Write-only over the API: a stored value can be replaced but never read back.
 * Responses carry only `maskedPreview`. Used by MCP servers (header/env
 * mappings) and by tools that need a third-party key, e.g. web search.
 */

const router: IRouter = Router();

router.use('/secrets', requireAuth);

/** Names the built-in tools look for, surfaced so the UI can suggest them. */
const KNOWN_SECRETS = [
  {
    name: 'BRAVE_API_KEY',
    label: 'Brave Search',
    description: 'Enables higher-quality web search than the keyless fallback.',
    docsUrl: 'https://brave.com/search/api/',
  },
  {
    name: 'TAVILY_API_KEY',
    label: 'Tavily',
    description: 'Search API tuned for AI agents.',
    docsUrl: 'https://tavily.com/',
  },
  {
    name: 'SERPER_API_KEY',
    label: 'Serper',
    description: 'Google results via a simple REST API.',
    docsUrl: 'https://serper.dev/',
  },
];

router.get(
  '/secrets',
  handler(async (req, res) => {
    const secrets = await listSecrets(userId(req));
    res.json({ secrets, known: KNOWN_SECRETS });
  }),
);

router.put(
  '/secrets',
  handler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name);
    const value = str(body.value);
    if (!name) throw new Error('A secret needs a name.');
    if (!value) throw new Error('A secret needs a value.');

    const secret = await upsertSecret(userId(req), {
      name,
      value,
      label: optionalStr(body.label),
      description: optionalStr(body.description),
      scope: str(body.scope, 'tool'),
    });
    // Never log or echo the value — only the masked preview leaves the server.
    req.log.info({ secret: secret.name }, 'Secret saved');
    res.json({ secret });
  }),
);

router.delete(
  '/secrets/:name',
  handler(async (req, res) => {
    const name = normalizeSecretName(str(req.params.name));
    const deleted = await deleteSecret(userId(req), name);
    res.json({ deleted });
  }),
);

export default router;
