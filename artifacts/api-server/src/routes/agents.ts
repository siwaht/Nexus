import { Router, type IRouter } from 'express';

import {
  addTasks,
  cancelRun,
  createRun,
  deleteRun,
  deleteTask,
  executeRun,
  getRun,
  listRuns,
  listTasks,
  planRun,
  reorderTasks,
  retryTask,
  setTaskStatus,
  undoTask,
  type TaskStatus,
} from '../lib/agents';
import { isChannelClosed, runChannel, subscribe } from '../lib/events';
import { rateLimit } from '../lib/rateLimit';
import { requireAuth } from '../middlewares/requireAuth';
import {
  handler,
  intParam,
  openSse,
  optionalStr,
  requireIntParam,
  str,
  stringArray,
  userId,
} from './helpers';

/**
 * Multi-agent runs and their to-do lists.
 *
 * `POST /agents/runs` creates and starts a run, returning immediately — the run
 * executes in the background and progress is streamed from
 * `GET /agents/runs/:id/events`. That split is what lets a long run survive a
 * page reload, and it's why every task mutation is a real endpoint rather than
 * something buried in the stream.
 */

const router: IRouter = Router();

router.use('/agents', requireAuth);

const startLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many agent runs started in a short window.',
});

const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
  'skipped',
  'undone',
];

router.get(
  '/agents/runs',
  handler(async (req, res) => {
    res.json({ runs: await listRuns(userId(req), intParam(req.query.limit, 30)) });
  }),
);

router.post(
  '/agents/runs',
  startLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const goal = str(body.goal).trim();
    if (goal.length < 4) throw new Error('An agent run needs a goal.');

    const run = await createRun(uid, {
      goal,
      conversationId: intParam(body.conversationId) || null,
      plannerModelRef: optionalStr(body.plannerModelRef),
      workerModelRef: optionalStr(body.workerModelRef),
      maxParallel: intParam(body.maxParallel) || undefined,
      maxSteps: intParam(body.maxSteps) || undefined,
      toolKeys: stringArray(body.toolKeys).length > 0 ? stringArray(body.toolKeys) : null,
    });

    // Kick off in the background; the client watches the SSE channel.
    void executeRun(uid, run.id).catch((err) => {
      req.log.error({ runId: run.id, err: String(err) }, 'Agent run failed');
    });

    res.json({ run });
  }),
);

/** Plan without executing, so the user can edit the to-do list first. */
router.post(
  '/agents/runs/plan',
  startLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const goal = str(body.goal).trim();
    if (goal.length < 4) throw new Error('An agent run needs a goal.');

    const run = await createRun(uid, {
      goal,
      conversationId: intParam(body.conversationId) || null,
      plannerModelRef: optionalStr(body.plannerModelRef),
      workerModelRef: optionalStr(body.workerModelRef),
      maxParallel: intParam(body.maxParallel) || undefined,
      maxSteps: intParam(body.maxSteps) || undefined,
    });
    const tasks = await planRun(uid, run.id);
    res.json({ run: await getRun(uid, run.id), tasks });
  }),
);

router.get(
  '/agents/runs/:id',
  handler(async (req, res) => {
    const run = await getRun(userId(req), requireIntParam(req.params.id, 'id'));
    if (!run) throw new Error('That run does not exist.');
    res.json({ run });
  }),
);

/** Start (or resume) execution of a run that was only planned. */
router.post(
  '/agents/runs/:id/start',
  startLimiter,
  handler(async (req, res) => {
    const uid = userId(req);
    const runId = requireIntParam(req.params.id, 'id');
    const run = await getRun(uid, runId);
    if (!run) throw new Error('That run does not exist.');
    if (run.status === 'running') throw new Error('That run is already running.');

    void executeRun(uid, runId).catch((err) => {
      req.log.error({ runId, err: String(err) }, 'Agent run failed');
    });
    res.json({ started: true });
  }),
);

router.post(
  '/agents/runs/:id/cancel',
  handler(async (req, res) => {
    const cancelled = await cancelRun(
      userId(req),
      requireIntParam(req.params.id, 'id'),
    );
    res.json({ cancelled });
  }),
);

router.delete(
  '/agents/runs/:id',
  handler(async (req, res) => {
    const deleted = await deleteRun(
      userId(req),
      requireIntParam(req.params.id, 'id'),
    );
    res.json({ deleted });
  }),
);

router.get(
  '/agents/runs/:id/events',
  handler(async (req, res) => {
    const uid = userId(req);
    const runId = requireIntParam(req.params.id, 'id');
    const run = await getRun(uid, runId);
    if (!run) throw new Error('That run does not exist.');

    const sse = openSse(req, res);
    sse.send('run', { run });

    const channel = runChannel(runId);
    const subscription = subscribe(
      channel,
      (event) => sse.send(event.type, event.data),
      {
        afterSeq: intParam(req.query.afterSeq),
        onClose: () => sse.close(),
      },
    );
    for (const event of subscription.replay) sse.send(event.type, event.data);
    if (isChannelClosed(channel)) sse.close();

    sse.signal.addEventListener('abort', () => subscription.unsubscribe());
  }),
);

// ---------------------------------------------------------------------------
// To-do list
// ---------------------------------------------------------------------------

router.get(
  '/agents/runs/:id/tasks',
  handler(async (req, res) => {
    res.json({
      tasks: await listTasks(userId(req), requireIntParam(req.params.id, 'id')),
    });
  }),
);

router.post(
  '/agents/runs/:id/tasks',
  handler(async (req, res) => {
    const uid = userId(req);
    const runId = requireIntParam(req.params.id, 'id');
    const raw = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    const tasks = raw
      .map((entry: unknown) => {
        const record = (entry ?? {}) as Record<string, unknown>;
        return {
          title: str(record.title).trim(),
          description: optionalStr(record.description),
          agentRole: str(record.agentRole, 'worker'),
          dependsOn: Array.isArray(record.dependsOn)
            ? record.dependsOn.map((id: unknown) => intParam(id)).filter((id) => id > 0)
            : [],
        };
      })
      .filter((task: { title: string }) => task.title.length > 0);
    if (tasks.length === 0) throw new Error('No valid tasks to add.');
    res.json({ tasks: await addTasks(uid, runId, tasks) });
  }),
);

router.patch(
  '/agents/tasks/:taskId',
  handler(async (req, res) => {
    const uid = userId(req);
    const taskId = requireIntParam(req.params.taskId, 'taskId');
    const status = str(req.body?.status) as TaskStatus;
    if (!TASK_STATUSES.includes(status)) {
      throw new Error(`status must be one of: ${TASK_STATUSES.join(', ')}.`);
    }
    const task = await setTaskStatus(
      uid,
      taskId,
      status,
      optionalStr(req.body?.result),
    );
    if (!task) throw new Error('That task does not exist.');
    res.json({ task });
  }),
);

router.post(
  '/agents/tasks/:taskId/undo',
  handler(async (req, res) => {
    const tasks = await undoTask(
      userId(req),
      requireIntParam(req.params.taskId, 'taskId'),
    );
    if (tasks.length === 0) throw new Error('That task does not exist.');
    res.json({ tasks });
  }),
);

router.post(
  '/agents/tasks/:taskId/retry',
  handler(async (req, res) => {
    const task = await retryTask(
      userId(req),
      requireIntParam(req.params.taskId, 'taskId'),
    );
    if (!task) throw new Error('That task does not exist.');
    res.json({ task });
  }),
);

router.delete(
  '/agents/tasks/:taskId',
  handler(async (req, res) => {
    const deleted = await deleteTask(
      userId(req),
      requireIntParam(req.params.taskId, 'taskId'),
    );
    res.json({ deleted });
  }),
);

router.put(
  '/agents/runs/:id/tasks/order',
  handler(async (req, res) => {
    const uid = userId(req);
    const runId = requireIntParam(req.params.id, 'id');
    const orderedIds = Array.isArray(req.body?.orderedIds)
      ? req.body.orderedIds
          .map((id: unknown) => intParam(id))
          .filter((id: number) => id > 0)
      : [];
    if (orderedIds.length === 0) throw new Error('orderedIds is required.');
    res.json({ tasks: await reorderTasks(uid, runId, orderedIds) });
  }),
);

export default router;
