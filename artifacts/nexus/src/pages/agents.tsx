import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  SkipForward,
  Square,
  Trash2,
  Undo2,
  Wrench,
  XCircle,
} from 'lucide-react';

import { Markdown } from '@/components/output/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { subscribeSse } from '@/lib/api';
import {
  useAddTasks,
  useAgentRun,
  useAgentRuns,
  useDeleteRun,
  useRunAction,
  useStartRun,
  useTaskAction,
} from '@/lib/queries';
import type { AgentRun, AgentTask, TaskStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The Agents screen.
 *
 * Give it a goal and a planner splits it into a task tree; independent tasks run
 * in parallel. The to-do list is the real object, not a transcript artefact —
 * add tasks, retry a failure, skip one, or undo a completed task (which also
 * invalidates everything downstream of it so a re-run recomputes cleanly).
 *
 * Progress arrives over SSE, and because run state lives in Postgres a reload
 * or a server restart doesn't lose the run.
 */

interface LiveEvent {
  seq: number;
  type: string;
  label: string;
  detail?: string;
}

const STATUS_META: Record<
  TaskStatus,
  { icon: React.ReactNode; className: string; label: string }
> = {
  pending: {
    icon: <CircleDashed className="h-4 w-4" />,
    className: 'text-muted-foreground',
    label: 'Pending',
  },
  running: {
    icon: <Loader2 className="h-4 w-4 animate-spin" />,
    className: 'text-primary',
    label: 'Running',
  },
  done: {
    icon: <CheckCircle2 className="h-4 w-4" />,
    className: 'text-green-600 dark:text-green-500',
    label: 'Done',
  },
  failed: {
    icon: <XCircle className="h-4 w-4" />,
    className: 'text-destructive',
    label: 'Failed',
  },
  cancelled: {
    icon: <XCircle className="h-4 w-4" />,
    className: 'text-muted-foreground',
    label: 'Cancelled',
  },
  skipped: {
    icon: <SkipForward className="h-4 w-4" />,
    className: 'text-muted-foreground',
    label: 'Skipped',
  },
  undone: {
    icon: <Undo2 className="h-4 w-4" />,
    className: 'text-muted-foreground',
    label: 'Undone',
  },
};

const RUN_STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  planning: 'secondary',
  running: 'default',
  paused: 'secondary',
  done: 'outline',
  failed: 'destructive',
  cancelled: 'outline',
};

export interface AgentsPageProps {
  conversationId: number | null;
  onBack: () => void;
}

export default function AgentsPage({ conversationId, onBack }: AgentsPageProps) {
  const { toast } = useToast();
  const [goal, setGoal] = useState('');
  const [maxParallel, setMaxParallel] = useState(3);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);

  const { data: runsData, isLoading } = useAgentRuns();
  const startRun = useStartRun();

  const runs = runsData?.runs ?? [];

  // Follow the newest run automatically so starting one shows its progress.
  useEffect(() => {
    if (activeRunId === null && runs.length > 0) setActiveRunId(runs[0].id);
  }, [runs, activeRunId]);

  const launch = (plan: boolean) => {
    const trimmed = goal.trim();
    if (trimmed.length < 4) {
      toast({ variant: 'destructive', title: 'Describe the goal first' });
      return;
    }
    startRun.mutate(
      { goal: trimmed, conversationId, maxParallel, plan },
      {
        onSuccess: (result) => {
          setActiveRunId(result.run.id);
          setGoal('');
          toast({
            title: plan ? 'Plan drafted' : 'Run started',
            description: plan
              ? 'Review the task list, then press Start.'
              : 'Working through the plan now.',
          });
        },
        onError: (err: unknown) => {
          toast({
            variant: 'destructive',
            title: 'Could not start the run',
            description: err instanceof Error ? err.message : undefined,
          });
        },
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border bg-card px-4 py-3">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-2" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Chat
          </Button>
          <div className="flex-1">
            <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
              <Bot className="h-5 w-5" />
              Agents
            </h1>
            <p className="text-sm text-muted-foreground">
              Split a big job across several agents working in parallel
            </p>
          </div>
        </div>
      </header>

      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="mx-auto max-w-6xl space-y-3">
          <Textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="What should the team accomplish? Be specific about the deliverable."
            className="min-h-20 resize-y"
            aria-label="Agent run goal"
            data-testid="textarea-goal"
          />
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex min-w-48 items-center gap-3">
              <Label className="whitespace-nowrap text-xs">Parallel agents</Label>
              <Slider
                value={[maxParallel]}
                min={1}
                max={8}
                step={1}
                onValueChange={([next]) => setMaxParallel(next)}
                className="w-28"
                aria-label="Parallel agents"
              />
              <span className="w-4 font-mono text-xs">{maxParallel}</span>
            </div>
            <div className="flex-1" />
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => launch(true)}
              disabled={startRun.isPending}
              data-testid="button-plan-only"
            >
              <Sparkles className="h-4 w-4" />
              Plan first
            </Button>
            <Button
              className="gap-2"
              onClick={() => launch(false)}
              disabled={startRun.isPending}
              data-testid="button-start-run"
            >
              {startRun.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Plan and run
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Run list */}
        <div className="w-64 shrink-0 border-r border-border">
          <ScrollArea className="h-full">
            <ul className="space-y-1 p-2">
              {isLoading && (
                <li className="space-y-2 p-1" aria-busy="true">
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="h-12 animate-pulse rounded-md bg-muted" />
                  ))}
                </li>
              )}
              {!isLoading && runs.length === 0 && (
                <li className="p-4 text-center text-sm text-muted-foreground">
                  No runs yet.
                </li>
              )}
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => setActiveRunId(run.id)}
                    className={cn(
                      'w-full rounded-md px-2 py-2 text-left transition-colors',
                      run.id === activeRunId ? 'bg-accent' : 'hover:bg-accent/60',
                    )}
                    data-testid={`link-run-${run.id}`}
                  >
                    <p className="line-clamp-2 text-sm">{run.goal}</p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Badge
                        variant={RUN_STATUS_VARIANT[run.status] ?? 'outline'}
                        className="h-4 px-1 text-[10px]"
                      >
                        {run.status}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        {run.tasks.filter((task) => task.status === 'done').length}/
                        {run.tasks.length}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>

        {activeRunId ? (
          <RunDetail runId={activeRunId} onDeleted={() => setActiveRunId(null)} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              Describe a goal above. The planner splits it into tasks, then
              workers run the independent ones side by side.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RunDetail({
  runId,
  onDeleted,
}: {
  runId: number;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const { data, refetch } = useAgentRun(runId);
  const runAction = useRunAction();
  const deleteRun = useDeleteRun();
  const taskAction = useTaskAction();
  const addTasks = useAddTasks();

  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [newTask, setNewTask] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const seqRef = useRef(0);

  const run = data?.run;
  const isActive = run?.status === 'running' || run?.status === 'planning';

  // Live progress. Re-subscribes when the run changes; replay means opening the
  // panel late still shows what already happened.
  useEffect(() => {
    setEvents([]);
    seqRef.current = 0;

    const subscription = subscribeSse(`/agents/runs/${runId}/events`, {
      onEvent: (type, payload) => {
        const data = (payload ?? {}) as Record<string, unknown>;
        const label = describeEvent(type, data);
        if (label) {
          seqRef.current += 1;
          setEvents((current) => [
            ...current.slice(-120),
            { seq: seqRef.current, type, label, detail: describeDetail(type, data) },
          ]);
        }
        // Task-shaped events change the tree, so pull fresh state.
        if (
          type.startsWith('task') ||
          type.startsWith('tasks') ||
          type === 'planned' ||
          type === 'run-finished' ||
          type === 'run-failed' ||
          type === 'run-cancelled'
        ) {
          void refetch();
        }
      },
    });

    return () => subscription.close();
  }, [runId, refetch]);

  const grouped = useMemo(() => {
    if (!run) return { roots: [] as AgentTask[], childrenOf: new Map<number, AgentTask[]>() };
    const childrenOf = new Map<number, AgentTask[]>();
    const roots: AgentTask[] = [];
    for (const task of run.tasks) {
      if (task.parentTaskId) {
        const list = childrenOf.get(task.parentTaskId) ?? [];
        list.push(task);
        childrenOf.set(task.parentTaskId, list);
      } else {
        roots.push(task);
      }
    }
    return { roots, childrenOf };
  }, [run]);

  if (!run) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const done = run.tasks.filter((task) => task.status === 'done').length;

  const renderTask = (task: AgentTask, depth = 0) => {
    const meta = STATUS_META[task.status];
    const open = expanded.has(task.id);
    const children = grouped.childrenOf.get(task.id) ?? [];

    return (
      <li key={task.id} style={{ marginLeft: depth * 20 }}>
        <div className="rounded-md border border-border bg-card">
          <div className="flex items-start gap-2 p-2.5">
            <span className={cn('mt-0.5 shrink-0', meta.className)}>{meta.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="min-w-0 flex-1 text-sm font-medium">{task.title}</p>
                <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px]">
                  {task.agentRole}
                </Badge>
              </div>
              {task.description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {task.description}
                </p>
              )}
              {task.dependsOn.length > 0 && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  waits on #{task.dependsOn.join(', #')}
                </p>
              )}
              {task.error && (
                <p className="mt-1 text-xs text-destructive">{task.error}</p>
              )}

              {(task.result || children.length > 0) && (
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(task.id)) next.delete(task.id);
                      else next.add(task.id);
                      return next;
                    })
                  }
                  className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  aria-expanded={open}
                >
                  <ChevronDown
                    className={cn('h-3.5 w-3.5 transition-transform', !open && '-rotate-90')}
                  />
                  {open ? 'Hide' : 'Show'} result
                </button>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              {task.status === 'done' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() =>
                    taskAction.mutate(
                      { taskId: task.id, runId, action: 'undo' },
                      {
                        onSuccess: () =>
                          toast({
                            title: 'Task undone',
                            description: 'Dependent tasks were reset too.',
                          }),
                      },
                    )
                  }
                  aria-label="Undo task"
                  data-testid={`button-undo-task-${task.id}`}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              )}
              {(task.status === 'failed' || task.status === 'cancelled') && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() =>
                    taskAction.mutate({ taskId: task.id, runId, action: 'retry' })
                  }
                  aria-label="Retry task"
                  data-testid={`button-retry-task-${task.id}`}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              )}
              {task.status === 'pending' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() =>
                    taskAction.mutate({ taskId: task.id, runId, action: 'skip' })
                  }
                  aria-label="Skip task"
                  data-testid={`button-skip-task-${task.id}`}
                >
                  <SkipForward className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() =>
                  taskAction.mutate({ taskId: task.id, runId, action: 'delete' })
                }
                aria-label="Delete task"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {open && task.result && (
            <div className="border-t border-border px-3 py-2 text-sm">
              <Markdown>{task.result}</Markdown>
            </div>
          )}
        </div>

        {children.length > 0 && (
          <ul className="mt-1.5 space-y-1.5">
            {children.map((child) => renderTask(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{run.goal}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge
              variant={RUN_STATUS_VARIANT[run.status] ?? 'outline'}
              className="h-5 px-1.5 text-[10px]"
            >
              {run.status}
            </Badge>
            <span>
              {done}/{run.tasks.length} tasks
            </span>
            <span>up to {run.maxParallel} in parallel</span>
            {run.error && <span className="text-destructive">{run.error}</span>}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {isActive ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => runAction.mutate({ runId, action: 'cancel' })}
              data-testid="button-cancel-run"
            >
              <Square className="h-3.5 w-3.5" />
              Cancel
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => runAction.mutate({ runId, action: 'start' })}
              data-testid="button-resume-run"
            >
              <Play className="h-3.5 w-3.5" />
              {run.tasks.some((task) => task.status === 'pending') ? 'Continue' : 'Re-run'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() =>
              deleteRun.mutate(runId, { onSuccess: onDeleted })
            }
            aria-label="Delete run"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-4 p-4">
          <ul className="space-y-1.5">{grouped.roots.map((task) => renderTask(task))}</ul>

          <div className="flex gap-2">
            <Input
              value={newTask}
              onChange={(event) => setNewTask(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newTask.trim()) {
                  addTasks.mutate({ runId, tasks: [{ title: newTask.trim() }] });
                  setNewTask('');
                }
              }}
              placeholder="Add a task to the list"
              className="h-9"
              aria-label="New task"
              data-testid="input-new-task"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => {
                if (!newTask.trim()) return;
                addTasks.mutate({ runId, tasks: [{ title: newTask.trim() }] });
                setNewTask('');
              }}
              data-testid="button-add-task"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>

          {run.resultSummary && (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-2 text-sm font-medium">Result</h2>
                <Markdown>{run.resultSummary}</Markdown>
              </CardContent>
            </Card>
          )}

          {events.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <Wrench className="h-3.5 w-3.5" />
                  Activity
                </h2>
                <ol className="space-y-1 font-mono text-[11px] text-muted-foreground">
                  {events.slice(-40).map((event) => (
                    <li key={event.seq} className="flex gap-2">
                      <span className="shrink-0 opacity-60">{event.type}</span>
                      <span className="min-w-0 flex-1 break-words">
                        {event.label}
                        {event.detail ? ` — ${event.detail}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function describeEvent(type: string, data: Record<string, unknown>): string | null {
  switch (type) {
    case 'planning':
      return 'Planning the work';
    case 'planned':
      return `Plan ready (${Array.isArray(data.tasks) ? data.tasks.length : 0} tasks)`;
    case 'run-started':
      return 'Run started';
    case 'batch-started':
      return `Dispatching ${Array.isArray(data.taskIds) ? data.taskIds.length : 0} task(s)`;
    case 'task-started':
      return `Started: ${String(data.title ?? '')}`;
    case 'task-progress':
      return `Step ${Number(data.step ?? 0) + 1}`;
    case 'task-done':
      return `Finished task #${String(data.taskId ?? '')}`;
    case 'task-failed':
      return `Task #${String(data.taskId ?? '')} failed`;
    case 'tool':
      return `Tool ${String((data as { toolName?: string }).toolName ?? '')}`;
    case 'run-finished':
      return 'Run finished';
    case 'run-failed':
      return 'Run failed';
    case 'run-cancelled':
      return 'Run cancelled';
    default:
      return null;
  }
}

function describeDetail(type: string, data: Record<string, unknown>): string | undefined {
  if (type === 'task-progress' && typeof data.preview === 'string') {
    return data.preview.slice(0, 140);
  }
  if (type === 'tool' && typeof data.message === 'string') {
    return data.message.slice(0, 140);
  }
  if (type === 'task-failed' && typeof data.error === 'string') {
    return data.error.slice(0, 200);
  }
  return undefined;
}
