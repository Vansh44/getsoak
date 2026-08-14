"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { closeReconciliationItem } from "@/app/actions/platform";
import type { ReconciliationItem } from "@/lib/billing/invoice-types";

// ---------------------------------------------------------------------------
// Money discrepancies the sweep found and could not decide (§34).
//
// ★★ CLOSING AN ITEM MOVES NO MONEY, and the screen says so rather than leaving
// it to be assumed. An amount mismatch is actually resolved by refunding the
// difference, issuing a credit, or deciding it does not matter — all elsewhere,
// deliberately, by someone who chose them. A button here that "fixed" a
// discrepancy would be a money movement nobody reviewed.
//
// ★ THREE OUTCOMES, because "resolved" alone is a lie in two common cases:
// something genuinely settled, something a human must chase (manual review), and
// something that turned out not to matter (ignored). Collapsing them loses the
// difference between "dealt with" and "decided not to".
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  amount_mismatch: "Amount mismatch",
  unknown_payment: "Unknown payment",
  orphan_payment: "Payment with no store",
  missing_webhook: "Missing webhook",
  state_conflict: "State conflict",
  wrong_association: "Wrong association",
  credit_grant_failed: "Credit grant failed",
};

const inr = (paise: number | null) =>
  paise === null
    ? "—"
    : `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      })
    : "—";

export function ReconciliationQueue({
  items,
  status,
}: {
  items: ReconciliationItem[];
  status: string;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <div className="dash-card p-8 text-center">
        <Check
          className="mx-auto mb-3 h-6 w-6 text-[#9aa1ab]"
          strokeWidth={1.5}
        />
        <p className="text-sm font-medium text-[#111827]">
          {status === "open" ? "Nothing to review" : "Nothing here"}
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm text-[#6b7280]">
          {status === "open"
            ? "The hourly sweep files anything it finds and cannot decide — an amount that differs from what we asked for, or a payment that maps to no store."
            : "No items with this outcome yet."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div key={item.id} className="dash-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                <span className="text-sm font-semibold text-[#111827]">
                  {KIND_LABEL[item.kind] ?? item.kind}
                </span>
                {/* ★ A null store is legitimate and is itself the problem — an
                    orphan payment nobody can attribute. Say so rather than
                    rendering a blank. */}
                <span className="text-sm text-[#5b6472]">
                  {item.storeName ?? "no store — needs attributing"}
                </span>
              </div>

              {item.expectedPaise !== null && item.observedPaise !== null && (
                <p className="mt-1.5 text-sm text-[#111827]">
                  Asked for{" "}
                  <strong className="font-mono">
                    {inr(item.expectedPaise)}
                  </strong>
                  , received{" "}
                  <strong className="font-mono">
                    {inr(item.observedPaise)}
                  </strong>
                  <span className="ml-2 text-[#6b7280]">
                    (
                    {item.observedPaise > item.expectedPaise
                      ? `${inr(item.observedPaise - item.expectedPaise)} over`
                      : `${inr(item.expectedPaise - item.observedPaise)} short`}
                    )
                  </span>
                </p>
              )}

              <p className="mt-1 font-mono text-xs text-[#6b7280]">
                {item.providerPaymentId ?? item.providerOrderId ?? item.id}
              </p>
              <p className="mt-0.5 text-xs text-[#9aa1ab]">
                Found {fmt(item.createdAt)}
              </p>

              {item.status !== "open" && (
                <p className="mt-2 rounded bg-[#f9fafb] px-2 py-1 text-xs text-[#5b6472]">
                  <strong>{item.status}</strong>
                  {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
                  {item.resolvedAt ? ` · ${fmt(item.resolvedAt)}` : ""}
                  {item.resolutionNote ? ` — ${item.resolutionNote}` : ""}
                </p>
              )}
            </div>

            {item.status === "open" && (
              <button
                type="button"
                onClick={() => setOpenId(openId === item.id ? null : item.id)}
                className="shrink-0 rounded-lg border border-[#e5e5e5] px-3 py-1.5 text-sm font-medium text-[#111827] hover:bg-[#111827]/[0.03]"
              >
                {openId === item.id ? "Cancel" : "Close this"}
              </button>
            )}
          </div>

          {openId === item.id && (
            <CloseForm
              id={item.id}
              onDone={() => {
                setOpenId(null);
                router.refresh();
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function CloseForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<
    "resolved" | "manual_review" | "ignored"
  >("resolved");

  function submit() {
    start(async () => {
      const res = await closeReconciliationItem(id, outcome, note);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Closed.");
      onDone();
    });
  }

  return (
    <div className="mt-4 border-t border-[#e5e5e5] pt-4">
      {/* ★ Stated at the point of action, not in a header nobody re-reads. */}
      <p className="mb-3 rounded-lg bg-[#f9fafb] px-3 py-2 text-xs text-[#5b6472]">
        This records what you found. It does <strong>not</strong> move money —
        refunding a difference or issuing a credit happens on the store&apos;s
        own billing screens.
      </p>

      <div className="mb-3 flex flex-wrap gap-2">
        {(
          [
            ["resolved", "Resolved"],
            ["manual_review", "Needs chasing"],
            ["ignored", "Doesn't matter"],
          ] as const
        ).map(([value, label]) => (
          <label
            key={value}
            className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${
              outcome === value
                ? "border-[#111827] bg-[#111827]/[0.03] font-medium"
                : "border-[#e5e5e5]"
            }`}
          >
            <input
              type="radio"
              className="mr-2"
              checked={outcome === value}
              onChange={() => setOutcome(value)}
            />
            {label}
          </label>
        ))}
      </div>

      <textarea
        className="dash-input w-full"
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What did you find? (required — this is the audit trail)"
      />

      <button
        type="button"
        onClick={submit}
        disabled={pending || !note.trim()}
        className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-50"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        Close item
      </button>
    </div>
  );
}
