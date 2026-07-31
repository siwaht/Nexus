import { Download, FileText, ImageIcon, Music, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { screenshotUrl } from '@/lib/api';
import type { Artifact } from '@/lib/types';

import { ChartView, parseChartSpec } from './chart-view';
import { Markdown, downloadText } from './markdown';
import { MermaidView } from './mermaid-view';

/**
 * Artifacts: the side panel for anything too big or too visual to belong in the
 * chat scroll — long documents, charts, diagrams, generated images, TTS audio.
 */

function artifactIcon(kind: Artifact['kind']) {
  switch (kind) {
    case 'image':
      return <ImageIcon className="h-4 w-4" />;
    case 'audio':
      return <Music className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
}

export function ArtifactBody({ artifact }: { artifact: Artifact }) {
  switch (artifact.kind) {
    case 'chart': {
      const spec = parseChartSpec(artifact.content);
      if (!spec) {
        return (
          <p className="p-4 text-sm text-muted-foreground">
            The chart data could not be read.
          </p>
        );
      }
      return <ChartView spec={spec} height={360} />;
    }
    case 'mermaid':
      return (
        <MermaidView source={artifact.content ?? ''} title={artifact.title} />
      );
    case 'image':
      return artifact.storageKey ? (
        <img
          src={screenshotUrl(artifact.storageKey)}
          alt={artifact.title ?? 'Generated image'}
          className="mx-auto max-h-[70vh] rounded-lg border border-border"
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">The image is missing.</p>
      );
    case 'audio':
      return artifact.storageKey ? (
        <audio
          controls
          src={screenshotUrl(artifact.storageKey)}
          className="w-full"
          aria-label={artifact.title ?? 'Generated audio'}
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">The audio is missing.</p>
      );
    case 'code':
      return (
        <Markdown>{`\`\`\`${artifact.language ?? ''}\n${artifact.content ?? ''}\n\`\`\``}</Markdown>
      );
    default:
      return <Markdown>{artifact.content ?? ''}</Markdown>;
  }
}

export interface ArtifactPanelProps {
  artifact: Artifact;
  onClose: () => void;
}

export function ArtifactPanel({ artifact, onClose }: ArtifactPanelProps) {
  const downloadable = artifact.kind === 'markdown' || artifact.kind === 'code';

  return (
    <aside
      className="flex h-full w-full flex-col border-l border-border bg-card"
      aria-label="Artifact panel"
    >
      <header className="glass flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-4">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          {artifactIcon(artifact.kind)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm font-semibold">
            {artifact.title ?? 'Artifact'}
          </p>
          <Badge variant="outline" className="mt-0.5 h-4 px-1 text-[10px]">
            {artifact.kind}
          </Badge>
        </div>
        {downloadable && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() =>
              downloadText(
                artifact.content ?? '',
                `${(artifact.title ?? 'artifact').replace(/[^\w-]+/g, '-')}.${
                  artifact.kind === 'code' ? (artifact.language ?? 'txt') : 'md'
                }`,
                'text/plain',
              )
            }
            aria-label="Download artifact"
            data-testid="button-download-artifact"
          >
            <Download className="h-4 w-4" />
          </Button>
        )}
        {artifact.storageKey && (
          <Button asChild variant="ghost" size="icon" className="h-8 w-8">
            <a
              href={screenshotUrl(artifact.storageKey)}
              download
              aria-label="Download file"
            >
              <Download className="h-4 w-4" />
            </a>
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          aria-label="Close artifact panel"
          data-testid="button-close-artifact"
        >
          <X className="h-4 w-4" />
        </Button>
      </header>

      <ScrollArea className="flex-1">
        <div className="p-4">
          <ArtifactBody artifact={artifact} />
        </div>
      </ScrollArea>
    </aside>
  );
}

/** Compact inline card shown under a message for each artifact it produced. */
export function ArtifactChip({
  artifact,
  onOpen,
}: {
  artifact: Artifact;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-center gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-1.5 text-left text-xs shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-sm"
      data-testid={`chip-artifact-${artifact.id}`}
    >
      <span className="text-primary">{artifactIcon(artifact.kind)}</span>
      <span className="max-w-48 truncate font-medium">
        {artifact.title ?? artifact.kind}
      </span>
      <span className="text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5">
        →
      </span>
    </button>
  );
}
