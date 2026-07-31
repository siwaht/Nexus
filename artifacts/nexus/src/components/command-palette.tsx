import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  Bot,
  Brain,
  Database,
  Globe,
  Key,
  KeyRound,
  Library,
  MessageSquare,
  Moon,
  Palette,
  Plug,
  Plus,
  Settings,
  Sparkles,
  Sun,
  Wrench,
} from 'lucide-react';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useTheme } from '@/lib/theme-provider';
import { useConversations } from '@/lib/queries';

/**
 * Command palette (Cmd/Ctrl+K).
 *
 * One keystroke to anywhere: a conversation, a settings tab, a new chat, or the
 * theme. Registers the global shortcuts for the rest of the app too, so they
 * live in one place instead of scattered across components.
 */

export interface CommandPaletteProps {
  onNewChat: () => void;
  onOpenConversation: (id: number) => void;
  onOpenLibrary: () => void;
  onOpenAgents: () => void;
  onOpenBrowser: () => void;
  onFocusComposer: () => void;
  onToggleSidebar: () => void;
}

export function CommandPalette({
  onNewChat,
  onOpenConversation,
  onOpenLibrary,
  onOpenAgents,
  onOpenBrowser,
  onFocusComposer,
  onToggleSidebar,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const { resolvedTheme, setTheme } = useTheme();
  const { data } = useConversations();

  const conversations = useMemo(
    () => (data?.conversations ?? []).slice(0, 12),
    [data],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;

      switch (event.key.toLowerCase()) {
        case 'k':
          event.preventDefault();
          setOpen((value) => !value);
          break;
        case 'n':
          event.preventDefault();
          onNewChat();
          break;
        case '/':
          event.preventDefault();
          onFocusComposer();
          break;
        case 'b':
          event.preventDefault();
          onToggleSidebar();
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onNewChat, onFocusComposer, onToggleSidebar]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search conversations or jump to a screen…" />
      <CommandList>
        <CommandEmpty>Nothing matched.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => run(onNewChat)}>
            <Plus className="mr-2 h-4 w-4" />
            New chat
            <kbd className="ml-auto text-[10px] text-muted-foreground">⌘N</kbd>
          </CommandItem>
          <CommandItem onSelect={() => run(onOpenLibrary)}>
            <Library className="mr-2 h-4 w-4" />
            Open the Library
          </CommandItem>
          <CommandItem onSelect={() => run(onOpenAgents)}>
            <Bot className="mr-2 h-4 w-4" />
            Run a multi-agent task
          </CommandItem>
          <CommandItem onSelect={() => run(onOpenBrowser)}>
            <Globe className="mr-2 h-4 w-4" />
            Open the web panel
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))
            }
          >
            {resolvedTheme === 'dark' ? (
              <Sun className="mr-2 h-4 w-4" />
            ) : (
              <Moon className="mr-2 h-4 w-4" />
            )}
            Switch to {resolvedTheme === 'dark' ? 'light' : 'dark'} mode
          </CommandItem>
        </CommandGroup>

        {conversations.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Conversations">
              {conversations.map((conversation) => (
                <CommandItem
                  key={conversation.id}
                  value={`${conversation.title ?? 'Untitled'} ${conversation.id}`}
                  onSelect={() => run(() => onOpenConversation(conversation.id))}
                >
                  <MessageSquare className="mr-2 h-4 w-4" />
                  <span className="truncate">{conversation.title ?? 'Untitled'}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Settings">
          {[
            { path: 'providers', label: 'Providers', icon: KeyRound },
            { path: 'models', label: 'Models', icon: Sparkles },
            { path: 'tools', label: 'Tools and permissions', icon: Wrench },
            { path: 'mcp', label: 'MCP servers', icon: Plug },
            { path: 'skills', label: 'Skills', icon: Bot },
            { path: 'keys', label: 'API keys', icon: Key },
            { path: 'memory', label: 'Memory', icon: Brain },
            { path: 'appearance', label: 'Appearance', icon: Palette },
            { path: 'data', label: 'Data and usage', icon: Database },
          ].map((entry) => {
            const Icon = entry.icon;
            return (
              <CommandItem
                key={entry.path}
                value={`settings ${entry.label}`}
                onSelect={() => run(() => navigate(`/settings/${entry.path}`))}
              >
                <Icon className="mr-2 h-4 w-4" />
                {entry.label}
              </CommandItem>
            );
          })}
          <CommandItem value="settings" onSelect={() => run(() => navigate('/settings'))}>
            <Settings className="mr-2 h-4 w-4" />
            All settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
