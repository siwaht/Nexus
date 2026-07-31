import {
  Bot,
  Brain,
  CheckCircle2,
  Globe,
  Library,
  Loader2,
  Monitor,
  Plug,
  Shield,
  Sparkles,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useBrowserCapabilities, useFiles, useMcp, useSettings } from '@/lib/queries';

/**
 * Settings → About.
 *
 * A straight capability report: what's wired up on this install and what isn't,
 * with the reason. Optional dependencies (pgvector, ffmpeg, a CDP browser, a
 * search key) change what Nexus can do, so it says so plainly rather than
 * failing later.
 */

function StatusRow({
  icon,
  label,
  ok,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border py-3 last:border-0">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{label}</p>
          {ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-500" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export function AboutTab() {
  const { data: settingsData, isLoading } = useSettings();
  const { data: browser } = useBrowserCapabilities();
  const { data: mcpData } = useMcp();
  const { data: filesData } = useFiles();

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const providers = settingsData?.connectedProviders ?? [];
  const files = filesData?.files ?? [];
  const readyFiles = files.filter((file) => file.status === 'ready').length;
  const mcpServers = mcpData?.servers ?? [];
  const connectedMcp = mcpServers.filter((server) => server.status === 'connected');
  const mcpTools = mcpData?.tools.filter((tool) => tool.enabled).length ?? 0;
  const ffmpeg = filesData?.media?.ffmpeg ?? false;

  return (
    <div className="space-y-4">
      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Nexus</CardTitle>
          <CardDescription>
            A self-hosted AI workspace. Every model call goes through the backend,
            so the browser never sees an API key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Streaming chat</Badge>
            <Badge variant="outline">Tools and MCP</Badge>
            <Badge variant="outline">Skills</Badge>
            <Badge variant="outline">Multi-agent runs</Badge>
            <Badge variant="outline">RAG with citations</Badge>
            <Badge variant="outline">Long-term memory</Badge>
            <Badge variant="outline">Browser control</Badge>
            <Badge variant="outline">Charts, diagrams, TTS</Badge>
          </div>
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">What's working here</CardTitle>
          <CardDescription>
            Optional pieces change what Nexus can do. Anything off below has a
            reason and a fix.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-0">
          <StatusRow
            icon={<Sparkles className="h-4 w-4" />}
            label="Model providers"
            ok={providers.length > 0}
            detail={
              providers.length > 0
                ? `${providers.length} connected: ${providers.join(', ')}.`
                : 'None connected. Add one in the Providers tab — nothing works without it.'
            }
          />
          <StatusRow
            icon={<Library className="h-4 w-4" />}
            label="Library and retrieval"
            ok={readyFiles > 0}
            detail={
              readyFiles > 0
                ? `${readyFiles} indexed ${readyFiles === 1 ? 'file' : 'files'} available for retrieval with citations.`
                : 'No indexed files yet. Upload documents to enable library search.'
            }
          />
          <StatusRow
            icon={<Monitor className="h-4 w-4" />}
            label="Browser control"
            ok={browser?.canControl ?? false}
            detail={
              browser?.reason ??
              'Pages can be read but not interacted with until a CDP endpoint is configured.'
            }
          />
          <StatusRow
            icon={<Plug className="h-4 w-4" />}
            label="MCP servers"
            ok={connectedMcp.length > 0}
            detail={
              connectedMcp.length > 0
                ? `${connectedMcp.length} connected, ${mcpTools} tools enabled.`
                : 'None connected. Add a server in the MCP tab to bring in external tools.'
            }
          />
          <StatusRow
            icon={<Globe className="h-4 w-4" />}
            label="Media processing"
            ok={ffmpeg}
            detail={
              ffmpeg
                ? 'ffmpeg is available, so video ingestion and long-audio chunking work.'
                : 'ffmpeg is not installed. Video ingestion and long-audio chunking are unavailable — install ffmpeg or set FFMPEG_PATH.'
            }
          />
          <StatusRow
            icon={<Brain className="h-4 w-4" />}
            label="Memory"
            ok={settingsData?.settings.autoMemory ?? false}
            detail={
              settingsData?.settings.autoMemory
                ? 'Durable facts are extracted automatically and injected when relevant.'
                : 'Automatic fact extraction is off. Only facts you add by hand are remembered.'
            }
          />
          <StatusRow
            icon={<Bot className="h-4 w-4" />}
            label="Agent runs"
            ok
            detail={`Up to ${settingsData?.settings.maxParallelAgents ?? 3} agents in parallel, ${settingsData?.settings.maxAgentSteps ?? 40} steps per run. Run state is persisted, so a restart doesn't lose progress.`}
          />
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Shield className="h-4 w-4" />
            Security model
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>
              Every page and API route sits behind authentication. Unauthenticated
              requests get a 401 or the sign-in screen.
            </li>
            <li>
              Provider credentials and vault secrets are AES-256-GCM encrypted at
              rest and write-only over the API — only masked previews leave the
              server.
            </li>
            <li>
              Tools are deny-by-ask. Anything that writes, spends money or reaches
              an external system needs explicit approval, and every call is
              audited.
            </li>
            <li>
              User-supplied URLs (MCP servers, web tools, custom endpoints) are
              SSRF-guarded: private, loopback and metadata addresses are blocked,
              and redirects are re-validated at every hop.
            </li>
            <li>
              Model output is rendered as sanitized markdown with raw HTML
              disabled. Key material, file contents and prompts are never logged.
            </li>
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            Accessibility: semantic markup, ARIA live regions on the streaming
            output, keyboard reachability and visible focus rings are all in place.
            Full WCAG conformance still needs manual testing with a screen reader.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
