import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { AlertTriangle, ArrowRight, KeyRound, Sparkles } from 'lucide-react';

import { Composer, type Attachment, type ComposerSettings } from '@/components/chat/composer';
import { MessageItem } from '@/components/chat/message-item';
import { ModelPicker } from '@/components/chat/model-picker';
import { SourcesPanel } from '@/components/chat/sources-panel';
import { ToolApproval } from '@/components/chat/tool-approval';
import { ArtifactPanel } from '@/components/output/artifact-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useChatStream } from '@/hooks/use-chat-stream';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import {
  useBranchConversation,
  useConversation,
  useCreateConversation,
  useDeleteMessage,
  useRateMessage,
  useSettings,
  useSkills,
  useUpdateConversation,
} from '@/lib/queries';
import type { Artifact, Citation, Message } from '@/lib/types';

/**
 * The chat screen.
 *
 * Left is the thread, right is a toggleable panel that shows either the sources
 * behind the current answer or an artifact. The streaming buffer is rendered as
 * a provisional message until the turn finishes, then the persisted transcript
 * takes over — so there's no duplicate flash when the stream ends.
 */

const DEFAULT_SETTINGS: ComposerSettings = {
  temperature: 0.7,
  maxTokens: 4000,
  topP: 1,
  useLibrary: false,
  webSearch: false,
  toolsEnabled: true,
  skillId: null,
};

export interface ChatPageProps {
  conversationId: number | null;
  onConversationCreated: (id: number) => void;
  onOpenLibrary: (fileId?: number) => void;
  onOpenAgents: () => void;
}

export default function ChatPage({
  conversationId,
  onConversationCreated,
  onOpenLibrary,
  onOpenAgents,
}: ChatPageProps) {
  const { toast } = useToast();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [settings, setSettings] = useState<ComposerSettings>(DEFAULT_SETTINGS);
  const [panel, setPanel] = useState<
    { kind: 'sources'; citations: Citation[] } | { kind: 'artifact'; artifact: Artifact } | null
  >(null);
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const { data: settingsData } = useSettings();
  const { data: skillsData } = useSkills();
  const { data: detail, isLoading } = useConversation(conversationId);
  const createConversation = useCreateConversation();
  const updateConversation = useUpdateConversation();
  const rateMessage = useRateMessage();
  const deleteMessage = useDeleteMessage();
  const branchConversation = useBranchConversation();

  const chat = useChatStream(conversationId);

  const hasProvider = (settingsData?.connectedProviders?.length ?? 0) > 0;
  const messages = detail?.messages ?? [];
  const artifacts = detail?.artifacts ?? [];
  const conversation = detail?.conversation;

  const modelRef = conversation?.modelRef ?? settingsData?.settings.defaultChatModel ?? null;

  // Adopt the conversation's stored toggles when switching threads.
  useEffect(() => {
    if (!conversation) return;
    setSettings((current) => ({
      ...current,
      useLibrary: conversation.useLibrary,
      webSearch: conversation.webSearch,
      toolsEnabled: conversation.toolsEnabled,
      skillId: conversation.skillId,
    }));
  }, [conversation?.id]);

  const artifactsByMessage = useMemo(() => {
    const map = new Map<number, Artifact[]>();
    for (const artifact of artifacts) {
      if (artifact.messageId === null) continue;
      const list = map.get(artifact.messageId) ?? [];
      list.push(artifact);
      map.set(artifact.messageId, list);
    }
    return map;
  }, [artifacts]);

  // Stay pinned to the bottom while streaming, unless the user scrolled up.
  const scrollToBottom = useCallback((smooth = false) => {
    const viewport = scrollRef.current?.querySelector<HTMLElement>(
      '[data-radix-scroll-area-viewport]',
    );
    if (!viewport) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }, []);

  useEffect(() => {
    const viewport = scrollRef.current?.querySelector<HTMLElement>(
      '[data-radix-scroll-area-viewport]',
    );
    if (!viewport) return;
    const onScroll = () => {
      const distance =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      pinnedToBottom.current = distance < 120;
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [conversationId]);

  useEffect(() => {
    if (pinnedToBottom.current) scrollToBottom();
  }, [messages.length, chat.state.text, scrollToBottom]);

  // Esc stops generation, but only when focus isn't inside a text field —
  // otherwise it would fight with closing a popover or clearing an input.
  useEffect(() => {
    if (!chat.streaming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (inField) return;
      event.preventDefault();
      chat.stop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [chat.streaming, chat.stop]);

  const ensureConversation = async (): Promise<number | null> => {
    if (conversationId) return conversationId;
    const created = await createConversation
      .mutateAsync({
        modelRef,
        useLibrary: settings.useLibrary,
        webSearch: settings.webSearch,
        toolsEnabled: settings.toolsEnabled,
        skillId: settings.skillId,
      } as never)
      .catch(() => null);
    if (!created) {
      toast({ variant: 'destructive', title: 'Could not start a conversation' });
      return null;
    }
    onConversationCreated(created.conversation.id);
    return created.conversation.id;
  };

  const handleSend = async () => {
    const content = input.trim();
    if (!content && attachments.length === 0) return;

    const target = await ensureConversation();
    if (!target) return;

    // Creating a thread and streaming into it are separate steps; if the id
    // just changed, let the hook rebind before sending.
    if (target !== conversationId) {
      setInput('');
      setAttachments([]);
      // The parent re-renders with the new id and the effect below sends.
      pendingSendRef.current = {
        content,
        attachments: attachments.map(toWireAttachment),
      };
      return;
    }

    setInput('');
    setAttachments([]);
    pinnedToBottom.current = true;
    await chat.send({
      content,
      attachments: attachments.map(toWireAttachment),
      modelRef,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      topP: settings.topP,
      skillId: settings.skillId,
      useLibrary: settings.useLibrary,
      webSearch: settings.webSearch,
      toolsEnabled: settings.toolsEnabled,
    });
  };

  // Deferred first message for a freshly created conversation.
  const pendingSendRef = useRef<{
    content: string;
    attachments: Array<{ imageUrl?: string; text?: string; fileId?: number }>;
  } | null>(null);

  useEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending || !conversationId) return;
    pendingSendRef.current = null;
    void chat.send({
      ...pending,
      modelRef,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      topP: settings.topP,
      skillId: settings.skillId,
      useLibrary: settings.useLibrary,
      webSearch: settings.webSearch,
      toolsEnabled: settings.toolsEnabled,
    });
  }, [conversationId]);

  const handleTranscribe = async (audio: Blob): Promise<string> => {
    // Uploading to the Library gives the transcript a permanent home and reuses
    // the same ingestion path as any other audio file.
    const form = new FormData();
    form.append('files', audio, `voice-${Date.now()}.webm`);
    const uploaded = await api.upload<{
      accepted: Array<{ id: number }>;
      rejected: Array<{ filename: string; reason: string }>;
    }>('/files', form);
    const fileId = uploaded.accepted[0]?.id;
    if (!fileId) {
      throw new Error(uploaded.rejected[0]?.reason ?? 'The recording was rejected.');
    }

    // Poll until ingestion finishes, then read the transcript back.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { file } = await api.get<{ file: { status: string; error: string | null } }>(
        `/files/${fileId}`,
      );
      if (file.status === 'ready') {
        const { file: ready } = await api.get<{
          file: { extractedText: string | null };
        }>(`/files/${fileId}`);
        return (ready.extractedText ?? '').trim();
      }
      if (file.status === 'failed') {
        throw new Error(file.error ?? 'Transcription failed.');
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Transcription is taking too long — check the Library.');
  };

  /**
   * "Read aloud" routes through the speak_text tool so the audio lands as an
   * artifact on a real message, playable and downloadable like any other.
   */
  const handleSpeak = async (message: Message) => {
    if (!conversationId) return;
    toast({ title: 'Generating audio…' });
    await chat.send({
      content: `Use the speak_text tool to read this aloud verbatim, then reply with just "Done.":\n\n${message.content.slice(0, 4000)}`,
      toolsEnabled: true,
    });
  };

  // The provisional assistant message rendered while a turn streams.
  const streamingMessage: Message | null =
    chat.streaming || chat.state.text || chat.pendingApprovals.length > 0
      ? {
          id: chat.state.messageId ?? -1,
          conversationId: conversationId ?? 0,
          role: 'assistant',
          content: chat.state.text,
          reasoning: chat.state.reasoning || null,
          attachmentsJson: null,
          toolCallsJson: null,
          citationsJson: chat.state.citations.length > 0 ? chat.state.citations : null,
          modelRef: chat.state.modelRef,
          tokenCounts: {
            tokensIn: chat.state.tokensIn,
            tokensOut: chat.state.tokensOut,
          },
          latencyMs: null,
          rating: null,
          parentMessageId: null,
          agentRunId: null,
          finishReason: null,
          error: null,
          createdAt: new Date().toISOString(),
        }
      : null;

  // Once persisted, drop the provisional copy of the same message.
  const persistedIds = new Set(messages.map((message) => message.id));
  const showStreaming =
    streamingMessage !== null &&
    (streamingMessage.id === -1 || !persistedIds.has(streamingMessage.id));

  if (!hasProvider) {
    return <GettingStarted />;
  }

  return (
    <div
      className="flex h-full min-h-0"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const files = Array.from(event.dataTransfer.files);
        const images = files.filter((file) => file.type.startsWith('image/'));
        const others = files.filter((file) => !file.type.startsWith('image/'));
        if (others.length > 0) {
          toast({
            title: 'Sent to the Library',
            description: `${others.length} file${others.length === 1 ? '' : 's'} queued for ingestion.`,
          });
          const form = new FormData();
          for (const file of others) form.append('files', file);
          void api.upload('/files', form);
        }
        if (images.length > 0) {
          void Promise.all(
            images.map(
              (file) =>
                new Promise<Attachment | null>((resolve) => {
                  const reader = new FileReader();
                  reader.onload = () =>
                    resolve({
                      id: `${file.name}-${Date.now()}`,
                      name: file.name,
                      imageUrl: String(reader.result),
                      size: file.size,
                    });
                  reader.onerror = () => resolve(null);
                  reader.readAsDataURL(file);
                }),
            ),
          ).then((results) => {
            setAttachments((current) => [
              ...current,
              ...results.filter((item): item is Attachment => item !== null),
            ]);
          });
        }
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top strip: model picker + thread toggles */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <ModelPicker
            value={modelRef}
            onChange={(next) => {
              if (conversationId) {
                updateConversation.mutate({ id: conversationId, modelRef: next });
              }
            }}
            compact
          />
          {chat.state.contextInfo && (
            <span className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
              {chat.state.contextInfo.facts > 0 && (
                <span>{chat.state.contextInfo.facts} facts</span>
              )}
              {chat.state.contextInfo.recalled > 0 && (
                <span>{chat.state.contextInfo.recalled} recalled</span>
              )}
              {chat.state.contextInfo.summarized && <span>summarized</span>}
            </span>
          )}
          <div className="flex-1" />
          {detail?.summaries && detail.summaries.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {detail.summaries.length} summarized{' '}
              {detail.summaries.length === 1 ? 'block' : 'blocks'}
            </span>
          )}
        </div>

        <ScrollArea ref={scrollRef} className="flex-1">
          <div
            className="mx-auto w-full max-w-3xl px-4 py-6"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nexus-message-gap, 1.25rem)' }}
            aria-live="polite"
            aria-atomic="false"
          >
            {isLoading && conversationId && (
              <div className="space-y-4" aria-busy="true">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="space-y-2">
                    <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                    <div className="h-16 animate-pulse rounded bg-muted/60" />
                  </div>
                ))}
              </div>
            )}

            {!isLoading && messages.length === 0 && !showStreaming && (
              <EmptyThread onOpenAgents={onOpenAgents} />
            )}

            {detail?.summaries?.map((summary) => (
              <details
                key={summary.id}
                className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs"
              >
                <summary className="cursor-pointer font-medium text-muted-foreground">
                  Summarized earlier messages
                </summary>
                <p className="mt-2 whitespace-pre-wrap leading-relaxed">
                  {summary.text}
                </p>
              </details>
            ))}

            {messages
              .filter((message) => message.role === 'user' || message.role === 'assistant')
              .map((message, index, list) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  artifacts={artifactsByMessage.get(message.id) ?? []}
                  isLast={index === list.length - 1 && !showStreaming}
                  onRate={(rating) =>
                    conversationId &&
                    rateMessage.mutate({
                      conversationId,
                      messageId: message.id,
                      rating,
                    })
                  }
                  onRegenerate={() => void chat.regenerate(message.id)}
                  onEdit={(content) => {
                    if (!conversationId) return;
                    // Edit-and-resend: drop this turn onward, then resend.
                    deleteMessage.mutate(
                      { conversationId, messageId: message.id, cascade: true },
                      {
                        onSuccess: () => {
                          void chat.send({
                            content,
                            modelRef,
                            temperature: settings.temperature,
                          });
                        },
                      },
                    );
                  }}
                  onDelete={() =>
                    conversationId &&
                    deleteMessage.mutate({ conversationId, messageId: message.id })
                  }
                  onBranch={() => {
                    if (!conversationId) return;
                    branchConversation.mutate(
                      { id: conversationId, fromMessageId: message.id },
                      {
                        onSuccess: (result) => {
                          onConversationCreated(result.conversation.id);
                          toast({
                            title: 'Branched',
                            description: `${result.copiedMessages} messages copied.`,
                          });
                        },
                      },
                    );
                  }}
                  onSpeak={() => void handleSpeak(message)}
                  onOpenArtifact={(artifact) => setPanel({ kind: 'artifact', artifact })}
                  onCiteClick={() =>
                    setPanel({
                      kind: 'sources',
                      citations: message.citationsJson ?? [],
                    })
                  }
                />
              ))}

            {showStreaming && streamingMessage && (
              <MessageItem
                message={streamingMessage}
                artifacts={chat.state.artifacts}
                isLast
                streaming={chat.streaming}
                liveToolEvents={chat.state.toolEvents}
                liveReasoning={chat.state.reasoning}
                onRate={() => undefined}
                onRegenerate={() => void chat.regenerate()}
                onEdit={() => undefined}
                onDelete={() => undefined}
                onBranch={() => undefined}
                onSpeak={() => undefined}
                onOpenArtifact={(artifact) => setPanel({ kind: 'artifact', artifact })}
                onCiteClick={() =>
                  setPanel({ kind: 'sources', citations: chat.state.citations })
                }
              />
            )}

            {chat.pendingApprovals.length > 0 && (
              <ToolApproval
                calls={chat.pendingApprovals}
                busy={chat.streaming}
                onResolve={(approvals) => void chat.resolveApprovals(approvals)}
              />
            )}

            {chat.state.savedFacts.length > 0 && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" />
                Remembered: {chat.state.savedFacts.map((fact) => fact.text).join(' · ')}
              </div>
            )}

            {chat.error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-destructive">{chat.error.message}</p>
                  {chat.error.hint && (
                    <p className="mt-1 text-xs text-destructive/80">{chat.error.hint}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                    <Link href="/settings/providers">Fix in Settings</Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={chat.dismissError}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <Composer
          value={input}
          onChange={setInput}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          settings={settings}
          onSettingsChange={(next) => {
            setSettings(next);
            if (conversationId) {
              updateConversation.mutate({
                id: conversationId,
                useLibrary: next.useLibrary,
                webSearch: next.webSearch,
                toolsEnabled: next.toolsEnabled,
                skillId: next.skillId,
              });
            }
          }}
          skills={skillsData?.skills ?? []}
          streaming={chat.streaming}
          onSend={() => void handleSend()}
          onStop={chat.stop}
          onTranscribe={handleTranscribe}
        />
      </div>

      {panel && (
        <div className="hidden w-[400px] shrink-0 lg:block">
          {panel.kind === 'sources' ? (
            <SourcesPanel
              citations={panel.citations}
              onClose={() => setPanel(null)}
              onOpenFile={(fileId) => {
                setPanel(null);
                onOpenLibrary(fileId);
              }}
            />
          ) : (
            <ArtifactPanel artifact={panel.artifact} onClose={() => setPanel(null)} />
          )}
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary px-8 py-6 text-center">
            <p className="font-medium">Drop files here</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Images attach to the message; everything else goes to the Library.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function toWireAttachment(attachment: Attachment) {
  return {
    ...(attachment.imageUrl ? { imageUrl: attachment.imageUrl } : {}),
    ...(attachment.text ? { text: attachment.text } : {}),
    ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
  };
}

function EmptyThread({ onOpenAgents }: { onOpenAgents: () => void }) {
  return (
    <div className="py-12 text-center">
      <h2 className="text-xl font-semibold">What are we working on?</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Ask anything. Turn on Library to search your uploaded files, or hand a
        big job to a team of agents.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-4 gap-2"
        onClick={onOpenAgents}
        data-testid="button-empty-agents"
      >
        Run a multi-agent task
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function GettingStarted() {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <Card className="w-full max-w-xl border-card-border">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10">
            <KeyRound className="h-7 w-7 text-primary" />
          </div>
          <CardTitle className="text-2xl">Connect a provider</CardTitle>
          <CardDescription className="text-base leading-relaxed">
            Nexus needs at least one model provider before it can do anything.
            Your keys stay on the server — the browser never sees them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 rounded-lg border border-border bg-muted p-4">
            <h3 className="text-sm font-medium">Cloudflare Workers AI</h3>
            <ul className="list-inside list-disc space-y-1.5 text-sm text-muted-foreground">
              <li>
                <span className="font-mono text-xs">Account ID</span> — dashboard
                sidebar, or the Workers AI page
              </li>
              <li>
                <span className="font-mono text-xs">API Token</span> — Workers AI →
                Use REST API → Create a Workers AI API Token
              </li>
            </ul>
          </div>
          <Button asChild className="h-11 w-full gap-2 font-medium">
            <Link href="/settings/providers" data-testid="button-configure-provider">
              Configure provider
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
