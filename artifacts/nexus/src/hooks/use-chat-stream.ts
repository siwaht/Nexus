import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { api, streamSse } from '@/lib/api';
import { keys } from '@/lib/queries';
import type {
  Artifact,
  ChatStreamEvent,
  Citation,
  PendingApproval,
  ToolProgressEvent,
} from '@/lib/types';

/**
 * Client state for a streaming assistant turn.
 *
 * Holds only what's in flight — the persisted transcript comes from the
 * conversation query, which is refetched when the turn ends. That split keeps
 * the optimistic view and the source of truth from drifting.
 *
 * A turn can pause for tool approval: the stream ends with `pendingApprovals`
 * populated, and `resolveApprovals` continues it. Because the pause is
 * persisted server-side, reloading the page mid-approval doesn't lose the turn.
 */

export interface StreamingState {
  /** Text streamed so far for the in-flight assistant message. */
  text: string;
  reasoning: string;
  messageId: number | null;
  modelRef: string | null;
  tokensIn: number;
  tokensOut: number;
  citations: Citation[];
  artifacts: Artifact[];
  toolEvents: ToolProgressEvent[];
  contextInfo: { recalled: number; facts: number; summarized: boolean } | null;
  savedFacts: Array<{ id: number; text: string }>;
}

const EMPTY: StreamingState = {
  text: '',
  reasoning: '',
  messageId: null,
  modelRef: null,
  tokensIn: 0,
  tokensOut: 0,
  citations: [],
  artifacts: [],
  toolEvents: [],
  contextInfo: null,
  savedFacts: [],
};

export interface SendOptions {
  content: string;
  attachments?: Array<{ imageUrl?: string; text?: string; fileId?: number }>;
  modelRef?: string | null;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  skillId?: number | null;
  useLibrary?: boolean;
  webSearch?: boolean;
  toolsEnabled?: boolean;
}

export interface UseChatStreamResult {
  streaming: boolean;
  state: StreamingState;
  error: { message: string; hint: string | null } | null;
  pendingApprovals: PendingApproval[];
  send: (options: SendOptions) => Promise<void>;
  regenerate: (fromMessageId?: number) => Promise<void>;
  resolveApprovals: (approvals: Record<string, boolean>) => Promise<void>;
  stop: () => void;
  dismissError: () => void;
}

export function useChatStream(conversationId: number | null): UseChatStreamResult {
  const queryClient = useQueryClient();
  const [streaming, setStreaming] = useState(false);
  const [state, setState] = useState<StreamingState>(EMPTY);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(
    null,
  );
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (conversationId) {
      void queryClient.invalidateQueries({
        queryKey: keys.conversation(conversationId),
      });
    }
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['usage'] });
  }, [conversationId, queryClient]);

  const handleEvent = useCallback((raw: unknown) => {
    const event = raw as ChatStreamEvent;
    switch (event.type) {
      case 'start':
        setState((current) => ({
          ...current,
          messageId: event.messageId,
          modelRef: event.modelRef,
        }));
        break;
      case 'delta':
        setState((current) => ({ ...current, text: current.text + event.text }));
        break;
      case 'reasoning':
        setState((current) => ({
          ...current,
          reasoning: current.reasoning + event.text,
        }));
        break;
      case 'context':
        setState((current) => ({
          ...current,
          contextInfo: {
            recalled: event.recalled,
            facts: event.facts,
            summarized: event.summarized,
          },
        }));
        break;
      case 'citations':
        setState((current) => {
          // Tool results append citations, so dedupe as they arrive.
          const seen = new Set(
            current.citations.map((c) => `${c.sourceType}:${c.url ?? c.fileId}:${c.locator}`),
          );
          const added = event.citations.filter((c) => {
            const key = `${c.sourceType}:${c.url ?? c.fileId}:${c.locator}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return { ...current, citations: [...current.citations, ...added] };
        });
        break;
      case 'tool':
        setState((current) => ({
          ...current,
          toolEvents: [...current.toolEvents.slice(-40), event.event],
        }));
        break;
      case 'artifact':
        setState((current) => ({
          ...current,
          artifacts: [...current.artifacts, event.artifact],
        }));
        break;
      case 'usage':
        setState((current) => ({
          ...current,
          tokensIn: current.tokensIn + (event.tokensIn ?? 0),
          tokensOut: current.tokensOut + (event.tokensOut ?? 0),
        }));
        break;
      case 'memory':
        setState((current) => ({
          ...current,
          savedFacts: [...current.savedFacts, ...event.facts],
        }));
        break;
      case 'tool-approval':
        setPendingApprovals(event.calls);
        break;
      case 'error':
        setError({ message: event.error, hint: event.hint });
        break;
      case 'done':
        break;
    }
  }, []);

  const run = useCallback(
    async (path: string, body: unknown, keepState = false) => {
      if (!conversationId) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);
      setError(null);
      setPendingApprovals([]);
      if (!keepState) setState(EMPTY);

      await streamSse(
        path,
        body,
        {
          onEvent: (_type, data) => handleEvent(data),
          onError: (err) => setError({ message: err.message, hint: null }),
        },
        controller.signal,
      );

      setStreaming(false);
      abortRef.current = null;
      refresh();
    },
    [conversationId, handleEvent, refresh],
  );

  const send = useCallback(
    async (options: SendOptions) => {
      if (!conversationId) return;
      await run(`/chat/${conversationId}/stream`, options);
      // Clear the local buffer once the persisted message is available.
      setState((current) => (current.messageId ? EMPTY : current));
    },
    [conversationId, run],
  );

  const regenerate = useCallback(
    async (fromMessageId?: number) => {
      if (!conversationId) return;
      await run(`/chat/${conversationId}/regenerate`, { fromMessageId });
      setState(EMPTY);
    },
    [conversationId, run],
  );

  const resolveApprovals = useCallback(
    async (approvals: Record<string, boolean>) => {
      if (!conversationId || !state.messageId) return;
      await run(
        `/chat/${conversationId}/resume`,
        { messageId: state.messageId, approvals },
        true,
      );
      setState(EMPTY);
    },
    [conversationId, run, state.messageId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    if (conversationId) {
      // Tell the server too, so generation stops upstream rather than just
      // detaching this client from it.
      void api.post(`/chat/${conversationId}/stop`).catch(() => undefined);
    }
    setStreaming(false);
    refresh();
  }, [conversationId, refresh]);

  return {
    streaming,
    state,
    error,
    pendingApprovals,
    send,
    regenerate,
    resolveApprovals,
    stop,
    dismissError: () => setError(null),
  };
}
