"use client";

// Delivery failures — the dead-letter queue, made visible.
//
// ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════
// A queue row that burned through its retries was marked 'failed' and that was
// the end of it. Nothing surfaced anywhere a person would look, so a store
// whose notification email had quietly stopped arriving could only find out by
// noticing the silence — which nobody does, because the whole point of a
// notification is that you weren't watching.
//
// So this panel is ABSENT when there's nothing wrong. It is not a dashboard
// widget competing for attention; it appears only when mail actually failed,
// which is the one time it's worth reading.

import { useState, useTransition } from "react";
import { AlertTriangle, RotateCw, Ban } from "lucide-react";
import { toast } from "sonner";
import { retryFailedEmail } from "@/app/actions/notification-actions";
import type { DeliveryFailure } from "@/app/actions/notification-actions";

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DeliveryHealth({
  failures,
  total,
  canManage,
}: {
  failures: DeliveryFailure[];
  total: number;
  canManage: boolean;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const rows = failures.filter((f) => !dismissed.includes(f.id));
  if (rows.length === 0) return null;

  function retry(id: string) {
    startTransition(async () => {
      const result = await retryFailedEmail(id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      // Drop it from the list immediately — it's queued again, so leaving it
      // under "failed" would be a lie until the next page load.
      setDismissed((d) => [...d, id]);
      toast.success("Queued for another attempt.");
    });
  }

  return (
    <section className="dash-card border-amber-200 dark:border-amber-900/50">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            {total === 1
              ? "1 email couldn't be delivered"
              : `${total} emails couldn't be delivered`}
          </div>
          <div className="dash-card-sub">
            In the last 7 days. These were sent but never arrived — usually a
            wrong address.
          </div>
        </div>
      </div>
      <div className="dash-card-body pt-0">
        <ul className="divide-y divide-[var(--dash-border)]">
          {rows.map((f) => (
            <li
              key={f.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{f.email}</span>
                <span className="block truncate text-xs text-[var(--dash-ink-soft)]">
                  {f.title} · {when(f.createdAt)}
                  {f.error ? ` · ${f.error}` : ""}
                </span>
              </span>

              {/* A suppressed address is a different problem with a different
                  fix, so it says so instead of offering a retry that is
                  guaranteed to fail. */}
              {f.suppressed ? (
                <span
                  className="dash-badge shrink-0 gap-1"
                  title="This address bounced permanently or reported spam. Ask the recipient for a working address."
                >
                  <Ban className="h-3 w-3" />
                  Address unusable
                </span>
              ) : canManage ? (
                <button
                  type="button"
                  className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
                  onClick={() => retry(f.id)}
                  disabled={pending}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  Retry
                </button>
              ) : null}
            </li>
          ))}
        </ul>

        {total > rows.length + dismissed.length ? (
          <p className="pt-3 text-xs text-[var(--dash-ink-soft)]">
            Showing the {rows.length} most recent of {total}.
          </p>
        ) : null}
      </div>
    </section>
  );
}
