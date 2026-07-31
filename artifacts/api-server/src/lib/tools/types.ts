import type { ToolSchema } from '../ai/types';

/**
 * The tool contract.
 *
 * Built-in tools and MCP tools implement the same interface, so the chat loop,
 * the agent orchestrator and the permission gate never care where a tool came
 * from. A tool is identified two ways:
 *
 *   `key`  — stable, namespaced, used for permissions and audit
 *            (`builtin:web_fetch`, `mcp:7:search_repos`)
 *   `name` — the model-facing function name, always `[a-z0-9_]{1,64}`
 */

export type ToolGroup =
  | 'web'
  | 'browser'
  | 'library'
  | 'memory'
  | 'media'
  | 'output'
  | 'agents'
  | 'mcp';

export interface Citation {
  /** Where this came from: a library file or a URL. */
  sourceType: 'file' | 'url' | 'message';
  fileId?: number;
  url?: string;
  title: string;
  /** Page number, chapter title, or `mm:ss` timestamp. */
  locator: string | null;
  snippet: string;
  score: number | null;
}

export interface ArtifactDraft {
  kind:
    | 'markdown'
    | 'code'
    | 'chart'
    | 'mermaid'
    | 'image'
    | 'audio'
    | 'table'
    | 'html';
  title: string;
  language?: string | null;
  content?: string | null;
  mime?: string | null;
  storageKey?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ToolProgressEvent {
  toolKey: string;
  toolName: string;
  callId: string;
  phase: 'started' | 'awaiting-approval' | 'progress' | 'finished' | 'error';
  message?: string;
  data?: unknown;
}

export interface ToolContext {
  userId: string;
  conversationId?: number | null;
  messageId?: number | null;
  agentRunId?: number | null;
  agentTaskId?: number | null;
  signal?: AbortSignal;
  /** Stream progress to the client mid-execution. */
  emit?: (event: ToolProgressEvent) => void;
  /** Tools that need a model (chart authoring, page summarising) use this. */
  modelRef?: string | null;
}

export interface ToolResult {
  /** The text the model sees. Keep it compact and factual. */
  content: string;
  /** Structured payload for the UI — never fed back to the model verbatim. */
  data?: unknown;
  artifacts?: ArtifactDraft[];
  citations?: Citation[];
  isError?: boolean;
}

export interface ToolDefinition {
  key: string;
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  parameters: Record<string, unknown>;
  /** Read-only tools can be auto-approved; everything else asks by default. */
  readOnly: boolean;
  destructive: boolean;
  /**
   * Safe writes confined to the user's own workspace (saving a memory fact,
   * drafting an artifact, ticking off a to-do). These don't reach outside the
   * account or spend money, so they don't interrupt with a prompt — but the
   * user can still deny them explicitly in Settings → Tools.
   */
  autoApprove?: boolean;
  /** Hidden from the model unless the feature it depends on is configured. */
  requires?: 'library' | 'browser' | 'image-model' | 'tts-model' | null;
  execute: (
    ctx: ToolContext,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
}

export function toToolSchema(tool: ToolDefinition): ToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/** Coerce any string into a model-safe function name. */
export function safeToolName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (cleaned || 'tool').slice(0, 64);
}

/** Small helper so tool implementations stay terse. */
export function textResult(
  content: string,
  extras: Omit<ToolResult, 'content'> = {},
): ToolResult {
  return { content, ...extras };
}

export function errorResult(message: string): ToolResult {
  return { content: message, isError: true };
}
