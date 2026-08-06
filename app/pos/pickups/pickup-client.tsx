"use client";

// The collection queue: orders bought online, waiting on this shop's shelf.
//
// Everything shown is already scoped to the operator's own location by the
// action — the client never names a shop, so there is nothing here to spoof.

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Loader2,
  PackageCheck,
  Search,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import {
  getPickupQueue,
  markCollected,
  markReadyForPickup,
  type PickupOrder,
} from "@/app/actions/pos-pickup-actions";
import type { PosTender } from "@/app/actions/pos-sale-actions";
import { TenderPanel } from "../sell/tender-panel";

function money(n: number) {
  return `₹${n.toFixed(2)}`;
}

/** "Expires in 3 days" beats a timestamp nobody can subtract in their head. */
function expiryLabel(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "Expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} left`;
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"} left`;
}

export function PickupQueue({
  initial,
  error,
}: {
  initial: PickupOrder[];
  error: string | null;
}) {
  const [orders, setOrders] = useState(initial);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tendering, setTendering] = useState<PickupOrder | null>(null);
  const [pending, start] = useTransition();

  const refresh = (q = query) => {
    start(async () => {
      const res = await getPickupQueue(q);
      if (res.error) toast.error(res.error);
      else setOrders(res.orders);
    });
  };

  const done = (id: string, message: string) => {
    toast.success(message);
    setOrders((cur) => cur.filter((o) => o.id !== id));
  };

  const act = async (
    id: string,
    fn: (id: string) => Promise<{ success?: boolean; error?: string }>,
    message: string,
  ) => {
    setBusy(id);
    const res = await fn(id);
    setBusy(null);
    if (res.error) {
      toast.error(res.error);
      // The list is stale if the action was refused — someone else got there.
      refresh();
      return;
    }
    done(id, message);
  };

  /** Nothing owed hands over straight away; money due opens the tender pad. */
  const handOver = (o: PickupOrder) => {
    if (o.amountDue > 0) {
      setTendering(o);
      return;
    }
    void act(o.id, markCollected, "Handed over.");
  };

  const takePayment = async (tenders: PosTender[]) => {
    const o = tendering;
    if (!o) return {};
    const res = await markCollected(o.id, tenders);
    if (res.error) {
      // The panel stays open — the customer is standing there and the cashier
      // needs to see why, and to retry, without re-entering the tender. But the
      // list behind it may be the reason it failed (someone else got to the
      // order), so re-read it rather than leaving a queue that disagrees with
      // the server.
      refresh();
      return { error: res.error };
    }
    setTendering(null);
    done(
      o.id,
      res.changeDue
        ? `Handed over. Change ₹${res.changeDue.toLocaleString("en-IN")}.`
        : "Paid and handed over.",
    );
    return {};
  };

  return (
    <div className="min-h-dvh bg-neutral-950 text-white">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <Link
          href="/pos"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20"
          aria-label="Back to the register"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">Collections</h1>
        <span className="ml-auto text-sm text-white/50">
          {orders.length} waiting
        </span>
      </header>

      <div className="px-4 py-4">
        <form
          className="relative mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            refresh();
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-white/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Order number…"
            className="w-full rounded-xl border border-white/10 bg-white/5 py-3 pr-4 pl-10 text-base outline-none focus:border-white/30"
          />
        </form>

        {error && (
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}

        {!error && orders.length === 0 && (
          <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-white/60">
            Nothing waiting to be collected.
          </p>
        )}

        <ul className="space-y-3">
          {orders.map((o) => (
            <li
              key={o.id}
              className="rounded-xl border border-white/10 bg-white/5 p-4"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-base font-semibold">
                  {o.orderRef}
                </span>
                {o.status === "ready" && (
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300">
                    Ready
                  </span>
                )}
                {/* Whether to ask for money is the first thing the cashier
                    needs to know — before they open the order, not after. */}
                {o.amountDue > 0 && (
                  <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300">
                    {money(o.amountDue)} to pay
                  </span>
                )}
                <span className="ml-auto text-base font-semibold">
                  {money(o.total)}
                </span>
              </div>
              <p className="mt-1 text-sm text-white/60">
                {o.customerName ?? "Customer"} · {o.itemCount} item
                {o.itemCount === 1 ? "" : "s"}
                {o.expiresAt ? ` · ${expiryLabel(o.expiresAt)}` : ""}
              </p>

              <div className="mt-3 flex gap-2">
                {o.status === "awaiting" && (
                  <button
                    type="button"
                    disabled={busy === o.id}
                    onClick={() =>
                      act(o.id, markReadyForPickup, "Marked ready.")
                    }
                    className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-medium hover:bg-white/20 disabled:opacity-50"
                  >
                    <PackageCheck className="h-4 w-4" />
                    Mark ready
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy === o.id}
                  onClick={() => handOver(o)}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy === o.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : o.amountDue > 0 ? (
                    <Wallet className="h-4 w-4" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  {o.amountDue > 0 ? "Take payment" : "Hand over"}
                </button>
              </div>
            </li>
          ))}
        </ul>

        {pending && (
          <p className="mt-4 text-center text-sm text-white/40">Refreshing…</p>
        )}
      </div>

      {tendering && (
        <TenderPanel
          total={tendering.amountDue}
          title={`Collect ${tendering.orderRef}`}
          confirmLabel="Take payment & hand over"
          onCancel={() => setTendering(null)}
          onComplete={takePayment}
        />
      )}
    </div>
  );
}
