"use client";

// One logged email, opened from the table.
//
// The body renders in a SANDBOXED IFRAME with no `allow-same-origin` — the
// same rule the website builder's custom-code blocks follow. A logged body is
// merchant- and template-authored HTML, and the session cookie is scoped to
// `.storemink.com`, so same-origin script in here could ride an admin's
// session. srcdoc with scripts disabled entirely is the cheap, correct answer:
// nobody needs JavaScript to run in order to read what an email said.

import { useEffect, useState } from "react";
import { Loader2, ShieldOff, X } from "lucide-react";
import { getEmailLog } from "@/app/actions/email-log-actions";
import type { EmailLogDetail as Detail } from "@/app/actions/email-log-actions";
import { mailerLabel } from "@/lib/email/mailers";

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode | null;
}) {
  if (!value) return null;
  return (
    <div className="flex gap-3 py-1.5 text-[13px]">
      <span className="w-24 shrink-0 text-[var(--dash-text-3)]">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value}</span>
    </div>
  );
}

export function EmailLogDetail({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const [log, setLog] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getEmailLog(id).then((result) => {
      if (!live) return;
      if (result.error) setError(result.error);
      else setLog(result.log ?? null);
    });
    return () => {
      live = false;
    };
  }, [id]);

  // Esc closes, like every other overlay in the dashboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--dash-border)] bg-[var(--dash-surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Email details"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--dash-border)] px-5 py-3.5">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold">
              {log?.subject ?? "Email"}
            </div>
            {log ? (
              <div className="text-xs text-[var(--dash-text-3)]">
                {mailerLabel(log.mailer)} · {log.status}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="dash-btn dash-btn-ghost dash-btn-sm shrink-0"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p className="text-[13px] text-[var(--dash-text-2)]">{error}</p>
          ) : !log ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-[var(--dash-text-3)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : (
            <>
              <div className="mb-4 border-b border-[var(--dash-border)] pb-3">
                <Field label="To" value={log.to} />
                <Field label="From" value={log.from} />
                <Field label="Cc" value={log.cc} />
                <Field label="Bcc" value={log.bcc} />
                <Field label="Provider" value={log.provider} />
                <Field
                  label="Sent at"
                  value={new Date(log.createdAt).toLocaleString()}
                />
                <Field label="Message id" value={log.providerMessageId} />
                {log.error ? (
                  <Field
                    label="Error"
                    value={<span className="text-red-600">{log.error}</span>}
                  />
                ) : null}
              </div>

              {log.bodyHtml ? (
                <iframe
                  // No allow-same-origin, no allow-scripts: this is a document
                  // to read, not to run.
                  sandbox=""
                  srcDoc={log.bodyHtml}
                  title="Email content"
                  className="h-[420px] w-full rounded-md border border-[var(--dash-border)] bg-white"
                />
              ) : (
                <div className="flex items-start gap-2 rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface-2)] px-3 py-3 text-[13px] text-[var(--dash-text-2)]">
                  <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-[var(--dash-text-3)]" />
                  <span>
                    The contents of this email aren&apos;t stored. Password
                    resets and staff invites carry a working credential, so only
                    the delivery record is kept.
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
