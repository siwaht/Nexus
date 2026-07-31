import {
  agentRunsTable,
  agentTasksTable,
  db,
  type AgentRunRow,
  type AgentTaskRow,
} from '@workspace/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  completeJson,
  getUserSettings,
  resolveModelForTask,
} from '../ai';
import {
  cancel,
  closeChannel,
  isCancelled,
  publish,
  registerCancellable,
  releaseCancellable,
  runChannel,
} from '../events';
import type { ArtifactDraft, Citation, ToolContext } from '../tools/types';
import { runAgentLoop } from './loop';

/**
 * Multi-agent orchestration.
 *
 * A run takes one goal, asks a planner model to split it into a task tree with
 * explicit dependencies, then dispatches workers — several at once where the
 * plan says tasks are independent. Every piece of state lives in Postgres
 * (`agent_runs`, `agent_tasks`), so a run survives a process restart and the
 * to-do list is a real, editable object rather than a transcript artefact.
 *
 * The user can add tasks, retry a failure, skip, reorder, undo a completed
 * task, or cancel the whole run at any point.
 */

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'undone';

export type RunStatus =
  | 'planning'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface TaskView {
  id: number;
  runId: number;
  parentTaskId: number | null;
  ordinal: number;
  title: string;
  description: string | null;
  agentRole: string;
  status: TaskStatus;
  dependsOn: number[];
  result: string | null;
  error: string | null;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface RunView {
  id: number;
  conversationId: number | null;
  goal: string;
  status: RunStatus;
  plannerModelRef: string | null;
  workerModelRef: string | null;
  maxParallel: number;
  maxSteps: number;
  stepsUsed: number;
  resultSummary: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  tasks: TaskView[];
}

function toTaskView(row: AgentTaskRow): TaskView {
  return {
    id: row.id,
    runId: row.runId,
    parentTaskId: row.parentTaskId,
    ordinal: row.ordinal,
    title: row.title,
    description: row.description,
    agentRole: row.agentRole,
    status: row.status as TaskStatus,
    dependsOn: (row.dependsOnJson as number[] | null) ?? [],
    result: row.result,
    error: row.error,
    attempts: row.attempts,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function toRunView(row: AgentRunRow, tasks: AgentTaskRow[]): RunView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    goal: row.goal,
    status: row.status as RunStatus,
    plannerModelRef: row.plannerModelRef,
    workerModelRef: row.workerModelRef,
    maxParallel: row.maxParallel,
    maxSteps: row.maxSteps,
    stepsUsed: row.stepsUsed,
    resultSummary: row.resultSummary,
    error: row.error,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    tasks: tasks.map(toTaskView),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRuns(
  userId: string,
  limit = 30,
): Promise<RunView[]> {
  const runs = await db
    .select()
    .from(agentRunsTable)
    .where(eq(agentRunsTable.userId, userId))
    .orderBy(asc(agentRunsTable.id))
    .limit(Math.min(limit, 100));
  if (runs.length === 0) return [];

  const tasks = await db
    .select()
    .from(agentTasksTable)
    .where(
      inArray(
        agentTasksTable.runId,
        runs.map((run) => run.id),
      ),
    )
    .orderBy(asc(agentTasksTable.ordinal));

  const byRun = new Map<number, AgentTaskRow[]>();
  for (const task of tasks) {
    const list = byRun.get(task.runId) ?? [];
    list.push(task);
    byRun.set(task.runId, list);
  }
  return runs
    .map((run) => toRunView(run, byRun.get(run.id) ?? []))
    .reverse();
}

export async function getRun(
  userId: string,
  runId: number,
): Promise<RunView | null> {
  const [run] = await db
    .select()
    .from(agentRunsTable)
    .where(and(eq(agentRunsTable.userId, userId), eq(agentRunsTable.id, runId)));
  if (!run) return null;
  const tasks = await db
    .select()
    .from(agentTasksTable)
    .where(eq(agentTasksTable.runId, runId))
    .orderBy(asc(agentTasksTable.ordinal));
  return toRunView(run, tasks);
}

export async function listTasks(
  userId: string,
  runId: number,
): Promise<TaskView[]> {
  const rows = await db
    .select()
    .from(agentTasksTable)
    .where(
      and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.runId, runId)),
    )
    .orderBy(asc(agentTasksTable.ordinal));
  return rows.map(toTaskView);
}

// ---------------------------------------------------------------------------
// To-do mutations
// ---------------------------------------------------------------------------

export async function addTasks(
  userId: string,
  runId: number,
  tasks: Array<{
    title: string;
    description?: string | null;
    agentRole?: string;
    dependsOn?: number[];
  }>,
): Promise<TaskView[]> {
  if (tasks.length === 0) return [];
  const existing = await listTasks(userId, runId);
  const base = existing.reduce((max, task) => Math.max(max, task.ordinal), -1);

  const inserted = await db
    .insert(agentTasksTable)
    .values(
      tasks.map((task, index) => ({
        runId,
        userId,
        ordinal: base + 1 + index,
        title: task.title.slice(0, 200),
        description: task.description ?? null,
        agentRole: task.agentRole ?? 'worker',
        dependsOnJson: task.dependsOn ?? [],
        status: 'pending' as const,
      })),
    )
    .returning();

  publish(runChannel(runId), 'tasks-added', {
    tasks: inserted.map(toTaskView),
  });
  return inserted.map(toTaskView);
}

export async function setTaskStatus(
  userId: string,
  taskId: number,
  status: TaskStatus,
  result?: string | null,
): Promise<TaskView | null> {
  const patch: Partial<AgentTaskRow> = { status };
  if (result !== undefined && result !== null) {
    if (status === 'failed') patch.error = result.slice(0, 4000);
    else patch.result = result.slice(0, 20_000);
  }
  if (status === 'running') patch.startedAt = new Date();
  if (['done', 'failed', 'skipped', 'cancelled'].includes(status)) {
    patch.completedAt = new Date();
  }

  const [row] = await db
    .update(agentTasksTable)
    .set(patch)
    .where(
      and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.id, taskId)),
    )
    .returning();
  if (!row) return null;
  publish(runChannel(row.runId), 'task-updated', { task: toTaskView(row) });
  return toTaskView(row);
}

/**
 * Undo a completed task: clear its result and put it back to pending, along
 * with anything downstream that consumed it, so a re-run recomputes cleanly.
 */
export async function undoTask(
  userId: string,
  taskId: number,
): Promise<TaskView[]> {
  const [task] = await db
    .select()
    .from(agentTasksTable)
    .where(
      and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.id, taskId)),
    );
  if (!task) return [];

  const siblings = await listTasks(userId, task.runId);
  // Anything that depends on this task, transitively, is also invalidated.
  const invalidated = new Set<number>([taskId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of siblings) {
      if (invalidated.has(candidate.id)) continue;
      if (candidate.dependsOn.some((id) => invalidated.has(id))) {
        invalidated.add(candidate.id);
        grew = true;
      }
    }
  }

  const updated = await db
    .update(agentTasksTable)
    .set({
      status: 'pending',
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      undoSnapshotJson: {
        undoneAt: new Date().toISOString(),
        previousStatus: task.status,
        previousResult: task.result,
      },
    })
    .where(
      and(
        eq(agentTasksTable.userId, userId),
        inArray(agentTasksTable.id, [...invalidated]),
      ),
    )
    .returning();

  publish(runChannel(task.runId), 'tasks-undone', {
    tasks: updated.map(toTaskView),
  });
  return updated.map(toTaskView);
}

export async function reorderTasks(
  userId: string,
  runId: number,
  orderedIds: number[],
): Promise<TaskView[]> {
  for (let index = 0; index < orderedIds.length; index += 1) {
    await db
      .update(agentTasksTable)
      .set({ ordinal: index })
      .where(
        and(
          eq(agentTasksTable.userId, userId),
          eq(agentTasksTable.runId, runId),
          eq(agentTasksTable.id, orderedIds[index]),
        ),
      );
  }
  const tasks = await listTasks(userId, runId);
  publish(runChannel(runId), 'tasks-reordered', { tasks });
  return tasks;
}

export async function deleteTask(
  userId: string,
  taskId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(agentTasksTable)
    .where(
      and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.id, taskId)),
    )
    .returning({ id: agentTasksTable.id, runId: agentTasksTable.runId });
  if (deleted.length === 0) return false;
  publish(runChannel(deleted[0].runId), 'task-deleted', { taskId });
  return true;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface PlannedTask {
  title?: string;
  description?: string;
  role?: string;
  depends_on?: number[];
}

const PLANNER_SYSTEM = [
  'You are a planner. Split the goal into the smallest set of concrete tasks that fully achieves it.',
  '',
  'Rules:',
  '- Between 2 and 10 tasks. Fewer is better. Do not pad the plan.',
  '- Each task must be independently executable by an agent that only has the task text plus the results of its dependencies.',
  '- Use "depends_on" with the 1-based indexes of tasks that must finish first. Leave it empty when a task can start immediately — independent tasks run in parallel, so this matters.',
  '- Pick a role per task: researcher (find information), analyst (compute, compare, evaluate), writer (produce prose or documents), reviewer (check the work).',
  '- The final task should assemble the answer, and should depend on the others.',
  '- If the goal is genuinely a single step, return exactly one task.',
  '',
  'Respond as JSON: {"tasks":[{"title":"…","description":"…","role":"researcher","depends_on":[1,2]}]}',
].join('\n');

export async function planRun(
  userId: string,
  runId: number,
): Promise<TaskView[]> {
  const run = await getRun(userId, runId);
  if (!run) throw new Error('That run does not exist.');

  const plannerModel =
    run.plannerModelRef ?? (await resolveModelForTask(userId, 'chat'));

  publish(runChannel(runId), 'planning', { goal: run.goal });

  let planned: { tasks?: PlannedTask[] };
  try {
    planned = await completeJson<{ tasks?: PlannedTask[] }>(userId, {
      modelRef: plannerModel,
      temperature: 0.2,
      maxTokens: 1600,
      messages: [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: run.goal },
      ],
    });
  } catch {
    // A planner failure shouldn't kill the run — fall back to one task.
    planned = { tasks: [{ title: run.goal.slice(0, 200), role: 'worker' }] };
  }

  const raw = (planned.tasks ?? []).filter(
    (task) => typeof task.title === 'string' && task.title.trim().length > 0,
  );
  const list = raw.length > 0 ? raw.slice(0, 10) : [{ title: run.goal.slice(0, 200) }];

  const inserted = await db
    .insert(agentTasksTable)
    .values(
      list.map((task, index) => ({
        runId,
        userId,
        ordinal: index,
        title: task.title!.trim().slice(0, 200),
        description: task.description?.slice(0, 4000) ?? null,
        agentRole: task.role ?? 'worker',
        // Store dependencies as ordinals; they're resolved to ids below.
        dependsOnJson: (task.depends_on ?? [])
          .map((oneBased) => Number(oneBased) - 1)
          .filter((ordinal) => ordinal >= 0 && ordinal < list.length),
        status: 'pending' as const,
      })),
    )
    .returning();

  // Rewrite ordinal dependencies into real task ids.
  const idByOrdinal = new Map(inserted.map((row) => [row.ordinal, row.id]));
  for (const row of inserted) {
    const ordinals = (row.dependsOnJson as number[] | null) ?? [];
    const ids = ordinals
      .map((ordinal) => idByOrdinal.get(ordinal))
      .filter((id): id is number => typeof id === 'number' && id !== row.id);
    if (ids.length > 0) {
      await db
        .update(agentTasksTable)
        .set({ dependsOnJson: ids })
        .where(eq(agentTasksTable.id, row.id));
    }
  }

  const tasks = await listTasks(userId, runId);
  publish(runChannel(runId), 'planned', { tasks });
  return tasks;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const ROLE_GUIDANCE: Record<string, string> = {
  researcher:
    'You gather information. Prefer primary sources, search the web and the library, and report findings with citations. Do not speculate — say what you could not find.',
  analyst:
    'You analyse. Compare options, do the arithmetic, quantify tradeoffs, and state your assumptions explicitly.',
  writer:
    'You write the deliverable. Match the requested format exactly. Use create_document for anything long.',
  reviewer:
    'You check work. Look for factual errors, unsupported claims, missing requirements and internal contradictions. Be specific about what is wrong and how to fix it.',
  worker: 'You complete the task pragmatically and report exactly what you did.',
};

function workerPrompt(
  role: string,
  goal: string,
  task: TaskView,
  dependencyResults: Array<{ title: string; result: string }>,
): string {
  const parts = [
    `You are a ${role} agent working on one task inside a larger job.`,
    ROLE_GUIDANCE[role] ?? ROLE_GUIDANCE.worker,
    '',
    `Overall goal: ${goal}`,
    '',
    `Your task: ${task.title}`,
    task.description ? `Details: ${task.description}` : '',
    '',
    'Use the tools you have when they help. When you are done, reply with the finished result for this task only — no preamble, no restating the instructions. If you could not complete it, say plainly what blocked you.',
  ];
  if (dependencyResults.length > 0) {
    parts.push(
      '',
      'Results from the tasks yours depends on:',
      ...dependencyResults.map(
        (dep) => `--- ${dep.title} ---\n${dep.result.slice(0, 6000)}`,
      ),
    );
  }
  return parts.filter(Boolean).join('\n');
}

async function executeTask(
  userId: string,
  run: RunView,
  task: TaskView,
  allTasks: TaskView[],
): Promise<TaskView> {
  const channel = runChannel(run.id);
  await setTaskStatus(userId, task.id, 'running');
  publish(channel, 'task-started', { taskId: task.id, title: task.title });

  const dependencyResults = task.dependsOn
    .map((id) => allTasks.find((candidate) => candidate.id === id))
    .filter((dep): dep is TaskView => Boolean(dep?.result))
    .map((dep) => ({ title: dep.title, result: dep.result! }));

  const workerModel =
    run.workerModelRef ?? (await resolveModelForTask(userId, 'chat'));

  const context: Omit<ToolContext, 'userId' | 'emit' | 'signal'> = {
    conversationId: run.conversationId,
    agentRunId: run.id,
    agentTaskId: task.id,
  };

  const outcome = await runAgentLoop({
    userId,
    modelRef: workerModel,
    systemPrompt: workerPrompt(
      task.agentRole,
      run.goal,
      task,
      dependencyResults,
    ),
    messages: [{ role: 'user', content: task.title }],
    toolKeys: (run as unknown as { toolKeys?: string[] }).toolKeys ?? null,
    maxSteps: Math.max(4, Math.floor(run.maxSteps / Math.max(allTasks.length, 1))),
    context,
    signal: undefined,
    emit: (event) =>
      publish(channel, 'tool', { taskId: task.id, ...event }),
    onStep: (step) =>
      publish(channel, 'task-progress', {
        taskId: task.id,
        step: step.index,
        toolNames: step.toolNames,
        preview: step.text.slice(0, 400),
      }),
  });

  if (outcome.error) {
    const failed = await setTaskStatus(userId, task.id, 'failed', outcome.error);
    publish(channel, 'task-failed', {
      taskId: task.id,
      error: outcome.error,
    });
    return failed ?? task;
  }

  const done = await setTaskStatus(userId, task.id, 'done', outcome.content);
  publish(channel, 'task-done', {
    taskId: task.id,
    result: outcome.content.slice(0, 2000),
    steps: outcome.steps,
    artifacts: outcome.artifacts,
    citations: outcome.citations,
  });
  return done ?? task;
}

/** Tasks whose dependencies are all satisfied and that haven't run yet. */
function readyTasks(tasks: TaskView[]): TaskView[] {
  const doneIds = new Set(
    tasks.filter((t) => t.status === 'done' || t.status === 'skipped').map((t) => t.id),
  );
  return tasks
    .filter((task) => task.status === 'pending')
    .filter((task) => task.dependsOn.every((id) => doneIds.has(id)))
    .sort((a, b) => a.ordinal - b.ordinal);
}

export interface StartRunInput {
  goal: string;
  conversationId?: number | null;
  plannerModelRef?: string | null;
  workerModelRef?: string | null;
  maxParallel?: number;
  maxSteps?: number;
  toolKeys?: string[] | null;
}

export async function createRun(
  userId: string,
  input: StartRunInput,
): Promise<RunView> {
  const settings = await getUserSettings(userId);
  const [row] = await db
    .insert(agentRunsTable)
    .values({
      userId,
      conversationId: input.conversationId ?? null,
      goal: input.goal.trim().slice(0, 8000),
      status: 'planning',
      plannerModelRef: input.plannerModelRef ?? null,
      workerModelRef: input.workerModelRef ?? null,
      maxParallel: input.maxParallel ?? settings.maxParallelAgents,
      maxSteps: input.maxSteps ?? settings.maxAgentSteps,
      toolKeysJson: input.toolKeys ?? null,
    })
    .returning();
  return toRunView(row, []);
}

/**
 * Drive a run to completion. Safe to call again on a partially-finished run —
 * it picks up whatever is still pending, which is what makes runs resumable
 * after a restart.
 */
export async function executeRun(userId: string, runId: number): Promise<RunView> {
  const channel = runChannel(runId);
  const controller = registerCancellable(channel);

  try {
    let run = await getRun(userId, runId);
    if (!run) throw new Error('That run does not exist.');

    await db
      .update(agentRunsTable)
      .set({ status: 'running', startedAt: run.startedAt ?? new Date() })
      .where(eq(agentRunsTable.id, runId));
    publish(channel, 'run-started', { runId });

    if (run.tasks.length === 0) {
      await planRun(userId, runId);
      run = (await getRun(userId, runId))!;
    }

    let guard = 0;
    while (guard++ < 100) {
      if (controller.signal.aborted || isCancelled(channel)) {
        await db
          .update(agentRunsTable)
          .set({ status: 'cancelled', completedAt: new Date() })
          .where(eq(agentRunsTable.id, runId));
        publish(channel, 'run-cancelled', { runId });
        return (await getRun(userId, runId))!;
      }

      const tasks = await listTasks(userId, runId);
      const ready = readyTasks(tasks);

      if (ready.length === 0) {
        const stillPending = tasks.filter((t) => t.status === 'pending');
        if (stillPending.length > 0) {
          // Dependencies can't be satisfied — a prerequisite failed.
          for (const task of stillPending) {
            await setTaskStatus(
              userId,
              task.id,
              'cancelled',
              'A task this depends on did not complete.',
            );
          }
        }
        break;
      }

      // Fan out: run independent tasks together, up to the parallel cap.
      const batch = ready.slice(0, Math.max(1, run.maxParallel));
      publish(channel, 'batch-started', {
        taskIds: batch.map((task) => task.id),
      });
      await Promise.all(
        batch.map((task) => executeTask(userId, run!, task, tasks)),
      );
    }

    const finalTasks = await listTasks(userId, runId);
    const failed = finalTasks.filter((t) => t.status === 'failed');
    const done = finalTasks.filter((t) => t.status === 'done');
    const summary = await summarizeRun(userId, runId, finalTasks);

    await db
      .update(agentRunsTable)
      .set({
        status: failed.length > 0 && done.length === 0 ? 'failed' : 'done',
        resultSummary: summary,
        error:
          failed.length > 0
            ? `${failed.length} of ${finalTasks.length} tasks failed.`
            : null,
        completedAt: new Date(),
        stepsUsed: finalTasks.reduce((sum, task) => sum + task.attempts, 0),
      })
      .where(eq(agentRunsTable.id, runId));

    publish(channel, 'run-finished', {
      runId,
      summary,
      failed: failed.length,
      done: done.length,
    });
    closeChannel(channel);
    return (await getRun(userId, runId))!;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'The run failed unexpectedly.';
    await db
      .update(agentRunsTable)
      .set({ status: 'failed', error: message, completedAt: new Date() })
      .where(eq(agentRunsTable.id, runId));
    publish(channel, 'run-failed', { runId, error: message });
    closeChannel(channel);
    throw err;
  } finally {
    releaseCancellable(channel);
  }
}

async function summarizeRun(
  userId: string,
  runId: number,
  tasks: TaskView[],
): Promise<string> {
  const completed = tasks.filter((task) => task.status === 'done' && task.result);
  if (completed.length === 0) {
    const failures = tasks
      .filter((task) => task.error)
      .map((task) => `- ${task.title}: ${task.error}`)
      .join('\n');
    return failures
      ? `No tasks completed.\n${failures}`
      : 'No tasks completed.';
  }
  // The last completed task is usually the assembly step; if there's only one
  // task its result is already the answer.
  if (completed.length === 1) return completed[0].result!;

  const run = await getRun(userId, runId);
  const transcript = completed
    .map((task) => `## ${task.title}\n${task.result!.slice(0, 8000)}`)
    .join('\n\n');

  try {
    const modelRef =
      run?.workerModelRef ?? (await resolveModelForTask(userId, 'chat'));
    const { completeChat } = await import('../ai');
    const result = await completeChat(userId, {
      modelRef,
      temperature: 0.3,
      maxTokens: 2000,
      messages: [
        {
          role: 'system',
          content:
            'Combine these task results into one coherent answer to the original goal. Keep every substantive finding and citation. Drop process narration and duplication. Do not add anything the results do not support.',
        },
        {
          role: 'user',
          content: `Goal: ${run?.goal ?? ''}\n\n${transcript}`,
        },
      ],
    });
    return result.content.trim() || transcript;
  } catch {
    return transcript;
  }
}

export async function cancelRun(userId: string, runId: number): Promise<boolean> {
  const run = await getRun(userId, runId);
  if (!run) return false;
  cancel(runChannel(runId));
  await db
    .update(agentRunsTable)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(eq(agentRunsTable.id, runId));
  const pending = run.tasks.filter(
    (task) => task.status === 'pending' || task.status === 'running',
  );
  for (const task of pending) {
    await setTaskStatus(userId, task.id, 'cancelled', 'Run cancelled.');
  }
  publish(runChannel(runId), 'run-cancelled', { runId });
  closeChannel(runChannel(runId));
  return true;
}

export async function retryTask(
  userId: string,
  taskId: number,
): Promise<TaskView | null> {
  const [row] = await db
    .update(agentTasksTable)
    .set({
      status: 'pending',
      error: null,
      result: null,
      attempts: 0,
      startedAt: null,
      completedAt: null,
    })
    .where(
      and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.id, taskId)),
    )
    .returning();
  if (!row) return null;
  publish(runChannel(row.runId), 'task-updated', { task: toTaskView(row) });
  return toTaskView(row);
}

export async function deleteRun(userId: string, runId: number): Promise<boolean> {
  cancel(runChannel(runId));
  const deleted = await db
    .delete(agentRunsTable)
    .where(and(eq(agentRunsTable.userId, userId), eq(agentRunsTable.id, runId)))
    .returning({ id: agentRunsTable.id });
  return deleted.length > 0;
}

// ---------------------------------------------------------------------------
// delegate_task support
// ---------------------------------------------------------------------------

export interface DelegatedOutcome {
  taskId: number;
  result: string;
  steps: number;
  artifacts: ArtifactDraft[];
  citations: Citation[];
}

/**
 * Run one ad-hoc sub-agent on behalf of a parent agent or a chat turn. The
 * subtask is recorded on the parent's run when there is one, so it shows up in
 * the same to-do tree.
 */
export async function runDelegatedTask(
  ctx: ToolContext,
  input: { title: string; instructions: string; role?: string },
): Promise<DelegatedOutcome> {
  const role = input.role ?? 'worker';
  let runId = ctx.agentRunId ?? null;
  let goal = input.title;

  if (runId === null) {
    // A chat turn delegated without an enclosing run — create one so the work
    // is visible and auditable in the Agents panel.
    const run = await createRun(ctx.userId, {
      goal: input.title,
      conversationId: ctx.conversationId ?? null,
    });
    runId = run.id;
    await db
      .update(agentRunsTable)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(agentRunsTable.id, runId));
  } else {
    const parentRun = await getRun(ctx.userId, runId);
    goal = parentRun?.goal ?? input.title;
  }

  const [task] = await addTasksInternal(ctx.userId, runId, [
    {
      title: input.title,
      description: input.instructions,
      agentRole: role,
      parentTaskId: ctx.agentTaskId ?? null,
    },
  ]);

  const channel = runChannel(runId);
  await setTaskStatus(ctx.userId, task.id, 'running');

  const workerModel =
    ctx.modelRef ?? (await resolveModelForTask(ctx.userId, 'chat'));

  const outcome = await runAgentLoop({
    userId: ctx.userId,
    modelRef: workerModel,
    systemPrompt: [
      `You are a ${role} agent handling a delegated subtask.`,
      ROLE_GUIDANCE[role] ?? ROLE_GUIDANCE.worker,
      '',
      `Parent goal: ${goal}`,
      '',
      'Return only the finished result of your subtask.',
    ].join('\n'),
    messages: [{ role: 'user', content: input.instructions }],
    maxSteps: 10,
    context: {
      conversationId: ctx.conversationId ?? null,
      agentRunId: runId,
      agentTaskId: task.id,
    },
    emit: (event) => publish(channel, 'tool', { taskId: task.id, ...event }),
  });

  if (outcome.error) {
    await setTaskStatus(ctx.userId, task.id, 'failed', outcome.error);
    throw new Error(outcome.error);
  }
  await setTaskStatus(ctx.userId, task.id, 'done', outcome.content);

  return {
    taskId: task.id,
    result: outcome.content,
    steps: outcome.steps,
    artifacts: outcome.artifacts,
    citations: outcome.citations,
  };
}

/** Insert tasks with a parent link, which the public `addTasks` doesn't expose. */
async function addTasksInternal(
  userId: string,
  runId: number,
  tasks: Array<{
    title: string;
    description?: string | null;
    agentRole?: string;
    parentTaskId?: number | null;
  }>,
): Promise<TaskView[]> {
  const existing = await listTasks(userId, runId);
  const base = existing.reduce((max, task) => Math.max(max, task.ordinal), -1);
  const inserted = await db
    .insert(agentTasksTable)
    .values(
      tasks.map((task, index) => ({
        runId,
        userId,
        parentTaskId: task.parentTaskId ?? null,
        ordinal: base + 1 + index,
        title: task.title.slice(0, 200),
        description: task.description ?? null,
        agentRole: task.agentRole ?? 'worker',
        dependsOnJson: [],
        status: 'pending' as const,
      })),
    )
    .returning();
  publish(runChannel(runId), 'tasks-added', {
    tasks: inserted.map(toTaskView),
  });
  return inserted.map(toTaskView);
}

export { runAgentLoop } from './loop';
export type { AgentLoopResult } from './loop';
