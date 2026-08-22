"use client";

// "Can I have my bill again?" — the commonest thing a counter is asked that
// the till could not do. Search recent sales at THIS shop and reprint one.
//
// Everything is scoped to the operator's own location by the action; the
// client never names a shop, so there is nothing here to spoof.

import { useState, useTransition } from "react";
import Link from "next/link";
import { Receipt, RotateCcw, Search } from "lucide-react";
import { toast } from "sonner";
import { listPosSales, type PosSaleRow } from "@/app/actions/pos-sale-actions";
import {
  DEFAULT_POS_DATE_RANGE,
  POS_DATE_RANGES,
  posDateRangePhrase,
  type PosDateRangeKey,
} from "@/lib/pos/date-range";
import { ReceiptOverlay } from "../sell/receipt-overlay";
import { PosScreen } from "../pos-screen";

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
  canRefund,
}: {
  initial: PosSaleRow[];
  error: string | null;
  /** Returns are a manager capability — a cashier can reprint but not refund. */
  canRefund: boolean;
}) {
  const [sales, setSales] = useState(initial);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<PosDateRangeKey>(DEFAULT_POS_DATE_RANGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // ONE fetch for both controls. Searching and filtering are the same query
  // with different arguments, so they must not be two paths that can disagree
  // about which is currently applied.
  const load = (q: string, r: PosDateRangeKey) => {
    start(async () => {
      const res = await listPosSales(q, r);
      if (res.error) toast.error(res.error);
      else setSales(res.sales);
    });
  };

  const search = (q: string) => {
    setQuery(q);
    load(q, range);
  };

  const pickRange = (r: PosDateRangeKey) => {
    setRange(r);
    load(query, r);
  };

  const phrase = posDateRangePhrase(range);

  return (
    // Chrome from PosScreen: no hand-rolled back arrow (the rail is the way
    // out, and it goes anywhere in one tap), and no page background of its own —
    // this screen used to paint `bg-neutral-950` over the shell's `bg-[var(--pos-bg)]`,
    // so the app had two darks depending which screen you were on.
    <PosScreen title="Sales" subtitle={`${sales.length} shown`}>
      <form
        className="relative mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          search(query);
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--pos-ink-3)]" />
        <input
          value={query}
          onChange={(e) => search(e.target.value)}
          placeholder="Receipt number, order number or customer…"
          className="w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] py-3 pr-4 pl-10 text-base outline-none focus:border-[var(--pos-border-strong)]"
        />
      </form>

      {/* Preset chips, not a date picker. At a counter the question is almost
          always "today" — reconciling a drawer, or finding the bill from ten
          minutes ago — and two calendar popovers to answer it is the wrong
          trade. A custom range can be added if anyone actually asks. */}
      <div className="mb-4 flex flex-wrap gap-2">
        {POS_DATE_RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => pickRange(r.key)}
            aria-pressed={range === r.key}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              range === r.key
                ? "bg-[var(--pos-accent)] text-[var(--pos-on-accent)]"
                : "bg-[var(--pos-surface-2)] text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-3)] hover:text-[var(--pos-ink)]"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="rounded-xl border border-[var(--pos-danger-border)] bg-[var(--pos-danger-soft)] px-4 py-3 text-sm text-[var(--pos-danger)]">
          {error}
        </p>
      )}

      {!error && sales.length === 0 && (
        <p className="rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 py-8 text-center text-sm text-[var(--pos-ink-2)]">
          {/* Naming the filter matters: "No sales yet at this shop" under a
              Today chip reads as "this till has never sold anything", which
              for a shop that opened an hour ago is alarming and wrong. */}
          {query
            ? `Nothing matches “${query}”${phrase ? ` ${phrase}` : ""}.`
            : phrase
              ? `No sales ${phrase}.`
              : "No sales yet at this shop."}
        </p>
      )}

      <ul className="space-y-2">
        {sales.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => setOpenId(s.id)}
              className="flex w-full items-center gap-3 rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-4 text-left transition-colors hover:bg-[var(--pos-surface-2)]"
            >
              <Receipt className="h-5 w-5 shrink-0 text-[var(--pos-ink-3)]" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-sm font-semibold">
                    {s.receiptNo}
                  </span>
                  {s.refunded && (
                    <span className="rounded-full bg-[var(--pos-danger-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--pos-danger)]">
                      Cancelled
                    </span>
                  )}
                </span>
                <span className="block text-sm text-[var(--pos-ink-2)]">
                  {when(s.createdAt)} · {s.itemCount} item
                  {s.itemCount === 1 ? "" : "s"}
                  {s.customerName ? ` · ${s.customerName}` : ""}
                  {s.cashierName ? ` · by ${s.cashierName}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-base font-semibold">
                {money(s.total)}
              </span>
            </button>
            {canRefund && !s.refunded && (
              <Link
                href={`/pos/returns/${s.id}`}
                className="mt-1 ml-11 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--pos-ink-2)] transition-colors hover:text-[var(--pos-ink)]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Return items
              </Link>
            )}
          </li>
        ))}
      </ul>

      {pending && (
        <p className="mt-4 text-center text-sm text-[var(--pos-ink-3)]">
          Searching…
        </p>
      )}

      {openId && (
        <ReceiptOverlay
          orderId={openId}
          mode="reprint"
          onClose={() => setOpenId(null)}
        />
      )}
    </PosScreen>
  );
}
