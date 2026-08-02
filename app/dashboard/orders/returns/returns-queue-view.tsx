"use client";

// The returns review queue (roadmap Step 3).
//
// ── Two things this screen is designed around ──────────────────────────────
// 1. ★ A REJECTION NEEDS A REASON, so the decline control is a form and not a
//    button. The customer reads that text verbatim; a silent no is the most
//    complained-about thing a returns process does. The server refuses an
//    empty one too — this is the affordance, not the rule.
// 2. ★ FAULT CLAIMS ARE FLAGGED. "Arrived damaged" waives every fee and is the
//    one a merchant most needs to see quickly, so it carries a marker rather
//    than sitting as one more row of identical text.

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  Loader2,
  PackageCheck,
  RotateCcw,
  X,
} from "lucide-react";
import { formatPrice } from "@/lib/pricing";
import {
  receiveReturn,
  reviewReturn,
  type ReturnQueueRow,
} from "@/app/actions/return-actions";

const TABS: { key: string; label: string }[] = [
  { key: "", label: "Open" },
  { key: "requested", label: "Waiting" },
  { key: "approved", label: "Approved" },
  { key: "received", label: "Received" },
  { key: "rejected", label: "Declined" },
];

const STATUS_TONE: Record<string, string> = {
  requested: "bg-amber-50 text-amber-700 ring-amber-600/20",
  approved: "bg-blue-50 text-blue-700 ring-blue-600/20",
  received: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  rejected: "bg-rose-50 text-rose-700 ring-rose-600/20",
  cancelled: "bg-gray-100 text-gray-600 ring-gray-500/20",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });
}

export function ReturnsQueueView({
  rows,
  status,
  error,
  canManage,
}: {
  rows: ReturnQueueRow[];
  status: string;
  error?: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [, startTransition] = useTransition();

  function decide(id: string, decision: "approve" | "reject") {
    if (decision === "reject" && !note.trim()) {
      toast.error("Tell the customer why you're declining this.");
      return;
    }
    setBusy(id);
    startTransition(async () => {
      try {
        const res = await reviewReturn(
          id,
          decision,
          decision === "reject" ? note : undefined,
        );
        if (res.error) toast.error(res.error);
        else {
          toast.success(
            decision === "approve" ? "Return approved." : "Return declined.",
          );
          setRejecting(null);
          setNote("");
          router.refresh();
        }
      } catch {
        toast.error("Something went wrong.");
      } finally {
        setBusy(null);
      }
    });
  }

  function receive(id: string) {
    setBusy(id);
    startTransition(async () => {
      try {
        // v1 books everything back in as sellable. Per-line damaged marking is
        // the next increment; defaulting to sellable here matches what the
        // till already does and never silently destroys stock.
        const res = await receiveReturn(id, []);
        if (res.error) toast.error(res.error);
        else {
          toast.success(
            res.restocked
              ? `Booked in. ${res.restocked} line${res.restocked === 1 ? "" : "s"} back on the shelf.`
              : "Booked in.",
          );
          router.refresh();
        }
      } catch {
        toast.error("Something went wrong.");
      } finally {
        setBusy(null);
      }
    });
  }

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Returns</h1>
          <p>Review what customers want to send back</p>
        </div>
        <Link href="/dashboard/orders" className="dash-btn dash-btn-ghost">
          All orders
        </Link>
      </header>

      <div className="dash-card flex flex-col">
        <div className="dash-toolbar px-5 pt-4 pb-2 border-b border-[var(--dash-border)]">
          <div className="dash-filter-tabs">
            {TABS.map((t) => (
              <Link
                key={t.key || "open"}
                href={
                  t.key
                    ? `/dashboard/orders/returns?status=${t.key}`
                    : "/dashboard/orders/returns"
                }
                className={`dash-filter-tab${status === t.key ? " active" : ""}`}
              >
                {t.label}
              </Link>
            ))}
          </div>
        </div>

        {error ? (
          <p className="p-6 text-sm text-muted-foreground">{error}</p>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center text-muted-foreground">
            <RotateCcw className="h-6 w-6" />
            <p className="text-sm">Nothing here.</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--dash-border)]">
            {rows.map((r) => (
              <li key={r.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/dashboard/orders?q=${encodeURIComponent(r.orderRef ?? "")}`}
                        className="font-mono text-sm font-semibold hover:underline"
                      >
                        {r.orderRef ?? "Order"}
                      </Link>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${
                          STATUS_TONE[r.status] ??
                          "bg-gray-100 text-gray-700 ring-gray-500/20"
                        }`}
                      >
                        {r.status}
                      </span>
                      {/* The store's own fault: no fees, and the one to look
                          at first. */}
                      {r.merchantFault && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-600/20">
                          <AlertTriangle className="h-3 w-3" />
                          Our fault — no fees
                        </span>
                      )}
                      {r.channel === "pos" && (
                        <span className="text-xs text-muted-foreground">
                          at the counter
                        </span>
                      )}
                    </div>

                    <p className="mt-1 text-sm">
                      {r.itemCount} item{r.itemCount === 1 ? "" : "s"}
                      {r.reasonLabel ? ` · ${r.reasonLabel}` : ""}
                      {" · "}
                      <span className="font-medium tabular-nums">
                        {formatPrice(r.total)}
                      </span>
                      {r.restockingFee + r.returnShippingFee > 0 && (
                        <span className="text-muted-foreground">
                          {" "}
                          (after{" "}
                          {formatPrice(
                            r.restockingFee + r.returnShippingFee,
                          )}{" "}
                          fees)
                        </span>
                      )}
                    </p>

                    {r.customerNote && (
                      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                        “{r.customerNote}”
                      </p>
                    )}
                    {r.reviewNote && (
                      <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                        Your note: {r.reviewNote}
                      </p>
                    )}
                    {r.photos.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {r.photos.map((src) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={src}
                            src={src}
                            alt="Customer photo"
                            className="h-16 w-16 rounded-md border border-border object-cover"
                          />
                        ))}
                      </div>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {fmtDate(r.createdAt)}
                    </p>
                  </div>

                  {canManage && (
                    <div className="flex shrink-0 items-center gap-2">
                      {r.status === "requested" && (
                        <>
                          <button
                            type="button"
                            disabled={busy === r.id}
                            onClick={() => decide(r.id, "approve")}
                            className="dash-btn dash-btn-primary"
                          >
                            {busy === r.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="h-4 w-4" />
                            )}
                            Approve
                          </button>
                          <button
                            type="button"
                            disabled={busy === r.id}
                            onClick={() =>
                              setRejecting(rejecting === r.id ? null : r.id)
                            }
                            className="dash-btn dash-btn-ghost"
                          >
                            <X className="h-4 w-4" />
                            Decline
                          </button>
                        </>
                      )}
                      {r.status === "approved" && (
                        <button
                          type="button"
                          disabled={busy === r.id}
                          onClick={() => receive(r.id)}
                          className="dash-btn dash-btn-primary"
                        >
                          {busy === r.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <PackageCheck className="h-4 w-4" />
                          )}
                          Goods received
                        </button>
                      )}
                      {r.status === "received" && (
                        <Link
                          href={`/dashboard/orders?q=${encodeURIComponent(r.orderRef ?? "")}`}
                          className="dash-btn dash-btn-ghost"
                        >
                          Refund on the order
                        </Link>
                      )}
                    </div>
                  )}
                </div>

                {/* ★ Declining is a FORM. The note is what the customer reads,
                    and the server refuses an empty one. */}
                {rejecting === r.id && (
                  <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
                    <label className="text-xs font-medium text-muted-foreground">
                      Why are you declining? The customer sees this.
                    </label>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={2}
                      placeholder="e.g. This item is past its 7-day return window."
                      className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setRejecting(null);
                          setNote("");
                        }}
                        className="dash-btn dash-btn-ghost"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy === r.id || !note.trim()}
                        onClick={() => decide(r.id, "reject")}
                        className="dash-btn dash-btn-primary"
                      >
                        Decline return
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
