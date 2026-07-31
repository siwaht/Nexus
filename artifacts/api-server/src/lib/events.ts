import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub for streaming progress to the browser.
 *
 * Agent runs outlive the request that started them, so their progress can't
 * ride on the original response. Instead each run publishes here and clients
 * subscribe over SSE. A bounded replay buffer per channel means a client that
 * reconnects (or opens the panel late) still sees what already happened
 * without needing Redis or a queue.
 */

export interface StreamEvent {
  seq: number;
  type: string;
  data: unknown;
  at: number;
}

const REPLAY_LIMIT = 400;
const CHANNEL_TTL_MS = 60 * 60 * 1000;

interface Channel {
  emitter: EventEmitter;
  history: StreamEvent[];
  nextSeq: number;
  closed: boolean;
  touchedAt: number;
}

const channels = new Map<string, Channel>();

setInterval(() => {
  const cutoff = Date.now() - CHANNEL_TTL_MS;
  for (const [id, channel] of channels) {
    if (channel.closed && channel.touchedAt < cutoff) channels.delete(id);
  }
}, 5 * 60 * 1000).unref();

function channel(id: string): Channel {
  const existing = channels.get(id);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const created: Channel = {
    emitter: new EventEmitter(),
    history: [],
    nextSeq: 1,
    closed: false,
    touchedAt: Date.now(),
  };
  // Several browser tabs can watch the same run.
  created.emitter.setMaxListeners(50);
  channels.set(id, created);
  return created;
}

export function publish(id: string, type: string, data: unknown): StreamEvent {
  const target = channel(id);
  const event: StreamEvent = {
    seq: target.nextSeq++,
    type,
    data,
    at: Date.now(),
  };
  target.history.push(event);
  if (target.history.length > REPLAY_LIMIT) target.history.shift();
  target.touchedAt = Date.now();
  target.emitter.emit('event', event);
  return event;
}

export function closeChannel(id: string): void {
  const target = channels.get(id);
  if (!target) return;
  target.closed = true;
  target.touchedAt = Date.now();
  target.emitter.emit('closed');
}

export function isChannelClosed(id: string): boolean {
  return channels.get(id)?.closed ?? false;
}

export interface Subscription {
  /** Events already published, from `afterSeq` onwards. */
  replay: StreamEvent[];
  unsubscribe: () => void;
}

export function subscribe(
  id: string,
  handler: (event: StreamEvent) => void,
  options: { afterSeq?: number; onClose?: () => void } = {},
): Subscription {
  const target = channel(id);
  const afterSeq = options.afterSeq ?? 0;
  const replay = target.history.filter((event) => event.seq > afterSeq);

  const onEvent = (event: StreamEvent) => handler(event);
  const onClosed = () => options.onClose?.();
  target.emitter.on('event', onEvent);
  target.emitter.on('closed', onClosed);

  if (target.closed) {
    // Already finished — let the caller drain the replay then close.
    setImmediate(() => options.onClose?.());
  }

  return {
    replay,
    unsubscribe: () => {
      target.emitter.off('event', onEvent);
      target.emitter.off('closed', onClosed);
    },
  };
}

export function runChannel(runId: number): string {
  return `run:${runId}`;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

const cancellations = new Map<string, AbortController>();

export function registerCancellable(id: string): AbortController {
  const existing = cancellations.get(id);
  if (existing) existing.abort();
  const controller = new AbortController();
  cancellations.set(id, controller);
  return controller;
}

export function cancel(id: string): boolean {
  const controller = cancellations.get(id);
  if (!controller) return false;
  controller.abort();
  cancellations.delete(id);
  return true;
}

export function releaseCancellable(id: string): void {
  cancellations.delete(id);
}

export function isCancelled(id: string): boolean {
  return cancellations.get(id)?.signal.aborted ?? false;
}
