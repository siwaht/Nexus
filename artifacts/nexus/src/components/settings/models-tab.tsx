import { useMemo, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';

import { ModelPicker, formatContextWindow, providerLabel } from '@/components/chat/model-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  useModels,
  useRefreshCatalogue,
  useSetModelEnabled,
  useSettings,
  useUpdateSettings,
} from '@/lib/queries';
import type { ModelTask, UserSettings } from '@/lib/types';

/**
 * Settings → Models.
 *
 * Refresh the catalogue from each provider's live API, set a default per task,
 * and disable individual models so they stop cluttering the picker.
 */

const TASK_SLOTS: Array<{
  key: keyof UserSettings;
  label: string;
  description: string;
  task: ModelTask;
}> = [
  {
    key: 'defaultChatModel',
    label: 'Chat',
    description: 'Used for conversations, planning and summarization.',
    task: 'Text Generation',
  },
  {
    key: 'defaultVisionModel',
    label: 'Vision',
    description: 'Reads images and captions video frames.',
    task: 'Image-to-Text',
  },
  {
    key: 'defaultTranscriptionModel',
    label: 'Transcription',
    description: 'Turns audio and video into text with timestamps.',
    task: 'Automatic Speech Recognition',
  },
  {
    key: 'defaultEmbeddingModel',
    label: 'Embeddings',
    description: 'Powers library search and memory recall.',
    task: 'Text Embeddings',
  },
  {
    key: 'defaultRerankModel',
    label: 'Reranking',
    description: 'Optional. Sharpens retrieval by re-ordering candidates.',
    task: 'Reranking',
  },
  {
    key: 'defaultImageModel',
    label: 'Image generation',
    description: 'Creates images from a prompt.',
    task: 'Text-to-Image',
  },
  {
    key: 'defaultTtsModel',
    label: 'Text to speech',
    description: 'Reads answers aloud.',
    task: 'Text-to-Speech',
  },
];

export function ModelsTab() {
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const { data: settingsData, isLoading: settingsLoading } = useSettings();
  const { data: modelsData, isLoading: modelsLoading } = useModels();
  const refresh = useRefreshCatalogue();
  const updateSettings = useUpdateSettings();
  const setEnabled = useSetModelEnabled();

  const models = modelsData?.models ?? [];
  const settings = settingsData?.settings;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = query
      ? models.filter(
          (model) =>
            model.displayName.toLowerCase().includes(query) ||
            model.modelId.toLowerCase().includes(query) ||
            model.task.toLowerCase().includes(query),
        )
      : models;
    const byProvider = new Map<string, typeof list>();
    for (const model of list) {
      const group = byProvider.get(model.providerName) ?? [];
      group.push(model);
      byProvider.set(model.providerName, group);
    }
    return [...byProvider.entries()].sort((a, b) =>
      providerLabel(a[0]).localeCompare(providerLabel(b[0])),
    );
  }, [models, search]);

  const handleRefresh = () => {
    refresh.mutate(undefined, {
      onSuccess: (result) => {
        const failed = result.outcomes.filter((outcome) => !outcome.ok);
        toast({
          title: `${result.total} models in the catalogue`,
          description: result.outcomes.map((outcome) => outcome.message).join(' · '),
          variant: failed.length > 0 && result.total === 0 ? 'destructive' : undefined,
        });
      },
      onError: (err: unknown) =>
        toast({
          variant: 'destructive',
          title: 'Refresh failed',
          description: err instanceof Error ? err.message : undefined,
        }),
    });
  };

  if (settingsLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="border-card-border">
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-lg">Catalogue</CardTitle>
            <CardDescription className="mt-1.5">
              Fetched live from each connected provider — nothing is hardcoded.
              {models.length > 0 && ` ${models.length} models available.`}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            className="shrink-0 gap-2"
            onClick={handleRefresh}
            disabled={refresh.isPending}
            data-testid="button-refresh-models"
          >
            {refresh.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {(settingsData?.connectedProviders.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">
              Connect a provider first — the catalogue comes from their APIs.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Defaults per task</CardTitle>
          <CardDescription>
            Which model runs when you don't pick one explicitly. Leave a slot
            empty and Nexus chooses the best available.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {TASK_SLOTS.map((slot) => (
            <div
              key={slot.key}
              className="grid gap-2 border-b border-border pb-4 last:border-0 last:pb-0 sm:grid-cols-[1fr_320px] sm:items-start"
            >
              <div>
                <Label className="text-sm font-medium">{slot.label}</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {slot.description}
                </p>
              </div>
              <ModelPicker
                value={(settings?.[slot.key] as string | null) ?? null}
                task={slot.task}
                allowClear
                placeholder="Automatic"
                onChange={(next) =>
                  updateSettings.mutate({ [slot.key]: next || null } as Partial<UserSettings>)
                }
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Enabled models</CardTitle>
          <CardDescription>
            Turn off models you never use to keep the picker short.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter models"
              className="h-9 pl-8"
              aria-label="Filter models"
            />
          </div>

          {modelsLoading && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!modelsLoading && models.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No models cached. Refresh the catalogue above.
            </p>
          )}

          <div className="space-y-5">
            {filtered.map(([provider, list]) => (
              <section key={provider}>
                <h3 className="mb-2 text-sm font-medium">
                  {providerLabel(provider)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {list.length}
                  </span>
                </h3>
                <ul className="space-y-1">
                  {list.slice(0, 200).map((model) => (
                    <li
                      key={model.modelRef}
                      className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm">{model.displayName}</p>
                          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px]">
                            {model.task}
                          </Badge>
                          {model.experimental && (
                            <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px]">
                              beta
                            </Badge>
                          )}
                        </div>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {model.modelId}
                          {formatContextWindow(model.contextWindow)
                            ? ` · ${formatContextWindow(model.contextWindow)}`
                            : ''}
                        </p>
                      </div>
                      <Switch
                        checked={model.enabled}
                        onCheckedChange={(checked) =>
                          setEnabled.mutate({
                            modelRef: model.modelRef,
                            enabled: checked,
                          })
                        }
                        aria-label={`Enable ${model.displayName}`}
                        data-testid={`switch-model-${model.modelRef}`}
                      />
                    </li>
                  ))}
                </ul>
                {list.length > 200 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Showing the first 200 — narrow the filter to see more.
                  </p>
                )}
              </section>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
