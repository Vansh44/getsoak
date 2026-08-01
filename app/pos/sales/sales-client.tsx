"use client";

// "Can I have my bill again?" — the commonest thing a counter is asked that
// the till could not do. Search recent sales at THIS shop and reprint one.
//
// Everything is scoped to the operator's own location by the action; the
// client never names a shop, so there is nothing here to spoof.

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, Receipt, Search } from "lucide-react";
import { toast } from "sonner";
import { listPosSales, type PosSaleRow } from "@/app/actions/pos-sale-actions";
import { ReceiptOverlay } from "../sell/receipt-overlay";

// Always two decimals: "₹249.9" reads as a typo, and a list of money that
// sometimes has paise and sometimes doesn't is hard to scan down.
const money = (n: number) =>
  `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** "2:14 pm" for today, "29 Jul, 2:14 pm" before that — a cashier looking for
 *  a sale from ten minutes ago shouldn't have to read a date. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
  });
  const today = new Date();
  const sameDay =
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();
  return sameDay
    ? time
    : `${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}, ${time}`;
}

export function SalesClient({
  initial,
  error,
}: {
  initial: PosSaleRow[];
  error: string | null;
}) {
  const [sales, setSales] = useState(initial);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const search = (q: string) => {
    setQuery(q);
    start(async () => {
      const res = await listPosSales(q);
      if (res.error) toast.error(res.error);
      else setSales(res.sales);
    });
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
        <h1 className="text-lg font-semibold">Sales</h1>
        <span className="ml-auto text-sm text-white/50">
          {sales.length} shown
        </span>
      </header>

      <div className="px-4 py-4">
        <form
          className="relative mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            search(query);
          }}
        >
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-white/40" />
          <input
            value={query}
            onChange={(e) => search(e.target.value)}
            placeholder="Receipt number, order number or customer…"
            className="w-full rounded-xl border border-white/10 bg-white/5 py-3 pr-4 pl-10 text-base outline-none focus:border-white/30"
          />
        </form>

        {error && (
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}

        {!error && sales.length === 0 && (
          <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-white/60">
            {query
              ? `Nothing matches “${query}”.`
              : "No sales yet at this shop."}
          </p>
        )}

        <ul className="space-y-2">
          {sales.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setOpenId(s.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-left transition-colors hover:bg-white/10"
              >
                <Receipt className="h-5 w-5 shrink-0 text-white/40" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-sm font-semibold">
                      {s.receiptNo}
                    </span>
                    {s.refunded && (
                      <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[11px] font-medium text-red-300">
                        Cancelled
                      </span>
                    )}
                  </span>
                  <span className="block text-sm text-white/60">
                    {when(s.createdAt)} · {s.itemCount} item
                    {s.itemCount === 1 ? "" : "s"}
                    {s.customerName ? ` · ${s.customerName}` : ""}
                    {s.cashierName ? ` · ${s.cashierName}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-base font-semibold">
                  {money(s.total)}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {pending && (
          <p className="mt-4 text-center text-sm text-white/40">Searching…</p>
        )}
      </div>

      {openId && (
        <ReceiptOverlay
          orderId={openId}
          mode="reprint"
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
