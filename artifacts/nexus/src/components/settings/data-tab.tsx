import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Loader2,
  Trash2,
  TrendingUp,
  Upload,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { api, apiUrl } from '@/lib/api';
import { useUsage } from '@/lib/queries';

/**
 * Settings → Data.
 *
 * Usage and estimated spend per model per day, plus whole-workspace export and
 * import. The export deliberately excludes credentials — a portable backup that
 * leaks every API key is a liability, so imported MCP servers land disabled with
 * a note to re-enter their secrets.
 */

export function DataTab() {
  const { toast } = useToast();
  const [days, setDays] = useState(30);
  const { data, isLoading } = useUsage(days);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const buckets = data?.buckets ?? [];
  const totals = data?.totals;

  const daily = useMemo(() => {
    const map = new Map<string, { day: string; tokensIn: number; tokensOut: number }>();
    for (const bucket of buckets) {
      const existing = map.get(bucket.day) ?? {
        day: bucket.day,
        tokensIn: 0,
        tokensOut: 0,
      };
      existing.tokensIn += bucket.tokensIn;
      existing.tokensOut += bucket.tokensOut;
      map.set(bucket.day, existing);
    }
    return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
  }, [buckets]);

  const byModel = useMemo(() => {
    const map = new Map<
      string,
      { modelRef: string; calls: number; tokensIn: number; tokensOut: number; cost: number | null }
    >();
    for (const bucket of buckets) {
      const existing = map.get(bucket.modelRef) ?? {
        modelRef: bucket.modelRef,
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: null as number | null,
      };
      existing.calls += bucket.calls;
      existing.tokensIn += bucket.tokensIn;
      existing.tokensOut += bucket.tokensOut;
      if (bucket.costEstimate !== null) {
        existing.cost = (existing.cost ?? 0) + bucket.costEstimate;
      }
      map.set(bucket.modelRef, existing);
    }
    return [...map.values()].sort(
      (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut),
    );
  }, [buckets]);

  const handleImport = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      const result = await api.post<{ imported: Record<string, number> }>(
        '/data/import',
        payload,
      );
      const summary = Object.entries(result.imported)
        .filter(([, count]) => count > 0)
        .map(([key, count]) => `${count} ${key}`)
        .join(', ');
      toast({
        title: 'Import finished',
        description: summary || 'Nothing new to import.',
      });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Import failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-card-border">
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <TrendingUp className="h-4 w-4" />
              Usage
            </CardTitle>
            <CardDescription className="mt-1.5">
              Tokens and estimated spend per model. Cost only appears where the
              provider publishes prices — otherwise it's counted but not priced.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-1">
            {[7, 30, 90].map((option) => (
              <Button
                key={option}
                variant={days === option ? 'default' : 'outline'}
                size="sm"
                onClick={() => setDays(option)}
                data-testid={`button-usage-days-${option}`}
              >
                {option}d
              </Button>
            ))}
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {isLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && buckets.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No usage recorded yet.
            </p>
          )}

          {totals && buckets.length > 0 && (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                {[
                  { label: 'Calls', value: totals.calls.toLocaleString() },
                  { label: 'Tokens in', value: totals.tokensIn.toLocaleString() },
                  { label: 'Tokens out', value: totals.tokensOut.toLocaleString() },
                  {
                    label: 'Estimated cost',
                    value:
                      totals.costEstimate === null
                        ? 'Not priced'
                        : `$${totals.costEstimate.toFixed(4)}${totals.costComplete ? '' : '+'}`,
                  },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-lg border border-border bg-muted/20 p-3"
                  >
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                    <p className="mt-0.5 text-lg font-semibold tabular-nums">
                      {stat.value}
                    </p>
                  </div>
                ))}
              </div>

              {!totals.costComplete && totals.costEstimate !== null && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Some models don't publish prices, so this total is a lower bound.
                </p>
              )}

              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={daily}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{
                        background: 'hsl(var(--popover))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="tokensIn" name="In" fill="hsl(var(--primary))" />
                    <Bar dataKey="tokensOut" name="Out" fill="hsl(var(--muted-foreground))" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <ScrollArea className="max-h-64">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th scope="col" className="py-2 font-medium">Model</th>
                      <th scope="col" className="py-2 text-right font-medium">Calls</th>
                      <th scope="col" className="py-2 text-right font-medium">In</th>
                      <th scope="col" className="py-2 text-right font-medium">Out</th>
                      <th scope="col" className="py-2 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byModel.map((row) => (
                      <tr key={row.modelRef} className="border-b border-border/50">
                        <td className="py-2 font-mono text-xs">{row.modelRef}</td>
                        <td className="py-2 text-right tabular-nums">{row.calls}</td>
                        <td className="py-2 text-right tabular-nums">
                          {row.tokensIn.toLocaleString()}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {row.tokensOut.toLocaleString()}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {row.cost === null ? '—' : `$${row.cost.toFixed(4)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollArea>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="border-card-border">
        <CardHeader>
          <CardTitle className="text-lg">Export and import</CardTitle>
          <CardDescription>
            A full JSON snapshot of conversations, files metadata, memory, skills,
            tool permissions and MCP server shapes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button asChild className="gap-2">
              <a href={apiUrl('/data/export')} download data-testid="button-export-data">
                <Download className="h-4 w-4" />
                Export everything
              </a>
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImport(file);
                event.target.value = '';
              }}
            />
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => fileRef.current?.click()}
              disabled={importing}
              data-testid="button-import-data"
            >
              {importing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Import
            </Button>
          </div>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Credentials are never exported. After importing, re-enter provider keys
            and vault secrets — imported MCP servers arrive disabled until you do.
          </p>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-lg text-destructive">Delete all data</CardTitle>
          <CardDescription>
            Erases conversations, files, memory, skills, agent runs and usage
            history. Your account and provider credentials stay, so you aren't
            locked out afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="gap-2 text-destructive">
                <Trash2 className="h-4 w-4" />
                Delete all workspace data
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>This cannot be undone</AlertDialogTitle>
                <AlertDialogDescription>
                  Export first if you might want any of it back. Type DELETE to
                  confirm.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-2">
                <Label htmlFor="confirm-delete">Confirmation</Label>
                <Input
                  id="confirm-delete"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder="DELETE"
                  className="font-mono"
                  data-testid="input-confirm-delete"
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirmText('')}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={confirmText !== 'DELETE'}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => {
                    void api
                      .post('/data/delete-all', { confirm: 'DELETE' })
                      .then(() => {
                        setConfirmText('');
                        toast({ title: 'Workspace data deleted' });
                        window.location.reload();
                      })
                      .catch((err: unknown) =>
                        toast({
                          variant: 'destructive',
                          title: 'Delete failed',
                          description: err instanceof Error ? err.message : undefined,
                        }),
                      );
                  }}
                >
                  Delete everything
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </div>
  );
}
