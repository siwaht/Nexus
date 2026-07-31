import { ExternalLink, FileText, Globe, MessageSquare, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Citation } from '@/lib/types';

/**
 * The sources panel.
 *
 * Everything the answer leaned on: library passages with their page or
 * timestamp and similarity score, and web pages with their URL. Clicking a file
 * source opens the document viewer at that passage.
 */

function sourceIcon(citation: Citation) {
  switch (citation.sourceType) {
    case 'url':
      return <Globe className="h-3.5 w-3.5" />;
    case 'message':
      return <MessageSquare className="h-3.5 w-3.5" />;
    default:
      return <FileText className="h-3.5 w-3.5" />;
  }
}

export interface SourcesPanelProps {
  citations: Citation[];
  onClose: () => void;
  onOpenFile: (fileId: number, locator: string | null) => void;
}

export function SourcesPanel({
  citations,
  onClose,
  onOpenFile,
}: SourcesPanelProps) {
  return (
    <aside
      className="flex h-full w-full flex-col border-l border-border bg-card"
      aria-label="Sources"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="flex-1">
          <p className="text-sm font-medium">Sources</p>
          <p className="text-xs text-muted-foreground">
            {citations.length} {citations.length === 1 ? 'reference' : 'references'}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          aria-label="Close sources panel"
          data-testid="button-close-sources"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <ScrollArea className="flex-1">
        <ol className="divide-y divide-border">
          {citations.map((citation, index) => (
            <li key={`${citation.sourceType}-${index}`} className="p-3">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-medium">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {sourceIcon(citation)}
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">
                      {citation.title}
                    </p>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {citation.locator && (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                        {citation.locator}
                      </Badge>
                    )}
                    {citation.score !== null && (
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                        {(citation.score * 100).toFixed(0)}% match
                      </Badge>
                    )}
                  </div>

                  {citation.snippet && (
                    <p className="mt-1.5 line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                      {citation.snippet}
                    </p>
                  )}

                  <div className="mt-2">
                    {citation.sourceType === 'file' && citation.fileId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 px-2 text-xs"
                        onClick={() =>
                          onOpenFile(citation.fileId!, citation.locator)
                        }
                        data-testid={`button-open-source-${index}`}
                      >
                        Open in Library
                      </Button>
                    ) : citation.url ? (
                      <Button asChild variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs">
                        <a href={citation.url} target="_blank" rel="noopener noreferrer">
                          Open page
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>

        {citations.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No sources for this answer.
          </p>
        )}
      </ScrollArea>
    </aside>
  );
}
