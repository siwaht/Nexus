import { Router, type IRouter } from 'express';

import {
  deleteSkill,
  generateSkill,
  getSkill,
  listSkills,
  saveSkill,
} from '../lib/skills';
import { rateLimit } from '../lib/rateLimit';
import { requireAuth } from '../middlewares/requireAuth';
import {
  boolOr,
  handler,
  numberOr,
  optionalStr,
  requireIntParam,
  str,
  stringArray,
  userId,
} from './helpers';

/**
 * Skills: reusable instruction blocks with their own tool allowlist.
 *
 * `POST /skills/generate` drafts one from a plain-language description, wired
 * only to tools that actually exist on this install.
 */

const router: IRouter = Router();

router.use('/skills', requireAuth);

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Skill generation is limited to a few times a minute.',
});

router.get(
  '/skills',
  handler(async (req, res) => {
    res.json({ skills: await listSkills(userId(req)) });
  }),
);

router.get(
  '/skills/:id',
  handler(async (req, res) => {
    const skill = await getSkill(userId(req), requireIntParam(req.params.id, 'id'));
    if (!skill) throw new Error('That skill does not exist.');
    res.json({ skill });
  }),
);

function parseSkillBody(body: Record<string, unknown>) {
  return {
    name: str(body.name),
    description: optionalStr(body.description),
    whenToUse: optionalStr(body.whenToUse),
    instructions: str(body.instructions),
    toolKeys: stringArray(body.toolKeys),
    mcpServers: stringArray(body.mcpServers),
    modelRef: optionalStr(body.modelRef),
    temperature:
      body.temperature === null || body.temperature === undefined
        ? null
        : numberOr(body.temperature, 0.7),
    enabled: boolOr(body.enabled, true),
    autoSelect: boolOr(body.autoSelect, true),
  };
}

router.post(
  '/skills',
  handler(async (req, res) => {
    const skill = await saveSkill(
      userId(req),
      parseSkillBody((req.body ?? {}) as Record<string, unknown>),
    );
    res.json({ skill });
  }),
);

router.put(
  '/skills/:id',
  handler(async (req, res) => {
    const skill = await saveSkill(
      userId(req),
      parseSkillBody((req.body ?? {}) as Record<string, unknown>),
      requireIntParam(req.params.id, 'id'),
    );
    res.json({ skill });
  }),
);

router.delete(
  '/skills/:id',
  handler(async (req, res) => {
    const deleted = await deleteSkill(
      userId(req),
      requireIntParam(req.params.id, 'id'),
    );
    res.json({ deleted });
  }),
);

router.post(
  '/skills/generate',
  generateLimiter,
  handler(async (req, res) => {
    const description = str(req.body?.description).trim();
    if (description.length < 10) {
      throw new Error('Describe the skill in a sentence or two so it can be drafted.');
    }
    const outcome = await generateSkill(userId(req), description, {
      modelRef: optionalStr(req.body?.modelRef),
      save: boolOr(req.body?.save, false),
    });
    res.json(outcome);
  }),
);

export default router;
