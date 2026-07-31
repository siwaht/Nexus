import { Link } from "wouter";
import { useListProviders } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ArrowRight, KeyRound, Send } from "lucide-react";

export default function Home() {
  const { data: providers, isLoading } = useListProviders();

  const hasConfiguredProvider = providers?.some((p) => p.configured);

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!hasConfiguredProvider) {
    return (
      <div className="w-full h-full flex items-center justify-center p-6">
        <Card className="w-full max-w-xl border-card-border">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto w-14 h-14 rounded-lg bg-primary/10 flex items-center justify-center">
              <KeyRound className="w-7 h-7 text-primary" />
            </div>
            <CardTitle className="text-2xl">Getting Started</CardTitle>
            <CardDescription className="text-base leading-relaxed">
              Connect your first AI provider to start chatting. You'll need your Cloudflare Account ID and a Workers AI API token.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg bg-muted p-4 space-y-2 border border-border">
              <h3 className="font-medium text-sm">Where to find credentials</h3>
              <ul className="text-sm text-muted-foreground space-y-1.5 list-disc list-inside">
                <li>
                  <span className="font-mono text-xs">Account ID</span>: Cloudflare dashboard → Workers & Pages → Overview
                </li>
                <li>
                  <span className="font-mono text-xs">API Token</span>: Cloudflare dashboard → My Profile → API Tokens → Create Token
                </li>
              </ul>
            </div>
            <Link href="/settings">
              <Button className="w-full gap-2 h-11 font-medium" data-testid="button-configure-provider">
                Configure provider
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-2xl text-center space-y-6">
          <div>
            <h2 className="text-2xl font-bold mb-2">Ready to chat</h2>
            <p className="text-muted-foreground">
              Chat functionality arrives in the next milestone. For now, you can configure additional providers in settings.
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-border bg-card p-4">
        <div className="max-w-3xl mx-auto">
          <div className="relative">
            <Textarea
              placeholder="Type a message... (coming soon)"
              className="min-h-[80px] pr-12 resize-none"
              disabled
              data-testid="textarea-message"
            />
            <Button
              size="icon"
              className="absolute bottom-3 right-3"
              disabled
              data-testid="button-send"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground text-center mt-3">
            Chat arrives in the next milestone
          </p>
        </div>
      </div>
    </div>
  );
}
