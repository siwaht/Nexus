import { useMemo, useState } from 'react';
import {
  Check,
  ChevronsUpDown,
  Eye,
  Image as ImageIcon,
  Loader2,
  Mic,
  RefreshCw,
  Volume2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useToast } from '@/hooks/use-toast';
import { useModels, useRefreshCatalogue } from '@/lib/queries';
import type { CatalogueModel, ModelTask } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Searchable model picker, grouped by provider and filtered by task.
 *
 * The catalogue comes from the live provider APIs. When it's empty the picker
 * says so and offers the refresh rather than silently showing nothing.
 */

const PROVIDER_LABELS: Record<string, string> = {
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  'cloudflare-ai-gateway': 'Cloudflare AI Gateway',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'google-ai-studio': 'Google AI Studio',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  custom: 'Custom endpoint',
};

export function providerLabel(providerName: string): string {
  return PROVIDER_LABELS[providerName] ?? providerName;
}

export function formatContextWindow(tokens: number | null): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`;
  return `${tokens} ctx`;
}

function ModalityBadges({ model }: { model: CatalogueModel }) {
  const icons: React.ReactNode[] = [];
  if (model.modalities.includes('image') || model.task === 'Image-to-Text') {
    icons.push(<Eye key="vision" className="h-3 w-3" aria-label="Vision" />);
  }
  if (model.task === 'Text-to-Image') {
    icons.push(<ImageIcon key="image" className="h-3 w-3" aria-label="Image output" />);
  }
  if (model.task === 'Automatic Speech Recognition') {
    icons.push(<Mic key="audio" className="h-3 w-3" aria-label="Transcription" />);
  }
  if (model.task === 'Text-to-Speech') {
    icons.push(<Volume2 key="tts" className="h-3 w-3" aria-label="Speech" />);
  }
  if (icons.length === 0) return null;
  return <span className="flex items-center gap-1 text-muted-foreground">{icons}</span>;
}

export interface ModelPickerProps {
  value: string | null;
  onChange: (modelRef: string) => void;
  task?: ModelTask;
  /** Show a compact trigger for the top bar. */
  compact?: boolean;
  placeholder?: string;
  allowClear?: boolean;
  className?: string;
}

export function ModelPicker({
  value,
  onChange,
  task = 'Text Generation',
  compact = false,
  placeholder = 'Select a model',
  allowClear = false,
  className,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const { toast } = useToast();
  const { data, isLoading } = useModels(showAllTasks ? undefined : task);
  const refresh = useRefreshCatalogue();

  const models = useMemo(
    () => (data?.models ?? []).filter((model) => model.enabled),
    [data],
  );

  const selected = models.find((model) => model.modelRef === value);

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogueModel[]>();
    for (const model of models) {
      const list = map.get(model.providerName) ?? [];
      list.push(model);
      map.set(model.providerName, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.experimental !== b.experimental) return a.experimental ? 1 : -1;
        return a.displayName.localeCompare(b.displayName);
      });
    }
    return [...map.entries()].sort((a, b) =>
      providerLabel(a[0]).localeCompare(providerLabel(b[0])),
    );
  }, [models]);

  const handleRefresh = () => {
    refresh.mutate(undefined, {
      onSuccess: (result) => {
        const failed = result.outcomes.filter((outcome) => !outcome.ok);
        toast({
          title: `${result.total} models loaded`,
          description:
            failed.length > 0
              ? failed.map((outcome) => outcome.message).join(' · ')
              : result.outcomes.map((outcome) => outcome.message).join(' · '),
          variant: failed.length > 0 && result.total === 0 ? 'destructive' : undefined,
        });
      },
      onError: (err: unknown) => {
        toast({
          variant: 'destructive',
          title: 'Could not refresh the catalogue',
          description: err instanceof Error ? err.message : undefined,
        });
      },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={compact ? 'ghost' : 'outline'}
          size={compact ? 'sm' : 'default'}
          role="combobox"
          aria-expanded={open}
          className={cn(
            'justify-between gap-2',
            compact ? 'max-w-[240px] font-mono text-xs' : 'w-full',
            className,
          )}
          data-testid="button-model-picker"
        >
          <span className="truncate">
            {selected ? selected.displayName : (value ?? placeholder)}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[420px] p-0" align="end">
        <Command>
          <CommandInput placeholder="Search models..." data-testid="input-model-search" />
          <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setShowAllTasks((current) => !current)}
            >
              {showAllTasks ? `Only ${task}` : 'All tasks'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={handleRefresh}
              disabled={refresh.isPending}
              data-testid="button-refresh-catalogue"
            >
              {refresh.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
          </div>

          <CommandList className="max-h-[360px]">
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!isLoading && models.length === 0 && (
              <CommandEmpty>
                <div className="space-y-2 px-4 py-6 text-center">
                  <p className="text-sm">No models yet.</p>
                  <p className="text-xs text-muted-foreground">
                    Connect a provider in Settings, then refresh the catalogue.
                  </p>
                </div>
              </CommandEmpty>
            )}

            {allowClear && value && (
              <CommandGroup>
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onChange('');
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground">Use the default</span>
                </CommandItem>
              </CommandGroup>
            )}

            {grouped.map(([provider, list]) => (
              <CommandGroup key={provider} heading={providerLabel(provider)}>
                {list.map((model) => (
                  <CommandItem
                    key={model.modelRef}
                    value={`${model.displayName} ${model.modelId} ${provider}`}
                    onSelect={() => {
                      onChange(model.modelRef);
                      setOpen(false);
                    }}
                    className="flex items-start gap-2"
                    data-testid={`item-model-${model.modelRef}`}
                  >
                    <Check
                      className={cn(
                        'mt-0.5 h-4 w-4 shrink-0',
                        model.modelRef === value ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm">{model.displayName}</span>
                        <ModalityBadges model={model} />
                        {model.experimental && (
                          <Badge variant="outline" className="h-4 px-1 text-[10px]">
                            beta
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="truncate font-mono">{model.modelId}</span>
                        {formatContextWindow(model.contextWindow) && (
                          <span className="shrink-0">
                            {formatContextWindow(model.contextWindow)}
                          </span>
                        )}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
