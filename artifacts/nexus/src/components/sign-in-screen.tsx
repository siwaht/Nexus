import { useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetAuthConfig, useLoginLocalUser, useRegisterLocalUser } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Terminal } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function SignInScreen() {
  const { login } = useAuth();
  const { data: authConfig, isLoading: configLoading } = useGetAuthConfig();
  const loginMutation = useLoginLocalUser();
  const registerMutation = useRegisterLocalUser();
  const { toast } = useToast();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (mode === "login") {
      loginMutation.mutate(
        { data: { email, password } },
        {
          onSuccess: () => {
            window.location.reload();
          },
          onError: (error: any) => {
            toast({
              variant: "destructive",
              title: "Login failed",
              description: error?.message || "Invalid credentials",
            });
          },
        }
      );
    } else {
      registerMutation.mutate(
        { data: { email, password, firstName: firstName || undefined, lastName: lastName || undefined } },
        {
          onSuccess: () => {
            window.location.reload();
          },
          onError: (error: any) => {
            toast({
              variant: "destructive",
              title: "Registration failed",
              description: error?.message || "Could not create account",
            });
          },
        }
      );
    }
  };

  if (configLoading) {
    return (
      <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent"
          role="status"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (authConfig?.mode === "replit") {
    return (
      <SignInFrame>
        <Button
          onClick={login}
          className="h-11 w-full font-medium shadow-sm"
          data-testid="button-login"
        >
          Continue with Replit
        </Button>
        <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
          Your API keys are encrypted on the server and never sent to the
          browser.
        </p>
      </SignInFrame>
    );
  }

  return (
    <SignInFrame>
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "register" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First name</Label>
                  <Input
                    id="firstName"
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Optional"
                    data-testid="input-first-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last name</Label>
                  <Input
                    id="lastName"
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Optional"
                    data-testid="input-last-name"
                  />
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
                data-testid="input-email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder={mode === "register" ? "At least 8 characters" : "••••••••"}
                minLength={mode === "register" ? 8 : 1}
                data-testid="input-password"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11 font-medium"
              disabled={loginMutation.isPending || registerMutation.isPending}
              data-testid="button-submit"
            >
              {loginMutation.isPending || registerMutation.isPending
                ? "Please wait..."
                : mode === "login"
                ? "Log in"
                : "Create account"}
            </Button>
          </form>
      <div className="mt-5 text-center">
        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          data-testid="button-toggle-mode"
        >
          {mode === "login" ? (
            <>
              Need an account?{" "}
              <span className="font-medium text-primary">Create one</span>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <span className="font-medium text-primary">Log in</span>
            </>
          )}
        </button>
      </div>
    </SignInFrame>
  );
}

/**
 * Shared chrome for both auth modes: the ambient background, the brand mark and
 * the card. Keeping it in one place means the two modes can't drift apart.
 */
function SignInFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-hidden p-4">
      {/* A soft grid, faded out from the centre, to give the empty page depth. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35] [mask-image:radial-gradient(45rem_32rem_at_50%_40%,black,transparent)]"
        style={{
          backgroundImage:
            'linear-gradient(hsl(var(--border)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
        }}
      />

      <div className="relative w-full max-w-md animate-[fade-up_0.45s_cubic-bezier(0.16,1,0.3,1)]">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="brand-mark mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
            <Terminal className="h-7 w-7 text-primary-foreground" />
          </span>
          <h1 className="text-gradient font-display text-3xl font-semibold tracking-tight">
            Nexus
          </h1>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
            A self-hosted AI workspace. Your models, your keys, your data.
          </p>
        </div>

        <Card className="surface-raised border-card-border/80 shadow-xl">
          <CardContent className="pt-6">{children}</CardContent>
        </Card>
      </div>
    </div>
  );
}
