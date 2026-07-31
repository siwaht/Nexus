import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  Brain,
  GitBranch,
  Pencil,
  Quote,
  RefreshCw,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Volume2,
  Wrench,
} from 'lucide-react';

import { ArtifactChip } from '@/components/output/artifact-view';
import { Markdown } from '@/components/output/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { fileUrl } from '@/lib/api';
import type { Artifact, Message, ToolProgressEvent } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * One message in the thread.
 *
 * Assistant turns expose the full trail behind the answer: which tools ran,
 * what the reasoning trace said, which sources were cited, token counts and
 * latency. That transparency is the point — an answer you can't audit isn't
 * much better than a guess.
 */

function CollapsibleSection({
  icon,
  label,
  children,
  tone = 'muted',
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  tone?: 'muted' | 'warning';
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        'rounded-md border text-xs',
        tone === 'warning'
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-border bg-muted/20',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-muted/40"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
        />
        {icon}
        <span className="font-medium">{label}</span>
      </button>
      {open && <div className="border-t border-border/60 px-2.5 py-2">{children}</div>}
    </div>
  );
}

export interface MessageItemProps {
  message: Message;
  artifacts: Artifact[];
  isLast: boolean;
  streaming?: boolean;
  /** Live tool activity for the message currently being generated. */
  liveToolEvents?: ToolProgressEvent[];
  liveReasoning?: string;
  onRate: (rating: number) => void;
  onRegenerate: () => void;
  onEdit: (content: string) => void;
  onDelete: () => void;
  onBranch: () => void;
  onSpeak: () => void;
  onOpenArtifact: (artifact: Artifact) => void;
  onCiteClick: () => void;
}

export function MessageItem({
  message,
  artifacts,
  isLast,
  streaming = false,
  liveToolEvents = [],
  liveReasoning = '',
  onRate,
  onRegenerate,
  onEdit,
  onDelete,
  onBranch,
  onSpeak,
  onOpenArtifact,
  onCiteClick,
}: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  const isUser = message.role === 'user';
  const toolCalls = message.toolCallsJson ?? [];
  const citations = message.citationsJson ?? [];
  const attachments = message.attachmentsJson ?? [];
  const reasoning = message.reasoning ?? liveReasoning;
  const pendingApproval = toolCalls.some(
    (call) => call.status === 'pending-approval',
  );

  const copy = () => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  if (editing) {
    return (
      <div className="group flex flex-col gap-2" data-testid={`message-${message.id}`}>
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-24 resize-y"
          aria-label="Edit message"
          data-testid="textarea-edit-message"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              setEditing(false);
              onEdit(draft);
            }}
            data-testid="button-save-edit"
          >
            Send
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(message.content);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <article
      className={cn('group flex flex-col gap-2', isUser && 'items-end')}
      data-testid={`message-${message.id}`}
    >
      {/* Attachments */}
      {attachments.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', isUser && 'justify-end')}>
          {attachments.map((attachment, index) =>
            attachment.imageUrl ? (
              <img
                key={index}
                src={attachment.imageUrl}
                alt="Attached image"
                className="max-h-48 rounded-lg border border-border object-contain"
              />
            ) : attachment.fileId ? (
              <a
                key={index}
                href={fileUrl(attachment.fileId)}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-border bg-muted/30 px-2 py-1 text-xs hover:bg-muted"
              >
                Attached file #{attachment.fileId}
              </a>
            ) : null,
          )}
        </div>
      )}

      <div
        className={cn(
          isUser
            ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-primary-foreground'
            : 'w-full',
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {message.content}
          </p>
        ) : (
          <>
            {reasoning && (
              <div className="mb-2">
                <CollapsibleSection
                  icon={<Brain className="h-3.5 w-3.5" />}
                  label="Reasoning"
                >
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {reasoning}
                  </p>
                </CollapsibleSection>
              </div>
            )}

            {/* Tool activity: live while streaming, persisted afterwards. */}
            {(liveToolEvents.length > 0 || toolCalls.length > 0) && (
              <div className="mb-2 space-y-1.5">
                {liveToolEvents.length > 0 && streaming ? (
                  liveToolEvents.slice(-4).map((event, index) => (
                    <div
                      key={`${event.callId}-${index}`}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <Wrench
                        className={cn(
                          'h-3.5 w-3.5',
                          event.phase === 'started' && 'animate-pulse',
                        )}
                      />
                      <span className="font-mono">{event.toolName}</span>
                      <span className="truncate">
                        {event.phase === 'started'
                          ? 'running…'
                          : (event.message ?? event.phase)}
                      </span>
                    </div>
                  ))
                ) : (
                  <CollapsibleSection
                    icon={<Wrench className="h-3.5 w-3.5" />}
                    label={`${toolCalls.length} tool ${toolCalls.length === 1 ? 'call' : 'calls'}`}
                  >
                    <ul className="space-y-2">
                      {toolCalls.map((call) => (
                        <li key={call.id} className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono font-medium">{call.name}</span>
                            <Badge
                              variant={
                                call.status === 'error' ? 'destructive' : 'outline'
                              }
                              className="h-4 px-1 text-[10px]"
                            >
                              {call.status}
                            </Badge>
                          </div>
                          {call.result && (
                            <p className="whitespace-pre-wrap break-words text-muted-foreground">
                              {call.result.slice(0, 600)}
                              {call.result.length > 600 && '…'}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </CollapsibleSection>
                )}
              </div>
            )}

            {pendingApproval && (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs">
                <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500" />
                <span>Waiting on tool approval.</span>
              </div>
            )}

            {message.content ? (
              <Markdown>{message.content}</Markdown>
            ) : streaming ? (
              <div className="flex items-center gap-1.5 py-1" aria-label="Thinking">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
              </div>
            ) : null}

            {message.error && (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{message.error}</span>
              </div>
            )}

            {artifacts.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {artifacts.map((artifact) => (
                  <ArtifactChip
                    key={artifact.id}
                    artifact={artifact}
                    onOpen={() => onOpenArtifact(artifact)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer: sources, metadata, actions */}
      {!isUser && !streaming && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {citations.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={onCiteClick}
              data-testid="button-view-sources"
            >
              <Quote className="h-3.5 w-3.5" />
              {citations.length} {citations.length === 1 ? 'source' : 'sources'}
            </Button>
          )}

          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={copy}
              aria-label="Copy message"
              data-testid="button-copy-message"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
            {isLast && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onRegenerate}
                aria-label="Regenerate response"
                data-testid="button-regenerate"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onSpeak}
              aria-label="Read aloud"
              data-testid="button-speak"
            >
              <Volume2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onBranch}
              aria-label="Branch from here"
              data-testid="button-branch"
            >
              <GitBranch className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7', message.rating === 1 && 'text-primary')}
              onClick={() => onRate(message.rating === 1 ? 0 : 1)}
              aria-label="Good response"
              data-testid="button-thumbs-up"
            >
              <ThumbsUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7', message.rating === -1 && 'text-destructive')}
              onClick={() => onRate(message.rating === -1 ? 0 : -1)}
              aria-label="Bad response"
              data-testid="button-thumbs-down"
            >
              <ThumbsDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onDelete}
              aria-label="Delete message"
              data-testid="button-delete-message"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          <span className="ml-auto flex items-center gap-2 font-mono text-[11px]">
            {message.modelRef && (
              <span className="max-w-[220px] truncate" title={message.modelRef}>
                {message.modelRef.split(':').pop()}
              </span>
            )}
            {message.tokenCounts &&
              (message.tokenCounts.tokensIn || message.tokenCounts.tokensOut) && (
                <span>
                  {message.tokenCounts.tokensIn ?? 0}↓ {message.tokenCounts.tokensOut ?? 0}↑
                </span>
              )}
            {message.latencyMs !== null && (
              <span>{(message.latencyMs / 1000).toFixed(1)}s</span>
            )}
          </span>
        </div>
      )}

      {isUser && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          onClick={() => setEditing(true)}
          data-testid="button-edit-message"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
      )}
    </article>
  );
}
