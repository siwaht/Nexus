import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';

import { api } from './api';
import type {
  AgentRun,
  Artifact,
  AuditEntry,
  BrowserCapabilities,
  CatalogueModel,
  Conversation,
  FileChunk,
  Folder,
  KnownSecret,
  LibraryFile,
  McpServer,
  McpTool,
  MemoryFact,
  Message,
  ModelTask,
  PermissionMode,
  Secret,
  Skill,
  Summary,
  ToolCatalogueEntry,
  UsageBucket,
  UserSettings,
} from './types';

/**
 * React Query hooks for every Nexus endpoint.
 *
 * Query keys are grouped under a single `keys` object so mutations can
 * invalidate precisely instead of blowing away the whole cache.
 */

export const keys = {
  models: (task?: string) => ['models', task ?? 'all'] as const,
  settings: () => ['settings'] as const,
  folders: () => ['folders'] as const,
  conversations: (search?: string, archived?: boolean) =>
    ['conversations', search ?? '', archived ?? false] as const,
  conversation: (id: number) => ['conversation', id] as const,
  files: (kind?: string, search?: string) =>
    ['files', kind ?? 'all', search ?? ''] as const,
  file: (id: number) => ['file', id] as const,
  memory: () => ['memory'] as const,
  tools: () => ['tools'] as const,
  audit: () => ['tools', 'audit'] as const,
  mcp: () => ['mcp'] as const,
  secrets: () => ['secrets'] as const,
  skills: () => ['skills'] as const,
  runs: () => ['agent-runs'] as const,
  run: (id: number) => ['agent-run', id] as const,
  usage: (days: number) => ['usage', days] as const,
  browser: () => ['browser-capabilities'] as const,
};

// ---------------------------------------------------------------------------
// Models and settings
// ---------------------------------------------------------------------------

export function useModels(task?: ModelTask) {
  return useQuery({
    queryKey: keys.models(task),
    queryFn: () =>
      api.get<{ models: CatalogueModel[]; stale: boolean }>(
        `/models${task ? `?task=${encodeURIComponent(task)}` : ''}`,
      ),
    staleTime: 5 * 60 * 1000,
  });
}

export function useRefreshCatalogue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{
        outcomes: Array<{
          provider: string;
          ok: boolean;
          count: number;
          message: string;
        }>;
        total: number;
      }>('/models/refresh'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });
}

export function useSettings() {
  return useQuery({
    queryKey: keys.settings(),
    queryFn: () =>
      api.get<{ settings: UserSettings; connectedProviders: string[] }>('/settings'),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<UserSettings>) =>
      api.patch<{ settings: UserSettings }>('/settings', patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.settings() });
    },
  });
}

export function useSetModelEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { modelRef: string; enabled: boolean }) =>
      api.patch('/models/enabled', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export function useFolders() {
  return useQuery({
    queryKey: keys.folders(),
    queryFn: () => api.get<{ folders: Folder[] }>('/folders'),
  });
}

export function useCreateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<{ folder: Folder }>('/folders', { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.folders() });
    },
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/folders/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.folders() });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useConversations(search?: string, archived?: boolean) {
  return useQuery({
    queryKey: keys.conversations(search, archived),
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (archived) params.set('archived', 'true');
      const query = params.toString();
      return api.get<{ conversations: Conversation[] }>(
        `/conversations${query ? `?${query}` : ''}`,
      );
    },
  });
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  artifacts: Artifact[];
  summaries: Summary[];
}

export function useConversation(
  id: number | null,
  options?: Partial<UseQueryOptions<ConversationDetail>>,
) {
  return useQuery({
    queryKey: keys.conversation(id ?? 0),
    queryFn: () => api.get<ConversationDetail>(`/conversations/${id}`),
    enabled: id !== null && id > 0,
    ...options,
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<Conversation> = {}) =>
      api.post<{ conversation: Conversation }>('/conversations', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useUpdateConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & Record<string, unknown>) =>
      api.patch<{ conversation: Conversation }>(`/conversations/${id}`, patch),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({
        queryKey: keys.conversation(variables.id),
      });
    },
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/conversations/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useBranchConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: number; fromMessageId: number }) =>
      api.post<{ conversation: Conversation; copiedMessages: number }>(
        `/conversations/${input.id}/branch`,
        { fromMessageId: input.fromMessageId },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useRateMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      conversationId: number;
      messageId: number;
      rating: number;
    }) =>
      api.patch(
        `/conversations/${input.conversationId}/messages/${input.messageId}`,
        { rating: input.rating },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: keys.conversation(variables.conversationId),
      });
    },
  });
}

export function useDeleteMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      conversationId: number;
      messageId: number;
      cascade?: boolean;
    }) =>
      api.delete(
        `/conversations/${input.conversationId}/messages/${input.messageId}${input.cascade ? '?cascade=true' : ''}`,
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: keys.conversation(variables.conversationId),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export function useFiles(kind?: string, search?: string) {
  return useQuery({
    queryKey: keys.files(kind, search),
    queryFn: () => {
      const params = new URLSearchParams();
      if (kind && kind !== 'all') params.set('kind', kind);
      if (search) params.set('search', search);
      const query = params.toString();
      return api.get<{
        files: LibraryFile[];
        media: { ffmpeg: boolean; ffprobe: boolean };
      }>(`/files${query ? `?${query}` : ''}`);
    },
    // Ingestion runs in the background, so poll while anything is in flight.
    refetchInterval: (query) => {
      const data = query.state.data as { files?: LibraryFile[] } | undefined;
      const busy = data?.files?.some(
        (file) => file.status !== 'ready' && file.status !== 'failed',
      );
      return busy ? 2000 : false;
    },
  });
}

export function useFile(id: number | null, withChunks = false) {
  return useQuery({
    queryKey: [...keys.file(id ?? 0), withChunks],
    queryFn: () =>
      api.get<{ file: LibraryFile; chunks: FileChunk[]; chunkCount: number }>(
        `/files/${id}${withChunks ? '?chunks=true' : ''}`,
      ),
    enabled: id !== null && id > 0,
  });
}

export function useUploadFiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      return api.upload<{
        accepted: Array<{ id: number; filename: string; kind: string }>;
        rejected: Array<{ filename: string; reason: string }>;
      }>('/files', form);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      void queryClient.invalidateQueries({ queryKey: keys.tools() });
    },
  });
}

export function useDeleteFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/files/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['files'] });
    },
  });
}

export function useReindexFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post(`/files/${id}/reindex`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['files'] });
    },
  });
}

export function useUpdateFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & Record<string, unknown>) =>
      api.patch<{ file: LibraryFile }>(`/files/${id}`, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['files'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function useMemory() {
  return useQuery({
    queryKey: keys.memory(),
    queryFn: () => api.get<{ facts: MemoryFact[] }>('/memory'),
  });
}

export function useSaveMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { text: string; category?: string; pinned?: boolean }) =>
      api.post<{ fact: MemoryFact }>('/memory', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.memory() });
    },
  });
}

export function useUpdateMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & Record<string, unknown>) =>
      api.patch<{ fact: MemoryFact }>(`/memory/${id}`, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.memory() });
    },
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/memory/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.memory() });
    },
  });
}

export function useWipeMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ deleted: number }>('/memory/wipe', { confirm: true }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.memory() });
    },
  });
}

// ---------------------------------------------------------------------------
// Tools and permissions
// ---------------------------------------------------------------------------

export function useTools() {
  return useQuery({
    queryKey: keys.tools(),
    queryFn: () =>
      api.get<{
        tools: ToolCatalogueEntry[];
        permissions: Array<{ toolKey: string; mode: PermissionMode }>;
        browser: BrowserCapabilities;
      }>('/tools'),
  });
}

export function useSetPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { toolKey: string; mode: PermissionMode }) =>
      api.put('/tools/permissions', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.tools() });
    },
  });
}

export function useAudit() {
  return useQuery({
    queryKey: keys.audit(),
    queryFn: () => api.get<{ entries: AuditEntry[] }>('/tools/audit?limit=150'),
  });
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export function useMcp() {
  return useQuery({
    queryKey: keys.mcp(),
    queryFn: () =>
      api.get<{
        servers: McpServer[];
        tools: McpTool[];
        stdio: { available: boolean; reason: string | null };
      }>('/mcp/servers'),
  });
}

export function useSaveMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id?: number } & Record<string, unknown>) =>
      id
        ? api.put<{ server: McpServer }>(`/mcp/servers/${id}`, body)
        : api.post<{ server: McpServer }>('/mcp/servers', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.mcp() });
      void queryClient.invalidateQueries({ queryKey: keys.tools() });
    },
  });
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/mcp/servers/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.mcp() });
      void queryClient.invalidateQueries({ queryKey: keys.tools() });
    },
  });
}

export function useTestMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api.post<{
        ok: boolean;
        message: string;
        toolCount: number;
        tools: McpTool[];
      }>(`/mcp/servers/${id}/test`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.mcp() });
      void queryClient.invalidateQueries({ queryKey: keys.tools() });
    },
  });
}

export function useSetMcpToolEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { toolId: number; enabled: boolean }) =>
      api.patch(`/mcp/tools/${input.toolId}`, { enabled: input.enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.mcp() });
      void queryClient.invalidateQueries({ queryKey: keys.tools() });
    },
  });
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export function useSecrets() {
  return useQuery({
    queryKey: keys.secrets(),
    queryFn: () =>
      api.get<{ secrets: Secret[]; known: KnownSecret[] }>('/secrets'),
  });
}

export function useSaveSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      value: string;
      label?: string | null;
      description?: string | null;
      scope?: string;
    }) => api.put<{ secret: Secret }>('/secrets', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.secrets() });
    },
  });
}

export function useDeleteSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.delete(`/secrets/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.secrets() });
    },
  });
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export function useSkills() {
  return useQuery({
    queryKey: keys.skills(),
    queryFn: () => api.get<{ skills: Skill[] }>('/skills'),
  });
}

export function useSaveSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id?: number } & Record<string, unknown>) =>
      id
        ? api.put<{ skill: Skill }>(`/skills/${id}`, body)
        : api.post<{ skill: Skill }>('/skills', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.skills() });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/skills/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.skills() });
    },
  });
}

export interface GeneratedSkillDraft {
  name: string;
  description: string | null;
  whenToUse: string | null;
  instructions: string;
  toolKeys: string[];
}

export function useGenerateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { description: string; save?: boolean }) =>
      api.post<{
        draft: GeneratedSkillDraft;
        saved: Skill | null;
        unknownTools: string[];
      }>('/skills/generate', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.skills() });
    },
  });
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function useAgentRuns() {
  return useQuery({
    queryKey: keys.runs(),
    queryFn: () => api.get<{ runs: AgentRun[] }>('/agents/runs'),
  });
}

export function useAgentRun(id: number | null) {
  return useQuery({
    queryKey: keys.run(id ?? 0),
    queryFn: () => api.get<{ run: AgentRun }>(`/agents/runs/${id}`),
    enabled: id !== null && id > 0,
  });
}

export function useStartRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      goal: string;
      conversationId?: number | null;
      maxParallel?: number;
      maxSteps?: number;
      plan?: boolean;
    }) =>
      input.plan
        ? api.post<{ run: AgentRun }>('/agents/runs/plan', input)
        : api.post<{ run: AgentRun }>('/agents/runs', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.runs() });
    },
  });
}

export function useRunAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: number; action: 'start' | 'cancel' }) =>
      api.post(`/agents/runs/${input.runId}/${input.action}`),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: keys.runs() });
      void queryClient.invalidateQueries({ queryKey: keys.run(variables.runId) });
    },
  });
}

export function useDeleteRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: number) => api.delete(`/agents/runs/${runId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.runs() });
    },
  });
}

export function useTaskAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      taskId: number;
      runId: number;
      action: 'undo' | 'retry' | 'delete' | 'skip' | 'complete';
      result?: string;
    }) => {
      if (input.action === 'delete') return api.delete(`/agents/tasks/${input.taskId}`);
      if (input.action === 'undo' || input.action === 'retry') {
        return api.post(`/agents/tasks/${input.taskId}/${input.action}`);
      }
      return api.patch(`/agents/tasks/${input.taskId}`, {
        status: input.action === 'skip' ? 'skipped' : 'done',
        result: input.result,
      });
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: keys.run(variables.runId) });
      void queryClient.invalidateQueries({ queryKey: keys.runs() });
    },
  });
}

export function useAddTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      runId: number;
      tasks: Array<{ title: string; description?: string | null }>;
    }) => api.post(`/agents/runs/${input.runId}/tasks`, { tasks: input.tasks }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: keys.run(variables.runId) });
    },
  });
}

export function useReorderTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: number; orderedIds: number[] }) =>
      api.put(`/agents/runs/${input.runId}/tasks/order`, {
        orderedIds: input.orderedIds,
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: keys.run(variables.runId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Browser and usage
// ---------------------------------------------------------------------------

export function useBrowserCapabilities() {
  return useQuery({
    queryKey: keys.browser(),
    queryFn: () => api.get<BrowserCapabilities>('/browser/capabilities'),
  });
}

export function useUsage(days = 30) {
  return useQuery({
    queryKey: keys.usage(days),
    queryFn: () =>
      api.get<{
        days: number;
        buckets: UsageBucket[];
        totals: {
          calls: number;
          tokensIn: number;
          tokensOut: number;
          costEstimate: number | null;
          costComplete: boolean;
        };
      }>(`/usage?days=${days}`),
  });
}
