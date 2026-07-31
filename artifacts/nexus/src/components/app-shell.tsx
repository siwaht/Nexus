import { useState } from 'react';
import { Link, useRoute } from 'wouter';
import {
  Circle,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sun,
  Terminal,
} from 'lucide-react';

import { useAuth } from '@workspace/replit-auth-web';
import { useHealthCheck } from '@workspace/api-client-react';

import { ConversationSidebar } from '@/components/conversation-sidebar';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTheme } from '@/lib/theme-provider';
import { cn } from '@/lib/utils';

/**
 * The app shell: sidebar plus top bar.
 *
 * On phones the sidebar becomes a sheet so the thread gets the full width and
 * everything stays reachable one-handed.
 */

export interface AppShellProps {
  children: React.ReactNode;
  activeConversationId: number | null;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  onSelectConversation: (id: number) => void;
  onNewChat: () => void;
  onOpenLibrary: () => void;
  onOpenAgents: () => void;
}

export function AppShell({
  children,
  activeConversationId,
  sidebarOpen,
  onSidebarOpenChange,
  onSelectConversation,
  onNewChat,
  onOpenLibrary,
  onOpenAgents,
}: AppShellProps) {
  const { user, logout } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const [isSettingsRoute] = useRoute('/settings/:rest*');
  const [isSettingsRoot] = useRoute('/settings');
  const { data: health } = useHealthCheck();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  const onSettings = isSettingsRoute || isSettingsRoot;

  const initials =
    `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() ||
    user?.email?.[0]?.toUpperCase() ||
    'U';

  const sidebar = (
    <ConversationSidebar
      activeId={activeConversationId}
      onSelect={(id) => {
        onSelectConversation(id);
        setSheetOpen(false);
      }}
      onNewChat={() => {
        onNewChat();
        setSheetOpen(false);
      }}
      onOpenLibrary={() => {
        onOpenLibrary();
        setSheetOpen(false);
      }}
      onOpenAgents={() => {
        onOpenAgents();
        setSheetOpen(false);
      }}
    />
  );

  return (
    <div className="flex h-[100dvh] w-full bg-background">
      {/* Desktop sidebar */}
      {!isMobile && (
        <aside
          className={cn(
            'glass-sidebar shrink-0 overflow-hidden border-r border-sidebar-border transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
            sidebarOpen ? 'w-72' : 'w-0',
          )}
          aria-label="Conversations"
        >
          <div className="h-full w-72">{sidebar}</div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3">
          {isMobile ? (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Open conversations"
                  data-testid="button-open-sidebar-sheet"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 p-0">
                <SheetTitle className="sr-only">Conversations</SheetTitle>
                {sidebar}
              </SheetContent>
            </Sheet>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onSidebarOpenChange(!sidebarOpen)}
              aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              data-testid="button-toggle-sidebar"
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-5 w-5" />
              ) : (
                <PanelLeftOpen className="h-5 w-5" />
              )}
            </Button>
          )}

          <Link
            href="/"
            className="group flex shrink-0 items-center gap-2.5 rounded-lg px-1 py-1"
            aria-label="Nexus home"
          >
            <span className="brand-mark flex h-7 w-7 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-105">
              <Terminal className="h-4 w-4 text-primary-foreground" />
            </span>
            <span className="font-display text-[1.0625rem] font-semibold tracking-tight">
              Nexus
            </span>
          </Link>

          <div className="flex-1" />

          {health && (
            <span className="mr-1 hidden items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground sm:flex">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              Connected
            </span>
          )}

          <Button
            asChild
            variant={onSettings ? 'secondary' : 'ghost'}
            size="icon"
            aria-label="Settings"
          >
            <Link href="/settings" data-testid="link-settings">
              <Settings className="h-5 w-5" />
            </Link>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2 rounded-full p-0.5 ring-1 ring-border/70 transition-all duration-200 hover:ring-primary/50"
                aria-label="Account menu"
                data-testid="button-user-menu"
              >
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="brand-mark text-[11px] font-semibold text-primary-foreground">
                    {initials}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <div className="px-2 py-1.5">
                <p className="truncate text-sm font-medium">
                  {user?.firstName || user?.lastName
                    ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
                    : (user?.email ?? 'Signed in')}
                </p>
                {user?.email && (
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                )}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
                data-testid="button-toggle-theme"
              >
                {resolvedTheme === 'dark' ? (
                  <Sun className="mr-2 h-4 w-4" />
                ) : (
                  <Moon className="mr-2 h-4 w-4" />
                )}
                {resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/settings/appearance">
                  <Settings className="mr-2 h-4 w-4" />
                  Appearance
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout} data-testid="button-logout">
                <LogOut className="mr-2 h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
