import { useState } from 'react';
import { Brain, Loader2, Pin, PinOff, Plus, Trash2 } from 'lucide-react';

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
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import {
  useDeleteMemory,
  useMemory,
  useSaveMemory,
  useSettings,
  useUpdateMemory,
  useUpdateSettings,
  useWipeMemory,
} from '@/lib/queries';

/**
 * Settings → Memory.
 *
 * Every remembered fact is listed, editable and deletable. Memory you can't
 * inspect isn't memory you can trust, so nothing here is hidden — including the
 * summarization threshold and how many older messages get recalled per turn.
 */

const CATEGORIES = ['preference', 'project', 'person', 'goal', 'fact'];

export function MemoryTab() {
  const { toast } = useToast();
  const { data: memoryData, isLoading } = useMemory();
  const { data: settingsData } = useSettings();
  const saveFact = useSaveMemory();
  const updateFact = useUpdateMemory();
  const deleteFact = useDeleteMemory();
  const wipe = useWipeMemory();
  const updateSettings = useUpdateSettings();

  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const facts = memoryData?.facts ?? [];
  const settings = settingsData?.settings;

  return (
    <div className="space-y-4">
      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">How memory works</CardTitle>
          <CardDescription>
            Three layers: the full thread history, semantic recall of relevant
            older messages, and durable facts injected into the system prompt.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="auto-memory" className="text-sm font-medium">
                Extract facts automatically
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                After each exchange, pull out durable facts worth keeping. Turn
                this off and only facts you add here are remembered.
              </p>
            </div>
            <Switch
              id="auto-memory"
              checked={settings?.autoMemory ?? true}
              onCheckedChange={(checked) => updateSettings.mutate({ autoMemory: checked })}
              data-testid="switch-auto-memory"
            />
          </div>

          <div className="flex items-start justify-between gap-4 border-t border-border pt-5">
            <div>
              <Label htmlFor="semantic-recall" className="text-sm font-medium">
                Semantic recall
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Pull in relevant older messages from this and other threads,
                clearly labelled as recalled context.
              </p>
            </div>
            <Switch
              id="semantic-recall"
              checked={settings?.semanticRecall ?? true}
              onCheckedChange={(checked) =>
                updateSettings.mutate({ semanticRecall: checked })
              }
              data-testid="switch-semantic-recall"
            />
          </div>

          <div className="space-y-2 border-t border-border pt-5">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Recalled messages per turn</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {settings?.recallLimit ?? 5}
              </span>
            </div>
            <Slider
              value={[settings?.recallLimit ?? 5]}
              min={0}
              max={20}
              step={1}
              onValueChange={([next]) => updateSettings.mutate({ recallLimit: next })}
              aria-label="Recalled messages per turn"
            />
          </div>

          <div className="space-y-2 border-t border-border pt-5">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Summarize at</Label>
              <span className="font-mono text-xs text-muted-foreground">
                {Math.round((settings?.summarizeThreshold ?? 0.6) * 100)}% of context
              </span>
            </div>
            <Slider
              value={[settings?.summarizeThreshold ?? 0.6]}
              min={0.2}
              max={0.95}
              step={0.05}
              onValueChange={([next]) =>
                updateSettings.mutate({ summarizeThreshold: next })
              }
              aria-label="Summarization threshold"
            />
            <p className="text-xs text-muted-foreground">
              Once a thread passes this share of the model's context window, the
              oldest turns fold into a rolling summary you can expand in the chat.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Brain className="h-4 w-4" />
              Remembered facts
            </CardTitle>
            <CardDescription className="mt-1.5">
              {facts.length} {facts.length === 1 ? 'fact' : 'facts'} injected into
              the system prompt when relevant.
            </CardDescription>
          </div>
          {facts.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="shrink-0 gap-2">
                  <Trash2 className="h-3.5 w-3.5" />
                  Wipe all
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Wipe all memory?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This deletes all {facts.length} remembered facts. Conversations
                    are untouched, but the assistant will start over on what it
                    knows about you. This can't be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() =>
                      wipe.mutate(undefined, {
                        onSuccess: (result) =>
                          toast({
                            title: `${result.deleted} facts deleted`,
                          }),
                      })
                    }
                  >
                    Wipe memory
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && draft.trim().length > 3) {
                  saveFact.mutate({ text: draft.trim() });
                  setDraft('');
                }
              }}
              placeholder="Add something the assistant should always know"
              className="h-9"
              aria-label="New memory"
              data-testid="input-new-fact"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              disabled={draft.trim().length < 4}
              onClick={() => {
                saveFact.mutate({ text: draft.trim() });
                setDraft('');
              }}
              data-testid="button-add-fact"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>

          {isLoading && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && facts.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing remembered yet. Facts appear here as they're extracted from
              conversations.
            </p>
          )}

          <ul className="space-y-2">
            {facts.map((fact) => (
              <li
                key={fact.id}
                className="rounded-md border border-border bg-muted/20 p-2.5"
              >
                {editingId === fact.id ? (
                  <div className="space-y-2">
                    <Textarea
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      className="min-h-16 text-sm"
                      aria-label="Edit memory"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          updateFact.mutate({ id: fact.id, text: editDraft });
                          setEditingId(null);
                        }}
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-relaxed">{fact.text}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="h-4 px-1 text-[10px]">
                          {fact.category}
                        </Badge>
                        {fact.confidence !== null && (
                          <span className="text-[11px] text-muted-foreground">
                            {Math.round(fact.confidence * 100)}% confident
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(fact.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          updateFact.mutate({ id: fact.id, pinned: !fact.pinned })
                        }
                        aria-label={fact.pinned ? 'Unpin fact' : 'Pin fact'}
                      >
                        {fact.pinned ? (
                          <Pin className="h-3.5 w-3.5 text-primary" />
                        ) : (
                          <PinOff className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setEditDraft(fact.text);
                          setEditingId(fact.id);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => deleteFact.mutate(fact.id)}
                        aria-label="Delete fact"
                        data-testid={`button-delete-fact-${fact.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="space-y-1 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              Categories in use:{' '}
              {CATEGORIES.filter((category) =>
                facts.some((fact) => fact.category === category),
              ).join(', ') || 'none yet'}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
