import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Globe,
  Library,
  Loader2,
  Monitor,
  Music,
  Search,
  Shield,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';

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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAudit, useSetPermission, useTools } from '@/lib/queries';
import type { PermissionMode, ToolCatalogueEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Settings → Tools.
 *
 * The permission model is deny-by-ask: anything that writes, spends money or
 * reaches outside the account stops for approval the first time. This screen is
 * where those answers get made permanent, and where the audit log lives.
 */

const GROUP_META: Record<string, { label: string; icon: React.ReactNode }> = {
  web: { label: 'Web', icon: <Globe className="h-4 w-4" /> },
  browser: { label: 'Browser control', icon: <Monitor className="h-4 w-4" /> },
  library: { label: 'Library', icon: <Library className="h-4 w-4" /> },
  memory: { label: 'Memory', icon: <Sparkles className="h-4 w-4" /> },
  media: { label: 'Media', icon: <Music className="h-4 w-4" /> },
  output: { label: 'Rich output', icon: <Wrench className="h-4 w-4" /> },
  agents: { label: 'Agents', icon: <Bot className="h-4 w-4" /> },
  mcp: { label: 'MCP servers', icon: <Shield className="h-4 w-4" /> },
};

const MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' },
];

function PermissionToggle({
  tool,
  onChange,
}: {
  tool: ToolCatalogueEntry;
  onChange: (mode: PermissionMode) => void;
}) {
  return (
    <div
      className="flex shrink-0 rounded-md border border-border p-0.5"
      role="radiogroup"
      aria-label={`Permission for ${tool.title}`}
    >
      {MODES.map((mode) => (
        <button
          key={mode.value}
          type="button"
          role="radio"
          aria-checked={tool.permission === mode.value}
          onClick={() => onChange(mode.value)}
          className={cn(
            'rounded px-2 py-0.5 text-xs transition-colors',
            tool.permission === mode.value
              ? mode.value === 'deny'
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-testid={`button-permission-${tool.key}-${mode.value}`}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}

export function ToolsTab() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useTools();
  const { data: auditData } = useAudit();
  const setPermission = useSetPermission();

  const tools = data?.tools ?? [];
  const browser = data?.browser;

  const grouped = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = query
      ? tools.filter(
          (tool) =>
            tool.title.toLowerCase().includes(query) ||
            tool.name.toLowerCase().includes(query) ||
            tool.description.toLowerCase().includes(query),
        )
      : tools;

    const map = new Map<string, ToolCatalogueEntry[]>();
    for (const tool of list) {
      const group = map.get(tool.group) ?? [];
      group.push(tool);
      map.set(tool.group, group);
    }
    return [...map.entries()].sort((a, b) =>
      (GROUP_META[a[0]]?.label ?? a[0]).localeCompare(GROUP_META[b[0]]?.label ?? b[0]),
    );
  }, [tools, search]);

  const askingCount = tools.filter((tool) => tool.permission === 'ask').length;

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Tabs defaultValue="permissions" className="space-y-4">
      <TabsList>
        <TabsTrigger value="permissions" data-testid="tab-permissions">
          Permissions
        </TabsTrigger>
        <TabsTrigger value="activity" data-testid="tab-activity">
          Activity
        </TabsTrigger>
      </TabsList>

      <TabsContent value="permissions" className="space-y-4">
        <Card className="border-card-border">
          <CardHeader>
            <CardTitle className="text-lg">How permissions work</CardTitle>
            <CardDescription>
              Read-only tools run without interrupting. Anything that writes,
              spends provider credit, or reaches an external system asks first —
              {askingCount} {askingCount === 1 ? 'tool is' : 'tools are'} set to
              ask. Deny removes a tool from the model's options entirely.
            </CardDescription>
          </CardHeader>
          {browser && !browser.canControl && (
            <CardContent>
              <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {browser.reason}
              </p>
            </CardContent>
          )}
        </Card>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter tools"
            className="h-9 pl-8"
            aria-label="Filter tools"
          />
        </div>

        {grouped.map(([group, list]) => (
          <Card key={group} className="border-card-border">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                {GROUP_META[group]?.icon ?? <Wrench className="h-4 w-4" />}
                {GROUP_META[group]?.label ?? group}
                <span className="text-xs font-normal text-muted-foreground">
                  {list.length}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {list.map((tool) => (
                <div
                  key={tool.key}
                  className="flex items-start gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-sm font-medium">{tool.title}</p>
                      <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
                        {tool.name}
                      </code>
                      {tool.readOnly && (
                        <Badge variant="outline" className="h-4 px-1 text-[10px]">
                          read-only
                        </Badge>
                      )}
                      {tool.destructive && (
                        <Badge variant="destructive" className="h-4 px-1 text-[10px]">
                          can change things
                        </Badge>
                      )}
                      {!tool.available && (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                          unavailable
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {tool.description}
                    </p>
                    {!tool.available && tool.unavailableReason && (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                        {tool.unavailableReason}
                      </p>
                    )}
                  </div>
                  <PermissionToggle
                    tool={tool}
                    onChange={(mode) =>
                      setPermission.mutate({ toolKey: tool.key, mode })
                    }
                  />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}

        {grouped.length === 0 && (
          <Card className="border-card-border">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No tools matched that filter.
            </CardContent>
          </Card>
        )}
      </TabsContent>

      <TabsContent value="activity">
        <Card className="border-card-border">
          <CardHeader>
            <CardTitle className="text-lg">Tool activity</CardTitle>
            <CardDescription>
              Every tool call, including ones that were denied. Arguments are
              stored with credential-looking values redacted.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[520px]">
              <ul className="space-y-2 pr-3">
                {(auditData?.entries ?? []).map((entry) => (
                  <li
                    key={entry.id}
                    className="rounded-md border border-border bg-muted/20 p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      {entry.status === 'ok' ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-500" />
                      ) : entry.status === 'denied' ? (
                        <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : entry.status === 'error' ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                      ) : (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <code className="min-w-0 flex-1 truncate text-xs">
                        {entry.toolKey}
                      </code>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {entry.durationMs !== null ? `${entry.durationMs}ms · ` : ''}
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {entry.resultSummary && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {entry.resultSummary}
                      </p>
                    )}
                    {entry.error && (
                      <p className="mt-1 text-xs text-destructive">{entry.error}</p>
                    )}
                  </li>
                ))}
                {(auditData?.entries.length ?? 0) === 0 && (
                  <li className="py-10 text-center text-sm text-muted-foreground">
                    No tool calls yet.
                  </li>
                )}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
