import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  Plug,
  Plus,
  Trash2,
  XCircle,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import {
  useDeleteMcpServer,
  useMcp,
  useSaveMcpServer,
  useSecrets,
  useSetMcpToolEnabled,
  useTestMcpServer,
} from '@/lib/queries';
import type { McpServer, McpTransport } from '@/lib/types';

/**
 * Settings → MCP.
 *
 * Connect Model Context Protocol servers and their tools become available to
 * chat and agents alongside the built-ins.
 *
 * Credentials are never stored on the server row: you map a header (or an env
 * var for stdio) to a secret name from the vault, and the plaintext is resolved
 * server-side at connect time only.
 */

interface FormState {
  id?: number;
  name: string;
  description: string;
  transport: McpTransport;
  url: string;
  command: string;
  args: string;
  headerSecrets: Array<{ header: string; secret: string }>;
  staticHeaders: Array<{ header: string; value: string }>;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  transport: 'http',
  url: '',
  command: '',
  args: '',
  headerSecrets: [],
  staticHeaders: [],
  enabled: true,
};

function toForm(server: McpServer): FormState {
  return {
    id: server.id,
    name: server.name,
    description: server.description ?? '',
    transport: server.transport,
    url: server.url ?? '',
    command: server.command ?? '',
    args: server.args.join(' '),
    headerSecrets: Object.entries(server.headerSecrets).map(([header, secret]) => ({
      header,
      secret,
    })),
    staticHeaders: Object.entries(server.staticHeaders).map(([header, value]) => ({
      header,
      value,
    })),
    enabled: server.enabled,
  };
}

export function McpTab() {
  const { toast } = useToast();
  const { data, isLoading } = useMcp();
  const { data: secretsData } = useSecrets();
  const saveServer = useSaveMcpServer();
  const deleteServer = useDeleteMcpServer();
  const testServer = useTestMcpServer();
  const setToolEnabled = useSetMcpToolEnabled();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const servers = data?.servers ?? [];
  const tools = data?.tools ?? [];
  const stdio = data?.stdio;
  const secrets = secretsData?.secrets ?? [];

  const openNew = () => {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setForm(toForm(server));
    setDialogOpen(true);
  };

  const submit = () => {
    if (!form.name.trim()) {
      toast({ variant: 'destructive', title: 'The server needs a name' });
      return;
    }
    if (form.transport !== 'stdio' && !form.url.trim()) {
      toast({ variant: 'destructive', title: 'Remote servers need a URL' });
      return;
    }
    if (form.transport === 'stdio' && !form.command.trim()) {
      toast({ variant: 'destructive', title: 'stdio servers need a command' });
      return;
    }

    saveServer.mutate(
      {
        id: form.id,
        name: form.name.trim(),
        description: form.description.trim() || null,
        transport: form.transport,
        url: form.url.trim() || null,
        command: form.command.trim() || null,
        args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
        headerSecrets: Object.fromEntries(
          form.headerSecrets
            .filter((entry) => entry.header.trim() && entry.secret.trim())
            .map((entry) => [entry.header.trim(), entry.secret.trim()]),
        ),
        staticHeaders: Object.fromEntries(
          form.staticHeaders
            .filter((entry) => entry.header.trim())
            .map((entry) => [entry.header.trim(), entry.value]),
        ),
        enabled: form.enabled,
      },
      {
        onSuccess: (result) => {
          setDialogOpen(false);
          toast({
            title: `${result.server.name} saved`,
            description: 'Run Test connection to discover its tools.',
          });
        },
        onError: (err: unknown) =>
          toast({
            variant: 'destructive',
            title: 'Could not save the server',
            description: err instanceof Error ? err.message : undefined,
          }),
      },
    );
  };

  const statusIcon = (status: string) => {
    if (status === 'connected') {
      return <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500" />;
    }
    if (status === 'error') return <XCircle className="h-4 w-4 text-destructive" />;
    return <Circle className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <div className="space-y-4">
      <Card className="border-card-border">
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Plug className="h-4 w-4" />
              MCP servers
            </CardTitle>
            <CardDescription className="mt-1.5">
              Model Context Protocol servers extend Nexus with external tools.
              Their tools show up alongside the built-ins and go through the same
              permission gate.
            </CardDescription>
          </div>
          <Button className="shrink-0 gap-2" onClick={openNew} data-testid="button-add-mcp">
            <Plus className="h-4 w-4" />
            Add server
          </Button>
        </CardHeader>
        {stdio && !stdio.available && (
          <CardContent>
            <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {stdio.reason}
            </p>
          </CardContent>
        )}
      </Card>

      {isLoading && (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && servers.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Plug className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No MCP servers yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Add a remote server by URL. If it needs an API key, store the key in
              Settings → API Keys first, then map it to a header here.
            </p>
          </CardContent>
        </Card>
      )}

      {servers.map((server) => {
        const serverTools = tools.filter((tool) => tool.serverId === server.id);
        return (
          <Card key={server.id} className="border-card-border">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {statusIcon(server.status)}
                    {server.name}
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      {server.transport}
                    </Badge>
                    {server.toolCount > 0 && (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                        {server.toolCount} tools
                      </Badge>
                    )}
                  </CardTitle>
                  {server.description && (
                    <CardDescription className="mt-1">
                      {server.description}
                    </CardDescription>
                  )}
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {server.url ?? `${server.command} ${server.args.join(' ')}`}
                  </p>
                  {server.statusMessage && (
                    <p
                      className={`mt-1.5 text-xs ${server.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                    >
                      {server.statusMessage}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={server.enabled}
                    onCheckedChange={(checked) =>
                      saveServer.mutate({
                        id: server.id,
                        name: server.name,
                        description: server.description,
                        transport: server.transport,
                        url: server.url,
                        command: server.command,
                        args: server.args,
                        headerSecrets: server.headerSecrets,
                        staticHeaders: server.staticHeaders,
                        enabled: checked,
                      })
                    }
                    aria-label={`Enable ${server.name}`}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  disabled={testServer.isPending}
                  onClick={() =>
                    testServer.mutate(server.id, {
                      onSuccess: (result) =>
                        toast({
                          variant: result.ok ? undefined : 'destructive',
                          title: result.ok ? 'Connected' : 'Connection failed',
                          description: result.message,
                        }),
                    })
                  }
                  data-testid={`button-test-mcp-${server.id}`}
                >
                  {testServer.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Test connection
                </Button>
                <Button variant="outline" size="sm" onClick={() => openEdit(server)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto gap-2 text-destructive hover:text-destructive"
                  onClick={() => deleteServer.mutate(server.id)}
                  data-testid={`button-delete-mcp-${server.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              </div>

              {serverTools.length > 0 && (
                <div className="space-y-1 border-t border-border pt-3">
                  <p className="text-xs font-medium">Discovered tools</p>
                  <ul className="space-y-1">
                    {serverTools.map((tool) => (
                      <li
                        key={tool.id}
                        className="flex items-start gap-2 rounded px-1 py-1 hover:bg-muted/40"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <code className="text-xs font-medium">{tool.name}</code>
                            {tool.readOnlyHint && (
                              <Badge variant="outline" className="h-4 px-1 text-[10px]">
                                read-only
                              </Badge>
                            )}
                          </div>
                          {tool.description && (
                            <p className="line-clamp-2 text-[11px] text-muted-foreground">
                              {tool.description}
                            </p>
                          )}
                        </div>
                        <Switch
                          checked={tool.enabled}
                          onCheckedChange={(checked) =>
                            setToolEnabled.mutate({ toolId: tool.id, enabled: checked })
                          }
                          aria-label={`Enable ${tool.name}`}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit MCP server' : 'Add an MCP server'}</DialogTitle>
            <DialogDescription>
              Remote servers over HTTP work everywhere. stdio spawns a local
              process and only works on a long-lived host.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mcp-name">Name</Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="github"
                data-testid="input-mcp-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="mcp-description">Description</Label>
              <Textarea
                id="mcp-description"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                placeholder="What this server is for"
                className="min-h-16"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="mcp-transport">Transport</Label>
              <Select
                value={form.transport}
                onValueChange={(next) =>
                  setForm({ ...form, transport: next as McpTransport })
                }
              >
                <SelectTrigger id="mcp-transport" data-testid="select-mcp-transport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">Streamable HTTP (recommended)</SelectItem>
                  <SelectItem value="sse">HTTP + SSE (legacy)</SelectItem>
                  <SelectItem value="stdio" disabled={!stdio?.available}>
                    stdio {stdio?.available ? '' : '(unavailable here)'}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.transport === 'stdio' ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="mcp-command">Command</Label>
                  <Input
                    id="mcp-command"
                    value={form.command}
                    onChange={(event) =>
                      setForm({ ...form, command: event.target.value })
                    }
                    placeholder="npx"
                    className="font-mono text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcp-args">Arguments</Label>
                  <Input
                    id="mcp-args"
                    value={form.args}
                    onChange={(event) => setForm({ ...form, args: event.target.value })}
                    placeholder="-y @modelcontextprotocol/server-filesystem /data"
                    className="font-mono text-sm"
                  />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="mcp-url">Server URL</Label>
                <Input
                  id="mcp-url"
                  value={form.url}
                  onChange={(event) => setForm({ ...form, url: event.target.value })}
                  placeholder="https://mcp.example.com/mcp"
                  className="font-mono text-sm"
                  data-testid="input-mcp-url"
                />
                <p className="text-xs text-muted-foreground">
                  Must resolve to a public address — private and loopback hosts are
                  blocked.
                </p>
              </div>
            )}

            <div className="space-y-2 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <Label>Auth headers</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() =>
                    setForm({
                      ...form,
                      headerSecrets: [
                        ...form.headerSecrets,
                        { header: 'Authorization', secret: '' },
                      ],
                    })
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Map a header to a secret from the vault. The value never leaves the
                server.
              </p>
              {form.headerSecrets.map((entry, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    value={entry.header}
                    onChange={(event) => {
                      const next = [...form.headerSecrets];
                      next[index] = { ...entry, header: event.target.value };
                      setForm({ ...form, headerSecrets: next });
                    }}
                    placeholder="Header name"
                    className="font-mono text-sm"
                  />
                  <Select
                    value={entry.secret}
                    onValueChange={(value) => {
                      const next = [...form.headerSecrets];
                      next[index] = { ...entry, secret: value };
                      setForm({ ...form, headerSecrets: next });
                    }}
                  >
                    <SelectTrigger className="w-40">
                      <SelectValue placeholder="Secret" />
                    </SelectTrigger>
                    <SelectContent>
                      {secrets.length === 0 && (
                        <SelectItem value="__none__" disabled>
                          No secrets stored
                        </SelectItem>
                      )}
                      {secrets.map((secret) => (
                        <SelectItem key={secret.name} value={secret.name}>
                          {secret.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={() =>
                      setForm({
                        ...form,
                        headerSecrets: form.headerSecrets.filter(
                          (_item, i) => i !== index,
                        ),
                      })
                    }
                    aria-label="Remove header"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saveServer.isPending} data-testid="button-save-mcp">
              {saveServer.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
