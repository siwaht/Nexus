import { useEffect, useRef, useState } from 'react';
import {
  FileText,
  Library,
  Loader2,
  Mic,
  Paperclip,
  Send,
  Settings2,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import type { Skill } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The composer.
 *
 * Auto-growing textarea, Enter to send / Shift+Enter for newline, paste-image
 * support, drag-and-drop, a mic button that records and transcribes, and a
 * popover for sampling parameters. Retrieval, web search and tool use are
 * toggles here because they change what the next turn is allowed to do.
 */

export interface Attachment {
  id: string;
  name: string;
  /** Data URL for images; text content for pasted text. */
  imageUrl?: string;
  text?: string;
  fileId?: number;
  size: number;
}

export interface ComposerSettings {
  temperature: number;
  maxTokens: number;
  topP: number;
  useLibrary: boolean;
  webSearch: boolean;
  toolsEnabled: boolean;
  skillId: number | null;
}

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  attachments: Attachment[];
  onAttachmentsChange: (attachments: Attachment[]) => void;
  settings: ComposerSettings;
  onSettingsChange: (settings: ComposerSettings) => void;
  skills: Skill[];
  streaming: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSend: () => void;
  onStop: () => void;
  /** Records audio and returns the transcript to drop into the input. */
  onTranscribe?: (audio: Blob) => Promise<string>;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function Composer({
  value,
  onChange,
  attachments,
  onAttachmentsChange,
  settings,
  onSettingsChange,
  skills,
  streaming,
  disabled = false,
  disabledReason,
  onSend,
  onStop,
  onTranscribe,
}: ComposerProps) {
  const { toast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);

  // Auto-grow up to a cap, then scroll.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 260)}px`;
  }, [value]);

  const addImageFiles = async (files: File[]) => {
    const next: Attachment[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        toast({
          title: 'Not attached',
          description: `${file.name} isn't an image. Upload it to the Library instead, then use "Use my library".`,
        });
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast({
          variant: 'destructive',
          title: 'Image too large',
          description: `${file.name} is over 8 MB.`,
        });
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsDataURL(file);
      }).catch(() => null);
      if (!dataUrl) continue;
      next.push({
        id: `${file.name}-${Date.now()}-${next.length}`,
        name: file.name,
        imageUrl: dataUrl,
        size: file.size,
      });
    }
    if (next.length > 0) onAttachmentsChange([...attachments, ...next]);
  };

  const startRecording = async () => {
    if (!onTranscribe) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        setRecording(false);
        setTranscribing(true);
        void onTranscribe(blob)
          .then((text) => {
            if (text) onChange(value ? `${value} ${text}` : text);
          })
          .catch((err: unknown) => {
            toast({
              variant: 'destructive',
              title: 'Transcription failed',
              description: err instanceof Error ? err.message : undefined,
            });
          })
          .finally(() => setTranscribing(false));
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      toast({
        variant: 'destructive',
        title: 'Microphone unavailable',
        description: 'Grant microphone permission to use voice input.',
      });
    }
  };

  const canSend = !disabled && !streaming && (value.trim() || attachments.length > 0);

  return (
    <div className="relative shrink-0 px-3 pb-3 pt-1">
      {/* Fades the thread out behind the composer instead of a hard rule. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-background to-transparent"
      />

      <div className="mx-auto w-full max-w-3xl">
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex animate-[fade-up_0.25s_ease-out] items-center gap-1.5 rounded-full border border-border bg-muted/50 py-1 pl-1.5 pr-1 text-xs shadow-xs"
              >
                {attachment.imageUrl ? (
                  <img
                    src={attachment.imageUrl}
                    alt=""
                    className="h-6 w-6 rounded object-cover"
                  />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                <span className="max-w-32 truncate">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    onAttachmentsChange(
                      attachments.filter((item) => item.id !== attachment.id),
                    )
                  }
                  className="rounded p-0.5 hover:bg-muted"
                  aria-label={`Remove ${attachment.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="relative rounded-2xl border border-border/80 bg-card shadow-md transition-all duration-200 focus-within:border-primary/40 focus-within:shadow-glow">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (canSend) onSend();
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length > 0) {
                event.preventDefault();
                void addImageFiles(files);
              }
            }}
            placeholder={
              disabled
                ? (disabledReason ?? 'Unavailable')
                : 'Send a message. Shift+Enter for a new line.'
            }
            disabled={disabled}
            rows={1}
            aria-label="Message"
            className="min-h-[54px] resize-none border-0 bg-transparent px-4 pb-11 pt-3.5 text-[0.9375rem] leading-relaxed shadow-none focus-visible:ring-0"
            data-testid="textarea-message"
          />

          {/* Bottom toolbar */}
          <div className="absolute inset-x-2 bottom-2 flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                void addImageFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled}
                  aria-label="Attach an image"
                  data-testid="button-attach"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach an image</TooltipContent>
            </Tooltip>

            {onTranscribe && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn('h-8 w-8', recording && 'text-destructive')}
                    onClick={() => {
                      if (recording) recorderRef.current?.stop();
                      else void startRecording();
                    }}
                    disabled={disabled || transcribing}
                    aria-label={recording ? 'Stop recording' : 'Record voice input'}
                    data-testid="button-mic"
                  >
                    {transcribing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : recording ? (
                      <Square className="h-4 w-4 animate-pulse" />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {recording ? 'Stop and transcribe' : 'Voice input'}
                </TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  size="sm"
                  pressed={settings.useLibrary}
                  onPressedChange={(pressed) =>
                    onSettingsChange({ ...settings, useLibrary: pressed })
                  }
                  className="h-8 gap-1.5 px-2 text-xs"
                  aria-label="Use my library"
                  data-testid="toggle-library"
                >
                  <Library className="h-3.5 w-3.5" />
                  Library
                </Toggle>
              </TooltipTrigger>
              <TooltipContent>
                Search your uploaded files and cite them
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  size="sm"
                  pressed={settings.toolsEnabled}
                  onPressedChange={(pressed) =>
                    onSettingsChange({ ...settings, toolsEnabled: pressed })
                  }
                  className="h-8 gap-1.5 px-2 text-xs"
                  aria-label="Enable tools"
                  data-testid="toggle-tools"
                >
                  <Wrench className="h-3.5 w-3.5" />
                  Tools
                </Toggle>
              </TooltipTrigger>
              <TooltipContent>Let the model use tools and MCP servers</TooltipContent>
            </Tooltip>

            {skills.length > 0 && (
              <Select
                value={settings.skillId ? String(settings.skillId) : 'none'}
                onValueChange={(next) =>
                  onSettingsChange({
                    ...settings,
                    skillId: next === 'none' ? null : Number(next),
                  })
                }
              >
                <SelectTrigger
                  className="h-8 w-auto gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent"
                  aria-label="Skill"
                  data-testid="select-skill"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <SelectValue placeholder="Skill" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No skill</SelectItem>
                  {skills
                    .filter((skill) => skill.enabled)
                    .map((skill) => (
                      <SelectItem key={skill.id} value={String(skill.id)}>
                        {skill.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}

            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Sampling settings"
                  data-testid="button-sampling"
                >
                  <Settings2 className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 space-y-4" align="start">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Temperature</Label>
                    <span className="font-mono text-xs text-muted-foreground">
                      {settings.temperature.toFixed(2)}
                    </span>
                  </div>
                  <Slider
                    value={[settings.temperature]}
                    min={0}
                    max={2}
                    step={0.05}
                    onValueChange={([next]) =>
                      onSettingsChange({ ...settings, temperature: next })
                    }
                    aria-label="Temperature"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Max tokens</Label>
                    <span className="font-mono text-xs text-muted-foreground">
                      {settings.maxTokens}
                    </span>
                  </div>
                  <Slider
                    value={[settings.maxTokens]}
                    min={256}
                    max={16_000}
                    step={256}
                    onValueChange={([next]) =>
                      onSettingsChange({ ...settings, maxTokens: next })
                    }
                    aria-label="Max tokens"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Top P</Label>
                    <span className="font-mono text-xs text-muted-foreground">
                      {settings.topP.toFixed(2)}
                    </span>
                  </div>
                  <Slider
                    value={[settings.topP]}
                    min={0.05}
                    max={1}
                    step={0.05}
                    onValueChange={([next]) =>
                      onSettingsChange({ ...settings, topP: next })
                    }
                    aria-label="Top P"
                  />
                </div>
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <Label htmlFor="composer-web-search" className="text-xs">
                    Prefer web search
                  </Label>
                  <Switch
                    id="composer-web-search"
                    checked={settings.webSearch}
                    onCheckedChange={(checked) =>
                      onSettingsChange({ ...settings, webSearch: checked })
                    }
                  />
                </div>
              </PopoverContent>
            </Popover>

            <div className="flex-1" />

            {streaming ? (
              <Button
                size="sm"
                variant="destructive"
                className="h-8 gap-1.5"
                onClick={onStop}
                data-testid="button-stop"
              >
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            ) : (
              <Button
                size="icon"
                className={cn(
                  'h-8 w-8 rounded-lg transition-all duration-200',
                  canSend && 'shadow-sm hover:scale-105',
                )}
                onClick={onSend}
                disabled={!canSend}
                aria-label="Send message"
                data-testid="button-send"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 px-1">
          <p className="text-[11px] text-muted-foreground">
            {disabled ? (
              disabledReason
            ) : (
              <>
                <kbd className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px]">
                  Enter
                </kbd>{' '}
                to send ·{' '}
                <kbd className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px]">
                  Shift+Enter
                </kbd>{' '}
                for a new line
              </>
            )}
          </p>
          {settings.useLibrary && (
            <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]">
              <Library className="h-3 w-3" />
              Library search on
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}
