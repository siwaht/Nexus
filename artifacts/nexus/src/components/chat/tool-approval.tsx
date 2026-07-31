import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useSetPermission } from '@/lib/queries';
import type { PendingApproval } from '@/lib/types';

/**
 * Tool approval prompt.
 *
 * Anything that writes, spends money, or reaches an external system stops here
 * first. The arguments are shown in full so the decision is informed, and
 * "always allow" writes a real permission rather than remembering it only for
 * this session.
 */

export interface ToolApprovalProps {
  calls: PendingApproval[];
  onResolve: (approvals: Record<string, boolean>) => void;
  busy?: boolean;
}

export function ToolApproval({ calls, onResolve, busy }: ToolApprovalProps) {
  const [always, setAlways] = useState(false);
  const setPermission = useSetPermission();

  const decide = (approve: boolean) => {
    if (approve && always) {
      // Persist before resuming so the run doesn't ask again mid-flight.
      for (const call of calls) {
        setPermission.mutate({ toolKey: call.toolKey, mode: 'allow' });
      }
    }
    const approvals: Record<string, boolean> = {};
    for (const call of calls) approvals[call.callId] = approve;
    onResolve(approvals);
  };

  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
      role="alertdialog"
      aria-label="Tool approval required"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {calls.length === 1
              ? `Allow ${calls[0].toolTitle}?`
              : `Allow ${calls.length} tool calls?`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These aren't read-only, so they need your go-ahead.
          </p>

          <ul className="mt-2 space-y-2">
            {calls.map((call) => (
              <li
                key={call.callId}
                className="rounded-md border border-border bg-background/60 p-2"
              >
                <p className="font-mono text-xs font-medium">{call.toolTitle}</p>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(call.args, null, 2)}
                </pre>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              onClick={() => decide(true)}
              disabled={busy}
              data-testid="button-approve-tool"
            >
              Allow
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => decide(false)}
              disabled={busy}
              data-testid="button-deny-tool"
            >
              Skip
            </Button>
            <div className="flex items-center gap-2">
              <Checkbox
                id="always-allow"
                checked={always}
                onCheckedChange={(checked) => setAlways(checked === true)}
                data-testid="checkbox-always-allow"
              />
              <Label htmlFor="always-allow" className="text-xs font-normal">
                Always allow{calls.length > 1 ? ' these' : ''}
              </Label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
