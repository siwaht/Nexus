import { db, skillsTable, type SkillRow } from '@workspace/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { completeJson, resolveModelForTask } from './ai';
import { toolCatalogue } from './tools/registry';

/**
 * Skills — named, reusable capabilities.
 *
 * A skill bundles an instruction block, an allowlist of tools it may use, and
 * optionally a model and temperature. Attaching one to a conversation layers
 * its instructions into the system prompt and narrows the tool set, so "review
 * a contract" or "audit a repo" becomes one click instead of a re-typed brief.
 *
 * Skills can be hand-written or generated: `generateSkill` asks a model to
 * draft one from a plain-language description, wiring in whichever tools are
 * actually available on this install rather than inventing names.
 */

export interface SkillView {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  whenToUse: string | null;
  instructions: string;
  toolKeys: string[];
  mcpServers: string[];
  modelRef: string | null;
  temperature: number | null;
  source: 'user' | 'generated';
  enabled: boolean;
  autoSelect: boolean;
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function slugify(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'skill'
  );
}

function toSkillView(row: SkillRow): SkillView {
  const temperature =
    row.temperature === null ? null : Number.parseFloat(row.temperature);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    whenToUse: row.whenToUse,
    instructions: row.instructions,
    toolKeys: (row.toolKeysJson as string[] | null) ?? [],
    mcpServers: (row.mcpServersJson as string[] | null) ?? [],
    modelRef: row.modelRef,
    temperature:
      temperature !== null && Number.isFinite(temperature) ? temperature : null,
    source: row.source === 'generated' ? 'generated' : 'user',
    enabled: row.enabled,
    autoSelect: row.autoSelect,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSkills(userId: string): Promise<SkillView[]> {
  const rows = await db
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.userId, userId))
    .orderBy(asc(skillsTable.name));
  return rows.map(toSkillView);
}

export async function getSkill(
  userId: string,
  id: number,
): Promise<SkillView | null> {
  const [row] = await db
    .select()
    .from(skillsTable)
    .where(and(eq(skillsTable.userId, userId), eq(skillsTable.id, id)));
  return row ? toSkillView(row) : null;
}

export interface SaveSkillInput {
  name: string;
  description?: string | null;
  whenToUse?: string | null;
  instructions: string;
  toolKeys?: string[];
  mcpServers?: string[];
  modelRef?: string | null;
  temperature?: number | null;
  enabled?: boolean;
  autoSelect?: boolean;
  source?: 'user' | 'generated';
}

export async function saveSkill(
  userId: string,
  input: SaveSkillInput,
  id?: number,
): Promise<SkillView> {
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new Error('A skill needs a name.');
  if (!input.instructions.trim()) {
    throw new Error('A skill needs instructions.');
  }

  const values = {
    userId,
    name,
    slug: slugify(name),
    description: input.description ?? null,
    whenToUse: input.whenToUse ?? null,
    instructions: input.instructions.trim().slice(0, 20_000),
    toolKeysJson: input.toolKeys ?? [],
    mcpServersJson: input.mcpServers ?? [],
    modelRef: input.modelRef ?? null,
    temperature:
      input.temperature === null || input.temperature === undefined
        ? null
        : String(input.temperature),
    enabled: input.enabled ?? true,
    autoSelect: input.autoSelect ?? true,
    source: input.source ?? 'user',
  };

  if (id !== undefined) {
    const [row] = await db
      .update(skillsTable)
      .set(values)
      .where(and(eq(skillsTable.userId, userId), eq(skillsTable.id, id)))
      .returning();
    if (!row) throw new Error('That skill does not exist.');
    return toSkillView(row);
  }

  const [row] = await db
    .insert(skillsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [skillsTable.userId, skillsTable.slug],
      set: values,
    })
    .returning();
  return toSkillView(row);
}

export async function deleteSkill(
  userId: string,
  id: number,
): Promise<boolean> {
  const deleted = await db
    .delete(skillsTable)
    .where(and(eq(skillsTable.userId, userId), eq(skillsTable.id, id)))
    .returning({ id: skillsTable.id });
  return deleted.length > 0;
}

export async function markSkillUsed(userId: string, id: number): Promise<void> {
  await db
    .update(skillsTable)
    .set({
      useCount: sql`${skillsTable.useCount} + 1`,
      lastUsedAt: new Date(),
    })
    .where(and(eq(skillsTable.userId, userId), eq(skillsTable.id, id)))
    .catch(() => undefined);
}

/** Build the system-prompt overlay a skill contributes. */
export function skillPromptBlock(skill: SkillView): string {
  return [
    `## Active skill: ${skill.name}`,
    skill.description ? skill.description : '',
    '',
    skill.instructions,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

interface GeneratedSkill {
  name?: string;
  description?: string;
  when_to_use?: string;
  instructions?: string;
  tool_keys?: string[];
}

/**
 * Draft a skill from a plain-language description.
 *
 * The model is shown the tools that actually exist on this install (built-ins
 * plus the user's MCP tools) and is told to pick from them, so a generated
 * skill can't reference a tool that isn't there.
 */
export async function generateSkill(
  userId: string,
  description: string,
  options: { modelRef?: string | null; save?: boolean } = {},
): Promise<{ draft: SaveSkillInput; saved: SkillView | null; unknownTools: string[] }> {
  const catalogue = await toolCatalogue(userId);
  const toolList = catalogue
    .filter((tool) => tool.available)
    .map(
      (tool) =>
        `- ${tool.key} (${tool.group}) — ${tool.title}: ${tool.description.slice(0, 160)}`,
    )
    .join('\n');

  const modelRef =
    options.modelRef ?? (await resolveModelForTask(userId, 'chat'));

  const generated = await completeJson<GeneratedSkill>(userId, {
    modelRef,
    temperature: 0.4,
    maxTokens: 2000,
    messages: [
      {
        role: 'system',
        content: [
          'You design skills for an AI workspace. A skill is a reusable instruction block plus the tools it needs.',
          '',
          'Write the instructions as a direct operating procedure addressed to the assistant:',
          'what to do, in what order, what to check, what the output should look like, and what to refuse or escalate.',
          'Be concrete and specific to the described job. No filler, no restating that you are an AI.',
          '',
          'Pick tool_keys only from this list — never invent one:',
          toolList || '(no tools are available on this install)',
          '',
          'Respond as JSON: {"name":"…","description":"one line","when_to_use":"one line","instructions":"…","tool_keys":["builtin:web_search"]}',
        ].join('\n'),
      },
      { role: 'user', content: description.slice(0, 4000) },
    ],
  });

  const validKeys = new Set(catalogue.map((tool) => tool.key));
  const requested = (generated.tool_keys ?? []).filter(
    (key): key is string => typeof key === 'string',
  );
  const toolKeys = requested.filter((key) => validKeys.has(key));
  const unknownTools = requested.filter((key) => !validKeys.has(key));

  const draft: SaveSkillInput = {
    name: (generated.name ?? description.slice(0, 60)).trim(),
    description: generated.description ?? null,
    whenToUse: generated.when_to_use ?? null,
    instructions:
      generated.instructions?.trim() ||
      `Follow this procedure: ${description.trim()}`,
    toolKeys,
    source: 'generated',
  };

  const saved = options.save ? await saveSkill(userId, draft) : null;
  return { draft, saved, unknownTools };
}

/**
 * Pick the skills worth attaching to a message. Cheap keyword scoring against
 * name/description/whenToUse — deliberately not a model call, because this
 * runs on every turn.
 */
export async function suggestSkills(
  userId: string,
  text: string,
  limit = 2,
): Promise<SkillView[]> {
  const skills = (await listSkills(userId)).filter(
    (skill) => skill.enabled && skill.autoSelect,
  );
  if (skills.length === 0) return [];

  const tokens = new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 3),
  );
  if (tokens.size === 0) return [];

  const scored = skills
    .map((skill) => {
      const haystack = [skill.name, skill.description, skill.whenToUse]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += 1;
      }
      return { skill, score };
    })
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((entry) => entry.skill);
}
