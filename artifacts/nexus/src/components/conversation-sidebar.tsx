import { useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Bot,
  Check,
  ChevronDown,
  Download,
  Folder,
  FolderPlus,
  Library,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { apiUrl } from '@/lib/api';
import {
  useConversations,
  useCreateFolder,
  useDeleteConversation,
  useFolders,
  useUpdateConversation,
} from '@/lib/queries';
import type { Conversation } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Conversation sidebar.
 *
 * Search covers titles and message bodies, so an untitled thread is still
 * findable. Threads group by recency the way you'd expect, pinned ones float,
 * and folders let a project's threads sit together.
 */

type Bucket = 'Pinned' | 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

const BUCKET_ORDER: Bucket[] = [
  'Pinned',
  'Today',
  'Yesterday',
  'Previous 7 days',
  'Older',
];

function bucketFor(conversation: Conversation): Bucket {
  if (conversation.pinned) return 'Pinned';
  const updated = new Date(conversation.updatedAt);
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const time = updated.getTime();
  if (time >= startOfToday) return 'Today';
  if (time >= startOfToday - 86_400_000) return 'Yesterday';
  if (time >= startOfToday - 7 * 86_400_000) return 'Previous 7 days';
  return 'Older';
}

export interface ConversationSidebarProps {
  activeId: number | null;
  onSelect: (id: number) => void;
  onNewChat: () => void;
  onOpenLibrary: () => void;
  onOpenAgents: () => void;
}

export function ConversationSidebar({
  activeId,
  onSelect,
  onNewChat,
  onOpenLibrary,
  onOpenAgents,
}: ConversationSidebarProps) {
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<number>>(new Set());

  const { data, isLoading } = useConversations(search || undefined, showArchived);
  const { data: folderData } = useFolders();
  const updateConversation = useUpdateConversation();
  const deleteConversation = useDeleteConversation();
  const createFolder = useCreateFolder();

  const conversations = data?.conversations ?? [];
  const folders = folderData?.folders ?? [];

  const { byFolder, unfiled } = useMemo(() => {
    const map = new Map<number, Conversation[]>();
    const loose: Conversation[] = [];
    for (const conversation of conversations) {
      if (conversation.folderId) {
        const list = map.get(conversation.folderId) ?? [];
        list.push(conversation);
        map.set(conversation.folderId, list);
      } else {
        loose.push(conversation);
      }
    }
    return { byFolder: map, unfiled: loose };
  }, [conversations]);

  const grouped = useMemo(() => {
    const map = new Map<Bucket, Conversation[]>();
    for (const conversation of unfiled) {
      const bucket = bucketFor(conversation);
      const list = map.get(bucket) ?? [];
      list.push(conversation);
      map.set(bucket, list);
    }
    return BUCKET_ORDER.filter((bucket) => map.has(bucket)).map(
      (bucket) => [bucket, map.get(bucket)!] as const,
    );
  }, [unfiled]);

  const commitRename = (id: number) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (title) updateConversation.mutate({ id, title });
  };

  const renderRow = (conversation: Conversation) => {
    const active = conversation.id === activeId;
    if (renamingId === conversation.id) {
      return (
        <li key={conversation.id} className="px-1">
          <Input
            autoFocus
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={() => commitRename(conversation.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename(conversation.id);
              if (event.key === 'Escape') setRenamingId(null);
            }}
            className="h-8 text-sm"
            aria-label="Conversation title"
          />
        </li>
      );
    }

    return (
      <li key={conversation.id} className="group/row relative">
        <button
          type="button"
          onClick={() => onSelect(conversation.id)}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 pr-8 text-left text-sm transition-all duration-150',
            active
              ? 'rail-active bg-sidebar-accent font-medium shadow-xs'
              : 'text-foreground/85 hover:bg-sidebar-accent/60 hover:text-foreground',
          )}
          data-testid={`link-conversation-${conversation.id}`}
        >
          {conversation.pinned ? (
            <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {conversation.title ?? 'Untitled'}
          </span>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 h-6 w-6 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              aria-label={`Options for ${conversation.title ?? 'conversation'}`}
              data-testid={`button-conversation-menu-${conversation.id}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={() => {
                setRenameDraft(conversation.title ?? '');
                setRenamingId(conversation.id);
              }}
            >
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                updateConversation.mutate({
                  id: conversation.id,
                  pinned: !conversation.pinned,
                })
              }
            >
              {conversation.pinned ? (
                <PinOff className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Pin className="mr-2 h-3.5 w-3.5" />
              )}
              {conversation.pinned ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                updateConversation.mutate({
                  id: conversation.id,
                  archived: !conversation.archived,
                })
              }
            >
              {conversation.archived ? (
                <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
              ) : (
                <Archive className="mr-2 h-3.5 w-3.5" />
              )}
              {conversation.archived ? 'Unarchive' : 'Archive'}
            </DropdownMenuItem>

            {folders.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Folder className="mr-2 h-3.5 w-3.5" />
                  Move to folder
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    onClick={() =>
                      updateConversation.mutate({
                        id: conversation.id,
                        folderId: null,
                      })
                    }
                  >
                    {conversation.folderId === null && (
                      <Check className="mr-2 h-3.5 w-3.5" />
                    )}
                    No folder
                  </DropdownMenuItem>
                  {folders.map((folder) => (
                    <DropdownMenuItem
                      key={folder.id}
                      onClick={() =>
                        updateConversation.mutate({
                          id: conversation.id,
                          folderId: folder.id,
                        })
                      }
                    >
                      {conversation.folderId === folder.id && (
                        <Check className="mr-2 h-3.5 w-3.5" />
                      )}
                      {folder.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Download className="mr-2 h-3.5 w-3.5" />
                Export
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem asChild>
                  <a
                    href={apiUrl(`/conversations/${conversation.id}/export?format=markdown`)}
                    download
                  >
                    Markdown
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a
                    href={apiUrl(`/conversations/${conversation.id}/export?format=json`)}
                    download
                  >
                    JSON
                  </a>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => deleteConversation.mutate(conversation.id)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-sidebar-border/70 p-3">
        <Button
          className="h-9 w-full justify-start gap-2 font-medium shadow-sm transition-transform duration-150 active:scale-[0.98]"
          onClick={onNewChat}
          data-testid="button-new-chat"
        >
          <Plus className="h-4 w-4" />
          New chat
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={onOpenLibrary}
            data-testid="button-open-library"
          >
            <Library className="h-3.5 w-3.5" />
            Library
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={onOpenAgents}
            data-testid="button-open-agents"
          >
            <Bot className="h-3.5 w-3.5" />
            Agents
          </Button>
        </div>
      </div>

      <div className="border-b border-sidebar-border p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search conversations"
            className="h-8 bg-sidebar-accent/50 pl-8 text-sm"
            aria-label="Search conversations"
            data-testid="input-search-conversations"
          />
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-3 p-2">
          {isLoading && (
            <div className="space-y-1.5 p-1" aria-busy="true" aria-label="Loading conversations">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <div
                  key={index}
                  className="skeleton h-8"
                  style={{ opacity: 1 - index * 0.13 }}
                />
              ))}
            </div>
          )}

          {!isLoading && conversations.length === 0 && (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              {search ? 'Nothing matched that search.' : 'No conversations yet.'}
            </p>
          )}

          {/* Folders */}
          {folders.map((folder) => {
            const list = byFolder.get(folder.id) ?? [];
            if (list.length === 0 && !search) return null;
            const collapsed = collapsedFolders.has(folder.id);
            return (
              <section key={folder.id}>
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedFolders((current) => {
                      const next = new Set(current);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  aria-expanded={!collapsed}
                >
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 transition-transform',
                      collapsed && '-rotate-90',
                    )}
                  />
                  <Folder className="h-3.5 w-3.5" />
                  <span className="flex-1 truncate text-left">{folder.name}</span>
                  <span className="tabular-nums">{list.length}</span>
                </button>
                {!collapsed && <ul className="mt-0.5 space-y-0.5">{list.map(renderRow)}</ul>}
              </section>
            );
          })}

          {/* Date buckets */}
          {grouped.map(([bucket, list]) => (
            <section key={bucket}>
              <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {bucket}
              </h3>
              <ul className="space-y-0.5">{list.map(renderRow)}</ul>
            </section>
          ))}
        </div>
      </ScrollArea>

      <div className="space-y-1 border-t border-sidebar-border p-2">
        {creatingFolder ? (
          <Input
            autoFocus
            value={folderDraft}
            onChange={(event) => setFolderDraft(event.target.value)}
            onBlur={() => setCreatingFolder(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && folderDraft.trim()) {
                createFolder.mutate(folderDraft.trim());
                setFolderDraft('');
                setCreatingFolder(false);
              }
              if (event.key === 'Escape') setCreatingFolder(false);
            }}
            placeholder="Folder name"
            className="h-8 text-sm"
            aria-label="New folder name"
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 text-xs"
            onClick={() => setCreatingFolder(true)}
            data-testid="button-new-folder"
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New folder
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start gap-2 text-xs"
          onClick={() => setShowArchived((value) => !value)}
          data-testid="button-toggle-archived"
        >
          <Archive className="h-3.5 w-3.5" />
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Button>
      </div>
    </div>
  );
}
