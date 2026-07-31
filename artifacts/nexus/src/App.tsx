import { useCallback, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

import { useAuth } from '@workspace/replit-auth-web';

import { AppShell } from '@/components/app-shell';
import { CommandPalette } from '@/components/command-palette';
import { SignInScreen } from '@/components/sign-in-screen';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/lib/theme-provider';
import { api } from '@/lib/api';
import AgentsPage from '@/pages/agents';
import BrowserPage from '@/pages/browser';
import ChatPage from '@/pages/chat';
import LibraryPage from '@/pages/library';
import NotFound from '@/pages/not-found';
import Settings from '@/pages/settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The app is mostly live data behind a session; a short stale window
      // avoids hammering the API while keeping panels current.
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const ACTIVE_CONVERSATION_KEY = 'nexus-active-conversation';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background">
        <div
          className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (!user) return <SignInScreen />;
  return <>{children}</>;
}

/**
 * Workspace routing.
 *
 * Chat, Library, Agents and Web are views of the same workspace rather than
 * separate pages, so they share the shell and the sidebar and switching between
 * them keeps the active conversation intact. The active conversation is stored
 * so a reload returns to where you were.
 */
function Workspace() {
  const [location, navigate] = useLocation();
  const [conversationId, setConversationId] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(ACTIVE_CONVERSATION_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [libraryFileId, setLibraryFileId] = useState<number | null>(null);

  useEffect(() => {
    if (conversationId) {
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, String(conversationId));
    } else {
      localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
    }
  }, [conversationId]);

  const selectConversation = useCallback(
    (id: number) => {
      setConversationId(id);
      navigate('/');
    },
    [navigate],
  );

  const newChat = useCallback(() => {
    setConversationId(null);
    navigate('/');
  }, [navigate]);

  const openLibrary = useCallback(
    (fileId?: number) => {
      setLibraryFileId(fileId ?? null);
      navigate('/library');
    },
    [navigate],
  );

  const openAgents = useCallback(() => navigate('/agents'), [navigate]);
  const openBrowser = useCallback(() => navigate('/web'), [navigate]);

  const focusComposer = useCallback(() => {
    if (location !== '/') navigate('/');
    // Let the route settle before reaching for the textarea.
    window.setTimeout(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="textarea-message"]')
        ?.focus();
    }, 50);
  }, [location, navigate]);

  /** Start a conversation scoped to one library document. */
  const askAboutFile = useCallback(
    async (fileId: number, filename: string) => {
      const created = await api
        .post<{ conversation: { id: number } }>('/conversations', {
          title: `About ${filename}`,
          scopedFileId: fileId,
          useLibrary: true,
        })
        .catch(() => null);
      if (created) {
        setLibraryFileId(null);
        selectConversation(created.conversation.id);
      }
    },
    [selectConversation],
  );

  return (
    <>
      <CommandPalette
        onNewChat={newChat}
        onOpenConversation={selectConversation}
        onOpenLibrary={() => openLibrary()}
        onOpenAgents={openAgents}
        onOpenBrowser={openBrowser}
        onFocusComposer={focusComposer}
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
      />

      <AppShell
        activeConversationId={conversationId}
        sidebarOpen={sidebarOpen}
        onSidebarOpenChange={setSidebarOpen}
        onSelectConversation={selectConversation}
        onNewChat={newChat}
        onOpenLibrary={() => openLibrary()}
        onOpenAgents={openAgents}
      >
        <Switch>
          <Route path="/">
            <ChatPage
              conversationId={conversationId}
              onConversationCreated={setConversationId}
              onOpenLibrary={openLibrary}
              onOpenAgents={openAgents}
            />
          </Route>
          <Route path="/library">
            <LibraryPage
              selectedFileId={libraryFileId}
              onSelectFile={setLibraryFileId}
              onAskAbout={(fileId, filename) => void askAboutFile(fileId, filename)}
              onBack={() => navigate('/')}
            />
          </Route>
          <Route path="/agents">
            <AgentsPage conversationId={conversationId} onBack={() => navigate('/')} />
          </Route>
          <Route path="/web">
            <BrowserPage onBack={() => navigate('/')} />
          </Route>
          <Route path="/settings" component={Settings} />
          <Route path="/settings/:tab" component={Settings} />
          <Route component={NotFound} />
        </Switch>
      </AppShell>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <AuthGate>
              <Workspace />
            </AuthGate>
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
