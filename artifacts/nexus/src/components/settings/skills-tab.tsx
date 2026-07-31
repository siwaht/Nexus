import { useState } from 'react';
import { Loader2, Plus, Sparkles, Trash2, Wand2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import {
  useDeleteSkill,
  useGenerateSkill,
  useSaveSkill,
  useSkills,
  useTools,
} from '@/lib/queries';
import type { Skill } from '@/lib/types';

/**
 * Settings → Skills.
 *
 * A skill is a reusable instruction block plus the tools it's allowed to use.
 * Attach one to a conversation and "review this contract" or "audit this repo"
 * becomes one click instead of a re-typed brief.
 *
 * "Generate" drafts a skill from a plain description, and it can only wire in
 * tools that actually exist on this install — no invented tool names.
 */

interface FormState {
  id?: number;
  name: string;
  description: string;
  whenToUse: string;
  instructions: string;
  toolKeys: string[];
  enabled: boolean;
  autoSelect: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  whenToUse: '',
  instructions: '',
  toolKeys: [],
  enabled: true,
  autoSelect: true,
};

function toForm(skill: Skill): FormState {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description ?? '',
    whenToUse: skill.whenToUse ?? '',
    instructions: skill.instructions,
    toolKeys: skill.toolKeys,
    enabled: skill.enabled,
    autoSelect: skill.autoSelect,
  };
}

export function SkillsTab() {
  const { toast } = useToast();
  const { data, isLoading } = useSkills();
  const { data: toolsData } = useTools();
  const saveSkill = useSaveSkill();
  const deleteSkill = useDeleteSkill();
  const generateSkill = useGenerateSkill();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [prompt, setPrompt] = useState('');

  const skills = data?.skills ?? [];
  const tools = (toolsData?.tools ?? []).filter((tool) => tool.available);

  const submit = () => {
    if (!form.name.trim() || form.instructions.trim().length < 10) {
      toast({
        variant: 'destructive',
        title: 'A skill needs a name and instructions',
      });
      return;
    }
    saveSkill.mutate(
      {
        id: form.id,
        name: form.name.trim(),
        description: form.description.trim() || null,
        whenToUse: form.whenToUse.trim() || null,
        instructions: form.instructions.trim(),
        toolKeys: form.toolKeys,
        enabled: form.enabled,
        autoSelect: form.autoSelect,
      },
      {
        onSuccess: (result) => {
          setDialogOpen(false);
          toast({ title: `${result.skill.name} saved` });
        },
        onError: (err: unknown) =>
          toast({
            variant: 'destructive',
            title: 'Could not save the skill',
            description: err instanceof Error ? err.message : undefined,
          }),
      },
    );
  };

  const generate = () => {
    if (prompt.trim().length < 10) {
      toast({
        variant: 'destructive',
        title: 'Describe the skill in a sentence or two',
      });
      return;
    }
    generateSkill.mutate(
      { description: prompt.trim() },
      {
        onSuccess: (result) => {
          setForm({
            name: result.draft.name,
            description: result.draft.description ?? '',
            whenToUse: result.draft.whenToUse ?? '',
            instructions: result.draft.instructions,
            toolKeys: result.draft.toolKeys,
            enabled: true,
            autoSelect: true,
          });
          setDialogOpen(true);
          setPrompt('');
          if (result.unknownTools.length > 0) {
            toast({
              title: 'Draft ready',
              description: `Dropped ${result.unknownTools.length} tool(s) that don't exist here.`,
            });
          } else {
            toast({ title: 'Draft ready', description: 'Review it, then save.' });
          }
        },
        onError: (err: unknown) =>
          toast({
            variant: 'destructive',
            title: 'Could not generate a skill',
            description: err instanceof Error ? err.message : undefined,
          }),
      },
    );
  };

  return (
    <div className="space-y-4">
      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Wand2 className="h-4 w-4" />
            Generate a skill
          </CardTitle>
          <CardDescription>
            Describe the job in plain language and a draft gets written for you,
            wired to the tools this install actually has.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="e.g. Review a pull request for security problems, check dependencies for known issues, and write a summary with severity ratings."
            className="min-h-20"
            aria-label="Skill description"
            data-testid="textarea-skill-prompt"
          />
          <div className="flex gap-2">
            <Button
              className="gap-2"
              onClick={generate}
              disabled={generateSkill.isPending}
              data-testid="button-generate-skill"
            >
              {generateSkill.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Generate draft
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => {
                setForm(EMPTY_FORM);
                setDialogOpen(true);
              }}
              data-testid="button-new-skill"
            >
              <Plus className="h-4 w-4" />
              Write one myself
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && skills.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No skills yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Skills turn a repeated brief into a reusable capability you can pick
              from the composer.
            </p>
          </CardContent>
        </Card>
      )}

      {skills.map((skill) => (
        <Card key={skill.id} className="border-card-border">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                  {skill.name}
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                    {skill.source}
                  </Badge>
                  {skill.useCount > 0 && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      used {skill.useCount}×
                    </Badge>
                  )}
                </CardTitle>
                {skill.description && (
                  <CardDescription className="mt-1">{skill.description}</CardDescription>
                )}
                {skill.whenToUse && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    When: {skill.whenToUse}
                  </p>
                )}
              </div>
              <Switch
                checked={skill.enabled}
                onCheckedChange={(checked) =>
                  saveSkill.mutate({
                    id: skill.id,
                    name: skill.name,
                    description: skill.description,
                    whenToUse: skill.whenToUse,
                    instructions: skill.instructions,
                    toolKeys: skill.toolKeys,
                    enabled: checked,
                    autoSelect: skill.autoSelect,
                  })
                }
                aria-label={`Enable ${skill.name}`}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {skill.toolKeys.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {skill.toolKeys.map((key) => (
                  <Badge key={key} variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
                    {key.replace(/^builtin:/, '')}
                  </Badge>
                ))}
              </div>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Instructions
              </summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 p-2 leading-relaxed">
                {skill.instructions}
              </pre>
            </details>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setForm(toForm(skill));
                  setDialogOpen(true);
                }}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto gap-2 text-destructive hover:text-destructive"
                onClick={() => deleteSkill.mutate(skill.id)}
                data-testid={`button-delete-skill-${skill.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit skill' : 'New skill'}</DialogTitle>
            <DialogDescription>
              Instructions are layered into the system prompt when the skill is
              active. The tool allowlist narrows what the model can reach.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="skill-name">Name</Label>
                <Input
                  id="skill-name"
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="Security review"
                  data-testid="input-skill-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="skill-description">One-line description</Label>
                <Input
                  id="skill-description"
                  value={form.description}
                  onChange={(event) =>
                    setForm({ ...form, description: event.target.value })
                  }
                  placeholder="Audits code for security problems"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="skill-when">When to use it</Label>
              <Input
                id="skill-when"
                value={form.whenToUse}
                onChange={(event) => setForm({ ...form, whenToUse: event.target.value })}
                placeholder="Reviewing a diff, auditing dependencies, checking auth changes"
              />
              <p className="text-xs text-muted-foreground">
                Used for automatic selection — matching keywords in a message
                attach the skill on their own.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="skill-instructions">Instructions</Label>
              <Textarea
                id="skill-instructions"
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                placeholder="Step-by-step: what to do, what to check, what the output should look like."
                className="min-h-40 font-mono text-sm"
                data-testid="textarea-skill-instructions"
              />
            </div>

            <div className="space-y-2">
              <Label>Allowed tools</Label>
              <p className="text-xs text-muted-foreground">
                Leave everything unchecked to allow all available tools.
              </p>
              <ScrollArea className="h-48 rounded-md border border-border p-2">
                <ul className="space-y-1.5">
                  {tools.map((tool) => (
                    <li key={tool.key} className="flex items-start gap-2">
                      <Checkbox
                        id={`tool-${tool.key}`}
                        checked={form.toolKeys.includes(tool.key)}
                        onCheckedChange={(checked) =>
                          setForm({
                            ...form,
                            toolKeys:
                              checked === true
                                ? [...form.toolKeys, tool.key]
                                : form.toolKeys.filter((key) => key !== tool.key),
                          })
                        }
                        className="mt-0.5"
                      />
                      <Label
                        htmlFor={`tool-${tool.key}`}
                        className="cursor-pointer text-xs font-normal leading-relaxed"
                      >
                        <span className="font-medium">{tool.title}</span>
                        <span className="ml-1 text-muted-foreground">
                          {tool.description.slice(0, 100)}
                        </span>
                      </Label>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <Label htmlFor="skill-auto" className="text-sm">
                  Attach automatically
                </Label>
                <p className="text-xs text-muted-foreground">
                  Let Nexus pick this skill when a message looks relevant.
                </p>
              </div>
              <Switch
                id="skill-auto"
                checked={form.autoSelect}
                onCheckedChange={(checked) => setForm({ ...form, autoSelect: checked })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saveSkill.isPending} data-testid="button-save-skill">
              {saveSkill.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save skill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
