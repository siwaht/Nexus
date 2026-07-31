import { useEffect, useId, useRef, useState } from 'react';
import { Check, Code2, Copy, Eye } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme-provider';

/**
 * Mermaid diagram with a source toggle.
 *
 * Mermaid is a heavy dependency, so it's imported dynamically the first time a
 * diagram actually appears rather than loaded with the app shell. A syntax
 * error in model-generated source renders as the error plus the source, which is
 * what you need to fix it.
 */

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

async function loadMermaid(dark: boolean) {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((module) => module.default);
  }
  const mermaid = await mermaidPromise;
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    // Model output is untrusted: strict blocks click handlers and raw HTML
    // inside node labels.
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
  return mermaid;
}

export interface MermaidViewProps {
  source: string;
  title?: string | null;
}

export function MermaidView({ source, title }: MermaidViewProps) {
  const { resolvedTheme: theme } = useTheme();
  const reactId = useId();
  const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);

  const isDark = theme === 'dark';

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const mermaid = await loadMermaid(isDark);
        const { svg } = await mermaid.render(renderId, source);
        if (cancelled) return;
        if (containerRef.current) containerRef.current.innerHTML = svg;
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : 'The diagram source is not valid.',
        );
        setShowSource(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, isDark, renderId]);

  return (
    <figure className="my-4 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <figcaption className="truncate text-sm font-medium">
          {title ?? 'Diagram'}
        </figcaption>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => setShowSource((value) => !value)}
            data-testid="button-toggle-mermaid-source"
          >
            {showSource ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <Code2 className="h-3.5 w-3.5" />
            )}
            {showSource ? 'Diagram' : 'Source'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => {
              void navigator.clipboard.writeText(source).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              });
            }}
            aria-label="Copy diagram source"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {error && (
        <p className="border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {showSource ? (
        <pre className="overflow-x-auto bg-[hsl(var(--code-surface))] p-4 text-[12.5px] leading-[1.7] text-slate-100">
          <code>{source}</code>
        </pre>
      ) : (
        <div
          ref={containerRef}
          className="flex justify-center overflow-x-auto p-4 [&_svg]:max-w-full"
          role="img"
          aria-label={title ?? 'Diagram'}
        />
      )}
    </figure>
  );
}
