/**
 * Wire types shared with the API server.
 *
 * These mirror the shapes the routes return. They're declared here rather than
 * imported from the server package because the frontend is built independently
 * and must not pull server code into the bundle.
 */

export type ModelTask =
  | 'Text Generation'
  | 'Text Embeddings'
  | 'Automatic Speech Recognition'
  | 'Text-to-Image'
  | 'Image-to-Text'
  | 'Text-to-Speech'
  | 'Translation'
  | 'Reranking'
  | 'Other';

export interface CatalogueModel {
  providerName: string;
  modelRef: string;
  modelId: string;
  displayName: string;
  task: ModelTask;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  modalities: string[];
  capabilities: string[];
  pricing: Record<string, unknown> | null;
  experimental: boolean;
  enabled: boolean;
}

export interface UserSettings {
  userId: string;
  defaultChatModel: string | null;
  defaultVisionModel: string | null;
  defaultTranscriptionModel: string | null;
  defaultEmbeddingModel: string | null;
  defaultRerankModel: string | null;
  defaultImageModel: string | null;
  defaultTtsModel: string | null;
  autoMemory: boolean;
  semanticRecall: boolean;
  summarizeThreshold: number;
  recallLimit: number;
  autoRouteModel: boolean;
  theme: string;
  accentColor: string;
  fontSize: string;
  density: string;
  codeTheme: string;
  maxParallelAgents: number;
  maxAgentSteps: number;
  browserDriver: string;
}

export interface Folder {
  id: number;
  name: string;
  createdAt: string;
}

export interface Conversation {
  id: number;
  title: string | null;
  folderId: number | null;
  modelRef: string | null;
  systemPrompt?: string | null;
  pinned: boolean;
  archived: boolean;
  scopedFileId: number | null;
  skillId: number | null;
  useLibrary: boolean;
  webSearch: boolean;
  toolsEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Citation {
  sourceType: 'file' | 'url' | 'message';
  fileId?: number;
  url?: string;
  title: string;
  locator: string | null;
  snippet: string;
  score: number | null;
}

export interface PersistedToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'ok' | 'error' | 'pending-approval' | 'denied';
  toolKey?: string;
  toolTitle?: string;
  result?: string;
}

export interface Message {
  id: number;
  conversationId: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  reasoning: string | null;
  attachmentsJson: Array<{ imageUrl?: string; text?: string; fileId?: number }> | null;
  toolCallsJson: PersistedToolCall[] | null;
  citationsJson: Citation[] | null;
  modelRef: string | null;
  tokenCounts: { tokensIn?: number; tokensOut?: number } | null;
  latencyMs: number | null;
  rating: number | null;
  parentMessageId: number | null;
  agentRunId: number | null;
  finishReason: string | null;
  error: string | null;
  createdAt: string;
}

export interface Artifact {
  id: number;
  messageId: number | null;
  kind: 'markdown' | 'code' | 'chart' | 'mermaid' | 'image' | 'audio' | 'table' | 'html';
  title: string | null;
  language: string | null;
  content: string | null;
  mime: string | null;
  storageKey: string | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: string;
}

export interface Summary {
  id: number;
  conversationId: number;
  upToMessageId: number;
  text: string;
  createdAt: string;
}

export interface LibraryFile {
  id: number;
  filename: string;
  mime: string;
  size: number;
  kind: string;
  status: 'queued' | 'extracting' | 'chunking' | 'embedding' | 'ready' | 'failed';
  progress: number;
  error: string | null;
  pageCount: number | null;
  durationS: number | null;
  tags: string[] | null;
  usedInChats: number;
  metadataJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileChunk {
  id: number;
  ordinal: number;
  pageOrTimestamp: string | null;
  text: string;
}

export interface MemoryFact {
  id: number;
  text: string;
  category: string;
  confidence: number | null;
  pinned: boolean;
  sourceMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type PermissionMode = 'ask' | 'allow' | 'deny';

export interface ToolCatalogueEntry {
  key: string;
  name: string;
  title: string;
  description: string;
  group: string;
  readOnly: boolean;
  destructive: boolean;
  autoApprove: boolean;
  available: boolean;
  unavailableReason: string | null;
  permission: PermissionMode;
  parameters: Record<string, unknown>;
}

export interface AuditEntry {
  id: number;
  toolKey: string;
  status: string;
  args: unknown;
  resultSummary: string | null;
  error: string | null;
  durationMs: number | null;
  conversationId: number | null;
  agentRunId: number | null;
  createdAt: string;
}

export interface BrowserCapabilities {
  driver: 'fetch' | 'cdp';
  canControl: boolean;
  canRenderJavaScript: boolean;
  reason: string;
  sessions?: Array<{ sessionId: string; url: string; lastUsedAt: number }>;
}

export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpServer {
  id: number;
  name: string;
  description: string | null;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  headerSecrets: Record<string, string>;
  envSecrets: Record<string, string>;
  staticHeaders: Record<string, string>;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  serverInfo: Record<string, unknown> | null;
  toolCount: number;
  lastConnectedAt: string | null;
}

export interface McpTool {
  id: number;
  serverId: number;
  serverName: string;
  name: string;
  toolKey: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  enabled: boolean;
}

export interface Secret {
  id: number;
  name: string;
  label: string | null;
  description: string | null;
  maskedPreview: string;
  scope: string;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnownSecret {
  name: string;
  label: string;
  description: string;
  docsUrl: string;
}

export interface Skill {
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
  lastUsedAt: string | null;
}

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

export interface AgentTask {
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
  startedAt: string | null;
  completedAt: string | null;
}

export interface AgentRun {
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
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  tasks: AgentTask[];
}

export interface UsageBucket {
  day: string;
  modelRef: string;
  providerName: string | null;
  operation: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costEstimate: number | null;
}

export interface RetrievedPassage {
  chunkId: number;
  fileId: number;
  filename: string;
  locator: string | null;
  text: string;
  vectorScore: number;
  rerankScore: number | null;
}

export interface RetrievalOutcome {
  passages: RetrievedPassage[];
  reranked: boolean;
  embeddingModel: string;
  note: string | null;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface PageSnapshot {
  url: string;
  finalUrl: string;
  title: string | null;
  siteName: string | null;
  text: string;
  markdown: string;
  links: Array<{ href: string; text: string }>;
  statusCode: number | null;
  driver: 'fetch' | 'cdp';
  fromCache: boolean;
  screenshotKey?: string | null;
}

export interface BrowserActionResult {
  url: string;
  title: string;
  text: string;
  interactive: Array<{
    selector: string;
    tag: string;
    text: string;
    role: string | null;
  }>;
  screenshotKey: string | null;
  evaluated?: unknown;
}

/** Chart spec produced by the `create_chart` tool. */
export interface ChartSpec {
  type: 'line' | 'bar' | 'area' | 'pie' | 'scatter';
  title: string;
  xKey: string;
  yLabel: string | null;
  series: Array<{ key: string; label?: string }>;
  data: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Chat stream events
// ---------------------------------------------------------------------------

export interface ToolProgressEvent {
  toolKey: string;
  toolName: string;
  callId: string;
  phase: 'started' | 'awaiting-approval' | 'progress' | 'finished' | 'error';
  message?: string;
  data?: unknown;
}

export interface PendingApproval {
  callId: string;
  toolKey: string;
  toolTitle: string;
  toolName: string;
  args: unknown;
}

export type ChatStreamEvent =
  | { type: 'start'; messageId: number; modelRef: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'context'; recalled: number; facts: number; summarized: boolean }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'tool'; event: ToolProgressEvent }
  | { type: 'tool-approval'; calls: PendingApproval[] }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'usage'; tokensIn: number | null; tokensOut: number | null }
  | { type: 'memory'; facts: Array<{ id: number; text: string }> }
  | {
      type: 'done';
      messageId: number;
      finishReason: string;
      latencyMs: number;
      modelRef: string;
    }
  | { type: 'error'; error: string; kind: string; hint: string | null };
