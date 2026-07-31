import { useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Loader2,
  MousePointerClick,
  Monitor,
  RotateCcw,
  Search,
  Type,
} from 'lucide-react';

import { Markdown } from '@/components/output/markdown';
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
import { useToast } from '@/hooks/use-toast';
import { api, screenshotUrl } from '@/lib/api';
import { useBrowserCapabilities } from '@/lib/queries';
import type { BrowserActionResult, PageSnapshot, SearchHit } from '@/lib/types';

/**
 * The Browser panel.
 *
 * Drive the web yourself rather than only through the model: search, read a page
 * as clean markdown, or — when a CDP endpoint is configured — navigate, click and
 * type in a real browser and see the resulting screenshot and selectors.
 *
 * Every request goes through the same SSRF guard and permission model the tools
 * use, and the panel always states which driver served the result.
 */

export interface BrowserPageProps {
  onBack: () => void;
}

export default function BrowserPage({ onBack }: BrowserPageProps) {
  const { toast } = useToast();
  const { data: capabilities } = useBrowserCapabilities();

  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [selector, setSelector] = useState('');
  const [typeText, setTypeText] = useState('');
  const [page, setPage] = useState<PageSnapshot | null>(null);
  const [action, setAction] = useState<BrowserActionResult | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [engine, setEngine] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const canControl = capabilities?.canControl ?? false;

  const fail = (err: unknown, title: string) =>
    toast({
      variant: 'destructive',
      title,
      description: err instanceof Error ? err.message : undefined,
    });

  const readPage = async (target = url) => {
    if (!target.trim()) return;
    setBusy('read');
    try {
      const result = await api.post<{ page: PageSnapshot }>('/web/read', {
        url: target.trim(),
        render: canControl,
      });
      setPage(result.page);
      setUrl(result.page.finalUrl);
    } catch (err) {
      fail(err, 'Could not read that page');
    } finally {
      setBusy(null);
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    setBusy('search');
    try {
      const result = await api.post<{
        engine: string;
        hits: SearchHit[];
        note: string | null;
      }>('/web/search', { query: query.trim(), limit: 10 });
      setHits(result.hits);
      setEngine(result.engine);
      if (result.note) toast({ title: 'Search note', description: result.note });
    } catch (err) {
      fail(err, 'Search failed');
    } finally {
      setBusy(null);
    }
  };

  const act = async (body: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      const result = await api.post<BrowserActionResult>('/browser/act', {
        ...body,
        screenshot: true,
      });
      setAction(result);
      if (result.url) setUrl(result.url);
    } catch (err) {
      fail(err, 'The browser action failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="glass shrink-0 border-b border-border/70 px-4 py-3">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-2" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Chat
          </Button>
          <div className="flex-1">
            <h1 className="flex items-center gap-2 font-display text-xl font-semibold tracking-tight">
              <Globe className="h-5 w-5 text-primary" />
              Web
            </h1>
            <p className="text-sm text-muted-foreground">
              Search, read pages, and drive a real browser
            </p>
          </div>
          <Badge variant={canControl ? 'default' : 'secondary'} className="shrink-0 gap-1.5">
            <Monitor className="h-3 w-3" />
            {canControl ? 'Control available' : 'Read only'}
          </Badge>
        </div>
      </header>

      {!canControl && capabilities && (
        <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-2">
          <p className="mx-auto flex max-w-5xl items-start gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {capabilities.reason}
          </p>
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl p-4">
          <Tabs defaultValue="read">
            <TabsList>
              <TabsTrigger value="read" data-testid="tab-read">Read a page</TabsTrigger>
              <TabsTrigger value="search" data-testid="tab-search">Search</TabsTrigger>
              <TabsTrigger value="control" disabled={!canControl} data-testid="tab-control">
                Control
              </TabsTrigger>
            </TabsList>

            <TabsContent value="read" className="mt-4 space-y-4">
              <div className="flex gap-2">
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void readPage();
                  }}
                  placeholder="https://example.com/article"
                  className="font-mono text-sm"
                  aria-label="URL to read"
                  data-testid="input-url"
                />
                <Button
                  className="gap-2"
                  onClick={() => void readPage()}
                  disabled={busy === 'read'}
                  data-testid="button-read-page"
                >
                  {busy === 'read' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  Read
                </Button>
              </div>

              {page && (
                <Card className="border-card-border">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{page.title ?? page.finalUrl}</CardTitle>
                    <CardDescription className="flex flex-wrap items-center gap-2">
                      <a
                        href={page.finalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {page.finalUrl}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                        via {page.driver}
                      </Badge>
                      {page.fromCache && (
                        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                          cached
                        </Badge>
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Markdown>{page.markdown.slice(0, 40_000)}</Markdown>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="search" className="mt-4 space-y-4">
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void search();
                  }}
                  placeholder="What are you looking for?"
                  aria-label="Search query"
                  data-testid="input-search-web"
                />
                <Button
                  className="gap-2"
                  onClick={() => void search()}
                  disabled={busy === 'search'}
                  data-testid="button-search-web"
                >
                  {busy === 'search' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  Search
                </Button>
              </div>

              {engine && (
                <p className="text-xs text-muted-foreground">
                  Results from {engine}
                  {engine === 'duckduckgo' &&
                    ' — store a search API key in Settings → API Keys for better results.'}
                </p>
              )}

              <ul className="space-y-2">
                {hits.map((hit) => (
                  <li
                    key={hit.url}
                    className="rounded-md border border-border bg-card p-3"
                  >
                    <a
                      href={hit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      {hit.title}
                    </a>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {hit.url}
                    </p>
                    {hit.snippet && (
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {hit.snippet}
                      </p>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1.5 h-7 px-2 text-xs"
                      onClick={() => {
                        setUrl(hit.url);
                        void readPage(hit.url);
                      }}
                    >
                      Read this page
                    </Button>
                  </li>
                ))}
              </ul>
            </TabsContent>

            <TabsContent value="control" className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com"
                  className="min-w-64 flex-1 font-mono text-sm"
                  aria-label="URL to navigate to"
                />
                <Button
                  className="gap-2"
                  onClick={() => void act({ action: 'navigate', url }, 'navigate')}
                  disabled={busy !== null || !url.trim()}
                  data-testid="button-navigate"
                >
                  {busy === 'navigate' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  Go
                </Button>
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => void act({ action: 'snapshot' }, 'snapshot')}
                  disabled={busy !== null}
                >
                  <RotateCcw className="h-4 w-4" />
                  Refresh view
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                <Input
                  value={selector}
                  onChange={(event) => setSelector(event.target.value)}
                  placeholder="CSS selector"
                  className="min-w-48 flex-1 font-mono text-sm"
                  aria-label="CSS selector"
                  data-testid="input-selector"
                />
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() => void act({ action: 'click', selector }, 'click')}
                  disabled={busy !== null || !selector.trim()}
                  data-testid="button-click"
                >
                  <MousePointerClick className="h-4 w-4" />
                  Click
                </Button>
                <Input
                  value={typeText}
                  onChange={(event) => setTypeText(event.target.value)}
                  placeholder="Text to type"
                  className="min-w-48 flex-1"
                  aria-label="Text to type"
                />
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={() =>
                    void act(
                      { action: 'type', selector, text: typeText, submit: true },
                      'type',
                    )
                  }
                  disabled={busy !== null || !selector.trim()}
                  data-testid="button-type"
                >
                  <Type className="h-4 w-4" />
                  Type + Enter
                </Button>
              </div>

              {action && (
                <div className="space-y-4">
                  {action.screenshotKey && (
                    <img
                      src={screenshotUrl(action.screenshotKey)}
                      alt={`Screenshot of ${action.url}`}
                      className="w-full rounded-lg border border-border"
                    />
                  )}

                  <Card className="border-card-border">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">
                        {action.title || '(untitled)'}
                      </CardTitle>
                      <CardDescription className="truncate font-mono text-xs">
                        {action.url}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {action.interactive.length > 0 && (
                        <div>
                          <h3 className="mb-1.5 text-sm font-medium">
                            Interactive elements
                          </h3>
                          <ul className="max-h-56 space-y-1 overflow-y-auto">
                            {action.interactive.map((element, index) => (
                              <li key={index} className="flex items-center gap-2 text-xs">
                                <button
                                  type="button"
                                  onClick={() => setSelector(element.selector)}
                                  className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono hover:bg-accent"
                                  title="Use this selector"
                                >
                                  {element.selector}
                                </button>
                                <span className="truncate text-muted-foreground">
                                  {element.text}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {action.text && (
                        <details>
                          <summary className="cursor-pointer text-sm text-muted-foreground">
                            Page text
                          </summary>
                          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs leading-relaxed">
                            {action.text}
                          </pre>
                        </details>
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}
