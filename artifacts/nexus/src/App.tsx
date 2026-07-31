import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/lib/theme-provider';
import { useAuth } from '@workspace/replit-auth-web';
import { SignInScreen } from '@/components/sign-in-screen';
import { AppShell } from '@/components/app-shell';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import Settings from '@/pages/settings';
import { Route, Switch, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <SignInScreen />;
  }

  return <>{children}</>;
}

function Router() {
  return (
    <AuthGate>
      <AppShell>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/settings" component={Settings} />
          <Route path="/settings/:tab" component={Settings} />
          <Route component={NotFound} />
        </Switch>
      </AppShell>
    </AuthGate>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
