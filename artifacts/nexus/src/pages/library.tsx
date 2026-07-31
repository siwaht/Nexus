import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FileArchive,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Film,
  Image as ImageIcon,
  Library as LibraryIcon,
  Loader2,
  MessageSquarePlus,
  Music,
  Presentation,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';

import { Markdown } from '@/components/output/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { fileUrl } from '@/lib/api';
import {
  useDeleteFile,
  useFile,
  useFiles,
  useReindexFile,
  useUploadFiles,
} from '@/lib/queries';
import type { LibraryFile } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The Library.
 *
 * Everything uploaded, with live ingestion status, filters, full-text search
 * over extracted content, and a viewer per type. Every viewer has "Ask about
 * this", which opens a conversation scoped to that one document.
 */

const KIND_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'pdf', label: 'PDF' },
  { value: 'document', label: 'Docs' },
  { value: 'spreadsheet', label: 'Sheets' },
  { value: 'presentation', label: 'Slides' },
  { value: 'ebook', label: 'Ebooks' },
  { value: 'text', label: 'Text' },
  { value: 'code', label: 'Code' },
  { value: 'image', label: 'Images' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
];

function kindIcon(kind: string) {
  switch (kind) {
    case 'pdf':
    case 'document':
    case 'ebook':
      return <FileText className="h-4 w-4" />;
    case 'spreadsheet':
      return <FileSpreadsheet className="h-4 w-4" />;
    case 'presentation':
      return <Presentation className="h-4 w-4" />;
    case 'code':
      return <FileCode2 className="h-4 w-4" />;
    case 'image':
      return <ImageIcon className="h-4 w-4" />;
    case 'audio':
      return <Music className="h-4 w-4" />;
    case 'video':
      return <Film className="h-4 w-4" />;
    case 'archive':
      return <FileArchive className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function statusLabel(file: LibraryFile): string {
  switch (file.status) {
    case 'queued':
      return 'Queued';
    case 'extracting':
      return 'Extracting text';
    case 'chunking':
      return 'Chunking';
    case 'embedding':
      return 'Embedding';
    case 'ready':
      return 'Ready';
    default:
      return 'Failed';
  }
}

export interface LibraryPageProps {
  selectedFileId: number | null;
  onSelectFile: (fileId: number | null) => void;
  onAskAbout: (fileId: number, filename: string) => void;
  onBack: () => void;
}

export default function LibraryPage({
  selectedFileId,
  onSelectFile,
  onAskAbout,
  onBack,
}: LibraryPageProps) {
  const { toast } = useToast();
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const { data, isLoading } = useFiles(kind, search || undefined);
  const upload = useUploadFiles();
  const deleteFile = useDeleteFile();
  const reindex = useReindexFile();

  const files = data?.files ?? [];
  const ffmpegMissing = data?.media && !data.media.ffmpeg;

  const handleUpload = (selected: File[]) => {
    if (selected.length === 0) return;
    upload.mutate(selected, {
      onSuccess: (result) => {
        if (result.accepted.length > 0) {
          toast({
            title: `${result.accepted.length} file${result.accepted.length === 1 ? '' : 's'} uploaded`,
            description: 'Ingestion is running in the background.',
          });
        }
        for (const rejection of result.rejected) {
          toast({
            variant: 'destructive',
            title: `${rejection.filename} was rejected`,
            description: rejection.reason,
          });
        }
      },
      onError: (err: unknown) => {
        toast({
          variant: 'destructive',
          title: 'Upload failed',
          description: err instanceof Error ? err.message : undefined,
        });
      },
    });
  };

  if (selectedFileId) {
    return (
      <FileViewer
        fileId={selectedFileId}
        onBack={() => onSelectFile(null)}
        onAskAbout={onAskAbout}
      />
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        handleUpload(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="glass shrink-0 border-b border-border/70 px-4 py-3">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2"
            onClick={onBack}
            data-testid="button-back-to-chat"
          >
            <ArrowLeft className="h-4 w-4" />
            Chat
          </Button>
          <div className="flex-1">
            <h1 className="flex items-center gap-2 font-display text-xl font-semibold tracking-tight">
              <LibraryIcon className="h-5 w-5 text-primary" />
              Library
            </h1>
            <p className="text-sm text-muted-foreground">
              {files.length} {files.length === 1 ? 'file' : 'files'} · searchable
              across extracted content
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              handleUpload(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <Button
            className="gap-2"
            onClick={() => inputRef.current?.click()}
            disabled={upload.isPending}
            data-testid="button-upload"
          >
            {upload.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            Upload
          </Button>
        </div>
      </header>

      <div className="shrink-0 space-y-3 border-b border-border px-4 py-3">
        <div className="mx-auto max-w-6xl space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search filenames and extracted text"
              className="h-9 pl-8"
              aria-label="Search library"
              data-testid="input-search-library"
            />
          </div>
          <Tabs value={kind} onValueChange={setKind}>
            <TabsList className="h-auto flex-wrap justify-start gap-1 bg-transparent p-0">
              {KIND_FILTERS.map((filter) => (
                <TabsTrigger
                  key={filter.value}
                  value={filter.value}
                  className="h-7 rounded-md px-2.5 text-xs data-[state=active]:bg-accent"
                  data-testid={`tab-kind-${filter.value}`}
                >
                  {filter.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {ffmpegMissing && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ffmpeg isn't installed, so video ingestion and long-audio chunking
              are unavailable. Install ffmpeg or set FFMPEG_PATH.
            </p>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-6xl p-4">
          {isLoading && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <div key={index} className="h-28 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          )}

          {!isLoading && files.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="py-16 text-center">
                <Upload className="mx-auto h-10 w-10 text-muted-foreground" />
                <p className="mt-4 font-medium">Nothing here yet</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  Drop files anywhere on this page, or use Upload. PDFs, Office
                  files, ebooks, text, code, images, audio, video and zip
                  archives all work.
                </p>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {files.map((file) => (
              <Card
                key={file.id}
                className={cn(
                  'group cursor-pointer border-card-border transition-all duration-200',
                  'hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md',
                  file.status === 'failed' && 'border-destructive/40',
                )}
                onClick={() => onSelectFile(file.id)}
                data-testid={`card-file-${file.id}`}
              >
                <CardContent className="space-y-2 p-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-muted-foreground">
                      {kindIcon(file.kind)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={file.filename}>
                        {file.filename}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatBytes(file.size)}
                        {file.pageCount ? ` · ${file.pageCount} pages` : ''}
                        {file.durationS ? ` · ${formatDuration(file.durationS)}` : ''}
                        {file.usedInChats > 0
                          ? ` · used in ${file.usedInChats} chats`
                          : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(event) => {
                          event.stopPropagation();
                          reindex.mutate(file.id);
                        }}
                        aria-label="Re-index"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteFile.mutate(file.id);
                        }}
                        aria-label="Delete file"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {file.status === 'ready' ? (
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      Ready
                    </Badge>
                  ) : file.status === 'failed' ? (
                    <p className="line-clamp-3 text-xs text-destructive">
                      {file.error ?? 'Ingestion failed.'}
                    </p>
                  ) : (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{statusLabel(file)}</span>
                        <span>{file.progress}%</span>
                      </div>
                      <Progress value={file.progress} className="h-1" />
                    </div>
                  )}

                  {file.error && file.status === 'ready' && (
                    <p className="line-clamp-2 text-[11px] text-amber-600 dark:text-amber-500">
                      {file.error}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </ScrollArea>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-dashed border-primary px-8 py-6 text-center">
            <p className="font-medium">Drop to upload</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

function FileViewer({
  fileId,
  onBack,
  onAskAbout,
}: {
  fileId: number;
  onBack: () => void;
  onAskAbout: (fileId: number, filename: string) => void;
}) {
  const { data, isLoading } = useFile(fileId, true);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  const file = data?.file;
  const chunks = data?.chunks ?? [];

  const transcript = useMemo(() => {
    const raw = file?.metadataJson?.transcriptSegments;
    return Array.isArray(raw) ? (raw as TranscriptSegment[]) : [];
  }, [file]);

  if (isLoading || !file) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const seek = (seconds: number) => {
    if (mediaRef.current) {
      mediaRef.current.currentTime = seconds;
      void mediaRef.current.play();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border bg-card px-4 py-3">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-2" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
            Library
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{file.filename}</h1>
            <p className="text-xs text-muted-foreground">
              {file.kind} · {formatBytes(file.size)} · {data?.chunkCount ?? 0} indexed
              passages
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="gap-2">
            <a href={fileUrl(file.id, true)} download>
              <Download className="h-4 w-4" />
              Download
            </a>
          </Button>
          <Button
            size="sm"
            className="gap-2"
            onClick={() => onAskAbout(file.id, file.filename)}
            data-testid="button-ask-about"
          >
            <MessageSquarePlus className="h-4 w-4" />
            Ask about this
          </Button>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl space-y-4 p-4">
          {file.status !== 'ready' && (
            <Card
              className={cn(
                file.status === 'failed' ? 'border-destructive/40' : 'border-border',
              )}
            >
              <CardContent className="py-4">
                {file.status === 'failed' ? (
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{file.error ?? 'Ingestion failed.'}</span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm">{statusLabel(file)}…</p>
                    <Progress value={file.progress} className="h-1" />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {file.kind === 'video' && (
            <div className="space-y-2">
              <video
                ref={mediaRef as React.RefObject<HTMLVideoElement>}
                src={fileUrl(file.id)}
                controls
                className="w-full rounded-lg border border-border bg-black"
              />
              <p className="text-xs text-muted-foreground">
                Video is read as its audio transcript plus captions of sampled
                frames — not native video understanding.
              </p>
            </div>
          )}

          {file.kind === 'audio' && (
            <audio
              ref={mediaRef as React.RefObject<HTMLAudioElement>}
              src={fileUrl(file.id)}
              controls
              className="w-full"
            />
          )}

          {file.kind === 'image' && (
            <img
              src={fileUrl(file.id)}
              alt={file.filename}
              className="mx-auto max-h-[70vh] rounded-lg border border-border"
            />
          )}

          {file.kind === 'pdf' && (
            <iframe
              src={fileUrl(file.id)}
              title={file.filename}
              className="h-[75vh] w-full rounded-lg border border-border"
            />
          )}

          {transcript.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-3 text-sm font-medium">Transcript</h2>
                <ol className="space-y-1.5">
                  {transcript.map((segment, index) => (
                    <li key={index} className="flex gap-2 text-sm">
                      <button
                        type="button"
                        onClick={() => seek(segment.start)}
                        className="shrink-0 font-mono text-xs text-primary hover:underline"
                        aria-label={`Seek to ${formatDuration(segment.start)}`}
                      >
                        {formatDuration(segment.start)}
                      </button>
                      <span className="leading-relaxed">{segment.text}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}

          {chunks.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <h2 className="mb-3 text-sm font-medium">
                  Indexed passages ({chunks.length})
                </h2>
                <div className="space-y-3">
                  {chunks.map((chunk) => (
                    <div
                      key={chunk.id}
                      id={`chunk-${chunk.id}`}
                      className="rounded-md border border-border bg-muted/20 p-3"
                    >
                      {chunk.pageOrTimestamp && (
                        <Badge variant="secondary" className="mb-2 h-5 px-1.5 text-[10px]">
                          {chunk.pageOrTimestamp}
                        </Badge>
                      )}
                      <div className="text-sm">
                        <Markdown>{chunk.text}</Markdown>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
