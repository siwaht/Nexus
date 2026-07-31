import { useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetAuthConfig, useLoginLocalUser, useRegisterLocalUser } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (authConfig?.mode === "replit") {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background">
        <Card className="w-full max-w-md border-card-border shadow-lg">
          <CardHeader className="space-y-4 text-center pb-8">
            <div className="mx-auto w-16 h-16 rounded-xl bg-primary/10 flex items-center justify-center">
              <Terminal className="w-8 h-8 text-primary" />
            </div>
            <div>
              <CardTitle className="text-2xl font-bold tracking-tight">Nexus</CardTitle>
              <CardDescription className="text-base mt-2">
                Self-hosted AI chat workspace
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Button
              onClick={login}
              className="w-full h-11 font-medium"
              data-testid="button-login"
            >
              Log in
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md border-card-border shadow-lg">
        <CardHeader className="space-y-4 text-center pb-6">
          <div className="mx-auto w-16 h-16 rounded-xl bg-primary/10 flex items-center justify-center">
            <Terminal className="w-8 h-8 text-primary" />
          </div>
          <div>
            <CardTitle className="text-2xl font-bold tracking-tight">Nexus</CardTitle>
            <CardDescription className="text-base mt-2">
              Self-hosted AI chat workspace
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
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
          <div className="mt-4 text-center">
            <button
              type="button"
              onClick={() => setMode(mode === "login" ? "register" : "login")}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              data-testid="button-toggle-mode"
            >
              {mode === "login" ? "Need an account? Create one" : "Already have an account? Log in"}
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
