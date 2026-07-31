import { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { ArrowDown, ArrowUp, Check, Copy, Download, Table2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';

/**
 * Markdown rendering for assistant output.
 *
 * GitHub-flavoured markdown, KaTeX maths, and syntax-highlighted code. Raw HTML
 * is not enabled, so model output can't inject markup — that's the XSS defence,
 * and it's why there's no `rehype-raw` here.
 *
 * Tables and code blocks are replaced with interactive versions: tables sort by
 * column and copy as CSV, code blocks get a language label, copy and download.
 */

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Flatten a hast subtree to plain text — used for copy/download/sorting. */
function nodeText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(nodeText).join('');
}

function findTag(node: HastNode | undefined, tagName: string): HastNode | undefined {
  if (!node) return undefined;
  if (node.tagName === tagName) return node;
  for (const child of node.children ?? []) {
    const found = findTag(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function collectRows(section: HastNode | undefined): string[][] {
  if (!section) return [];
  return (section.children ?? [])
    .filter((child) => child.tagName === 'tr')
    .map((row) =>
      (row.children ?? [])
        .filter((cell) => cell.tagName === 'td' || cell.tagName === 'th')
        .map((cell) => nodeText(cell).trim()),
    );
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };
  return [copied, copy];
}

function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------

const EXTENSIONS: Record<string, string> = {
  typescript: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  jsx: 'jsx',
  python: 'py',
  ruby: 'rb',
  rust: 'rs',
  golang: 'go',
  go: 'go',
  java: 'java',
  kotlin: 'kt',
  csharp: 'cs',
  cpp: 'cpp',
  c: 'c',
  shell: 'sh',
  bash: 'sh',
  sql: 'sql',
  json: 'json',
  yaml: 'yml',
  html: 'html',
  css: 'css',
  markdown: 'md',
};

function CodeBlock({
  node,
  children,
}: {
  node?: HastNode;
  children?: React.ReactNode;
}) {
  const [copied, copy] = useCopy();
  const codeNode = findTag(node, 'code');
  const source = nodeText(codeNode);

  const className = String(
    (codeNode?.properties?.className as string[] | undefined)?.join(' ') ?? '',
  );
  const language =
    /language-([a-z0-9+#-]+)/i.exec(className)?.[1]?.toLowerCase() ?? null;
  const lineCount = source.split('\n').length;

  return (
    <div className="group relative my-4 overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--code-surface))] shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-[hsl(var(--code-header))] px-3 py-1.5">
        <span className="font-mono text-xs text-slate-400">
          {language ?? 'text'}
          <span className="ml-2 opacity-60">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        </span>
        <div className="flex items-center gap-1 text-slate-300">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => copy(source)}
            aria-label="Copy code"
            data-testid="button-copy-code"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() =>
              downloadText(
                source,
                `snippet.${language ? (EXTENSIONS[language] ?? language) : 'txt'}`,
                'text/plain',
              )
            }
            aria-label="Download code"
            data-testid="button-download-code"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <pre className="overflow-x-auto p-4 text-[12.5px] leading-[1.7] text-slate-100">
        {children}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function toCsv(header: string[], rows: string[][]): string {
  const escape = (cell: string) =>
    /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
}

function DataTable({ node }: { node?: HastNode }) {
  const [copied, copy] = useCopy();
  const [sort, setSort] = useState<{ column: number; direction: 1 | -1 } | null>(
    null,
  );

  const { header, rows } = useMemo(() => {
    const headRows = collectRows(findTag(node, 'thead'));
    const bodyRows = collectRows(findTag(node, 'tbody'));
    return {
      header: headRows[0] ?? [],
      rows: bodyRows.length > 0 ? bodyRows : headRows.slice(1),
    };
  }, [node]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const numeric = rows.every((row) => {
      const cell = row[sort.column] ?? '';
      return cell === '' || !Number.isNaN(Number.parseFloat(cell.replace(/[$,%\s]/g, '')));
    });
    return [...rows].sort((a, b) => {
      const left = a[sort.column] ?? '';
      const right = b[sort.column] ?? '';
      if (numeric) {
        const l = Number.parseFloat(left.replace(/[$,%\s]/g, '')) || 0;
        const r = Number.parseFloat(right.replace(/[$,%\s]/g, '')) || 0;
        return (l - r) * sort.direction;
      }
      return left.localeCompare(right) * sort.direction;
    });
  }, [rows, sort]);

  if (header.length === 0 && rows.length === 0) return null;

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Table2 className="h-3.5 w-3.5" />
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => copy(toCsv(header, sorted))}
          data-testid="button-copy-csv"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy as CSV'}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/20">
              {header.map((cell, index) => {
                const active = sort?.column === index;
                return (
                  <th key={index} scope="col" className="p-0 text-left">
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 px-3 py-2 text-left font-medium hover:bg-muted/40"
                      onClick={() =>
                        setSort((current) =>
                          current?.column === index
                            ? { column: index, direction: current.direction === 1 ? -1 : 1 }
                            : { column: index, direction: 1 },
                        )
                      }
                      aria-label={`Sort by ${cell || `column ${index + 1}`}`}
                    >
                      {cell}
                      {active &&
                        (sort.direction === 1 ? (
                          <ArrowUp className="h-3 w-3 shrink-0" />
                        ) : (
                          <ArrowDown className="h-3 w-3 shrink-0" />
                        ))}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className="border-b border-border/50 last:border-0 hover:bg-muted/20"
              >
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-3 py-2 align-top">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const components: Components = {
  pre: (props) => <CodeBlock node={props.node as HastNode} children={props.children} />,
  table: (props) => <DataTable node={props.node as HastNode} />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...rest }) => {
    // Inline code only — block code is handled by the `pre` override.
    const isBlock = String(className ?? '').includes('language-');
    if (isBlock) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em]">
        {children}
      </code>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-primary/40 pl-4 text-muted-foreground">
      {children}
    </blockquote>
  ),
};

export interface MarkdownProps {
  children: string;
  className?: string;
}

export const Markdown = memo(function Markdown({
  children,
  className,
}: MarkdownProps) {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none',
        // Display face and tighter tracking on headings, matching the app shell.
        'prose-headings:font-display prose-headings:font-semibold prose-headings:tracking-tight',
        'prose-h1:text-xl prose-h2:mt-6 prose-h2:text-lg prose-h3:text-base',
        // Generous line height is what makes long answers readable.
        'prose-p:leading-[1.72] prose-li:leading-[1.72] prose-p:text-[0.9375rem] prose-li:text-[0.9375rem]',
        // The CodeBlock component owns its own chrome, so strip prose's.
        'prose-pre:m-0 prose-pre:bg-transparent prose-pre:p-0',
        'prose-code:before:content-none prose-code:after:content-none',
        'prose-strong:font-semibold prose-strong:text-foreground',
        'prose-hr:border-border',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeKatex,
          // `ignoreMissing` keeps an unknown language from throwing mid-render.
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

export { downloadText };
