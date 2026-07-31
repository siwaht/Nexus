import { useState } from 'react';
import { ExternalLink, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';

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
import { useToast } from '@/hooks/use-toast';
import { useDeleteSecret, useSaveSecret, useSecrets } from '@/lib/queries';

/**
 * Settings → API Keys.
 *
 * A general vault for keys that aren't model providers: search APIs, MCP server
 * tokens, anything a tool needs. Write-only over the API — a stored value can be
 * replaced but never read back, and only a masked preview is ever returned.
 */

export function KeysTab() {
  const { toast } = useToast();
  const { data, isLoading } = useSecrets();
  const saveSecret = useSaveSecret();
  const deleteSecret = useDeleteSecret();

  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');

  const secrets = data?.secrets ?? [];
  const known = data?.known ?? [];
  const storedNames = new Set(secrets.map((secret) => secret.name));

  const save = (secretName: string, secretValue: string, secretLabel?: string) => {
    if (!secretName.trim() || !secretValue.trim()) {
      toast({ variant: 'destructive', title: 'A name and value are both required' });
      return;
    }
    saveSecret.mutate(
      {
        name: secretName.trim(),
        value: secretValue.trim(),
        label: secretLabel?.trim() || null,
      },
      {
        onSuccess: (result) => {
          setName('');
          setValue('');
          setLabel('');
          toast({
            title: `${result.secret.name} saved`,
            description: `Stored as ${result.secret.maskedPreview}.`,
          });
        },
        onError: (err: unknown) =>
          toast({
            variant: 'destructive',
            title: 'Could not save the key',
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
            <KeyRound className="h-4 w-4" />
            API keys and secrets
          </CardTitle>
          <CardDescription>
            Keys for tools and MCP servers. Encrypted with AES-256-GCM at rest,
            write-only over the API, and never logged. Model provider keys live in
            the Providers tab instead.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="secret-name">Name</Label>
              <Input
                id="secret-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="BRAVE_API_KEY"
                className="font-mono text-sm"
                data-testid="input-secret-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="secret-value">Value</Label>
              <Input
                id="secret-value"
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Paste the key"
                className="font-mono text-sm"
                data-testid="input-secret-value"
              />
            </div>
            <Button
              className="gap-2"
              onClick={() => save(name, value, label)}
              disabled={saveSecret.isPending}
              data-testid="button-save-secret"
            >
              {saveSecret.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Names are normalized to upper snake case so they're stable to
            reference from MCP configs.
          </p>
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Stored keys</CardTitle>
          <CardDescription>
            {secrets.length} {secrets.length === 1 ? 'key' : 'keys'} in the vault.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && secrets.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing stored yet.
            </p>
          )}

          <ul className="space-y-2">
            {secrets.map((secret) => (
              <li
                key={secret.id}
                className="flex items-center gap-3 rounded-md border border-border bg-muted/20 p-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm font-medium">{secret.name}</code>
                    <Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
                      {secret.maskedPreview}
                    </Badge>
                    {secret.lastUsedAt && (
                      <span className="text-[11px] text-muted-foreground">
                        last used {new Date(secret.lastUsedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {(secret.label || secret.description) && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {secret.label ?? secret.description}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() =>
                    deleteSecret.mutate(secret.name, {
                      onSuccess: () => toast({ title: `${secret.name} removed` }),
                    })
                  }
                  aria-label={`Delete ${secret.name}`}
                  data-testid={`button-delete-secret-${secret.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Keys Nexus knows about</CardTitle>
          <CardDescription>
            Store any of these and the matching feature switches on automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {known.map((entry) => (
            <div
              key={entry.name}
              className="flex items-start gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-sm font-medium">{entry.name}</code>
                  {storedNames.has(entry.name) && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      stored
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {entry.label} — {entry.description}
                </p>
              </div>
              <Button asChild variant="ghost" size="sm" className="shrink-0 gap-1.5 text-xs">
                <a href={entry.docsUrl} target="_blank" rel="noopener noreferrer">
                  Get a key
                  <ExternalLink className="h-3 w-3" />
                </a>
              </Button>
            </div>
          ))}
          <p className="pt-1 text-xs text-muted-foreground">
            Without a search key, web search falls back to a keyless DuckDuckGo
            scrape — usable, but thinner and rate-limited.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
