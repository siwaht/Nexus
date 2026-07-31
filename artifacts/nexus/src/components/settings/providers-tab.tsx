import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListProviders,
  useSaveProviderCredentials,
  useDeleteProviderCredentials,
  useTestProviderConnection,
  getListProvidersQueryKey,
  type Provider,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ExternalLink, Loader2, CheckCircle2, XCircle, Circle, Trash2 } from "lucide-react";

export function ProvidersTab() {
  const { data: providers, isLoading } = useListProviders();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!providers || providers.length === 0) {
    return (
      <Card className="border-card-border">
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">No providers available</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {providers.map((provider) => (
        <ProviderCard key={provider.name} provider={provider} />
      ))}
    </div>
  );
}

interface ProviderCardProps {
  provider: Provider;
}

function ProviderCard({ provider }: ProviderCardProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const saveMutation = useSaveProviderCredentials();
  const deleteMutation = useDeleteProviderCredentials();
  const testMutation = useTestProviderConnection();

  const [credentials, setCredentials] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    provider.fields.forEach((field) => {
      initial[field.key] = "";
    });
    return initial;
  });

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleSave = () => {
    const dataToSend: Record<string, string> = {};
    Object.entries(credentials).forEach(([key, value]) => {
      if (value.trim()) {
        dataToSend[key] = value.trim();
      }
    });

    if (Object.keys(dataToSend).length === 0) {
      toast({
        variant: "destructive",
        title: "No changes",
        description: "Enter at least one credential to save",
      });
      return;
    }

    saveMutation.mutate(
      {
        name: provider.name,
        data: { credentials: dataToSend },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
          setCredentials((prev) => {
            const reset: Record<string, string> = {};
            Object.keys(prev).forEach((key) => {
              reset[key] = "";
            });
            return reset;
          });
          toast({
            title: "Saved",
            description: `${provider.displayName} credentials updated`,
          });
        },
        onError: (error: any) => {
          toast({
            variant: "destructive",
            title: "Save failed",
            description: error?.message || "Could not save credentials",
          });
        },
      }
    );
  };

  const handleTest = () => {
    testMutation.mutate(
      { name: provider.name },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
          if (result.ok) {
            toast({
              title: "Connection OK",
              description: result.latencyMs
                ? `Latency: ${result.latencyMs}ms`
                : result.message,
            });
          } else {
            toast({
              variant: "destructive",
              title: "Connection failed",
              description: result.message,
            });
          }
        },
        onError: (error: any) => {
          toast({
            variant: "destructive",
            title: "Test failed",
            description: error?.message || "Could not test connection",
          });
        },
      }
    );
  };

  const handleDelete = () => {
    deleteMutation.mutate(
      { name: provider.name },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
          setShowDeleteConfirm(false);
          toast({
            title: "Removed",
            description: `${provider.displayName} credentials deleted`,
          });
        },
        onError: (error: any) => {
          toast({
            variant: "destructive",
            title: "Delete failed",
            description: error?.message || "Could not delete credentials",
          });
        },
      }
    );
  };

  const statusIcon = {
    untested: <Circle className="w-4 h-4 text-muted-foreground" />,
    ok: <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-500" />,
    error: <XCircle className="w-4 h-4 text-destructive" />,
  }[provider.status];

  return (
    <>
      <Card className="border-card-border" data-testid={`card-provider-${provider.name}`}>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-lg">{provider.displayName}</CardTitle>
                {provider.isDefault && (
                  <Badge variant="secondary" className="text-xs" data-testid={`badge-default-${provider.name}`}>
                    Default
                  </Badge>
                )}
                {provider.configured && (
                  <Badge variant="outline" className="text-xs gap-1" data-testid={`badge-status-${provider.name}`}>
                    {statusIcon}
                    {provider.status}
                  </Badge>
                )}
              </div>
              <CardDescription className="mt-1.5">{provider.description}</CardDescription>
              {provider.docsUrl && (
                <a
                  href={provider.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline mt-2"
                  data-testid={`link-docs-${provider.name}`}
                >
                  Where do I find this?
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4">
            {provider.fields.map((field) => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={`${provider.name}-${field.key}`} className="flex items-center gap-2">
                  {field.label}
                  {field.required && <span className="text-destructive text-xs">*</span>}
                </Label>
                <Input
                  id={`${provider.name}-${field.key}`}
                  type={field.secret ? "password" : "text"}
                  value={credentials[field.key] || ""}
                  onChange={(e) =>
                    setCredentials((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  placeholder={
                    field.maskedPreview
                      ? field.maskedPreview
                      : field.placeholder || ""
                  }
                  className="font-mono text-sm"
                  data-testid={`input-${provider.name}-${field.key}`}
                />
              </div>
            ))}
          </div>

          {provider.status === "error" && provider.statusMessage && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3">
              <p className="text-sm text-destructive font-medium">Last error</p>
              <p className="text-sm text-destructive/90 mt-1 font-mono">{provider.statusMessage}</p>
            </div>
          )}

          {provider.lastTestedAt && (
            <p className="text-xs text-muted-foreground">
              Last tested: {new Date(provider.lastTestedAt).toLocaleString()}
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap pt-2">
            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="gap-2"
              data-testid={`button-save-${provider.name}`}
            >
              {saveMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Save
            </Button>

            {provider.configured && (
              <>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={testMutation.isPending}
                  className="gap-2"
                  data-testid={`button-test-${provider.name}`}
                >
                  {testMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  Test connection
                </Button>

                <Button
                  variant="outline"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={deleteMutation.isPending}
                  className="gap-2 ml-auto"
                  data-testid={`button-delete-${provider.name}`}
                >
                  <Trash2 className="w-4 h-4" />
                  Remove key
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove credentials?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete all stored credentials for {provider.displayName}. You can re-add them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-delete-${provider.name}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid={`button-confirm-delete-${provider.name}`}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
