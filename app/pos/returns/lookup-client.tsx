"use client";

// Finding the order to take back (roadmap Step 5).
//
// A customer returning an ONLINE order has an order number on their phone, or
// nothing but the number they ordered with — not a receipt from this shop. So
// the search spans the whole STORE, and the "was this bought here?" question
// is answered as a label rather than as a filter: showing someone their order
// and then explaining the counter can't take it is a far better experience
// than an empty result that looks like the order doesn't exist.

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, Search } from "lucide-react";
import {
  findOrderForReturn,
  type FoundOrder,
} from "@/app/actions/pos-return-actions";

function money(n: number): string {
  return `₹${n.toFixed(2)}`;
}

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

export function ReturnsLookup() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<FoundOrder[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, start] = useTransition();

  // Derived, not effect state: below the floor there is nothing to show, and
  // clearing it with a setState in the effect body is both a React warning and
  // an extra render. This way backspacing hides stale hits immediately.
  const tooShort = q.trim().length < 4;
  const visible = tooShort ? [] : results;

  // Debounced so a scanner burst or a fast typist doesn't fire per keystroke.
  useEffect(() => {
    if (q.trim().length < 4) return;
    const handle = setTimeout(() => {
      start(async () => {
        const res = await findOrderForReturn(q);
        // setState only after the await — never synchronously in the effect.
        setResults(res.results);
        setSearched(true);
      });
    }, 350);
    return () => clearTimeout(handle);
  }, [q]);

  return (
    <div className="min-h-dvh bg-neutral-950 text-white">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <Link
          href="/pos"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-semibold">Take a return</h1>
      </header>

      <div className="mx-auto max-w-3xl p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-white/40" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Order number, phone or email"
            className="w-full rounded-xl border border-white/10 bg-white/5 py-3.5 pr-4 pl-11 text-base outline-none focus:border-white/30"
          />
          {pending && (
            <Loader2 className="absolute top-1/2 right-3 h-5 w-5 -translate-y-1/2 animate-spin text-white/40" />
          )}
        </div>

        {q.trim().length > 0 && q.trim().length < 4 && (
          <p className="mt-3 text-sm text-white/50">
            Type a bit more — at least 4 characters.
          </p>
        )}

        {searched && !tooShort && visible.length === 0 && !pending && (
          <p className="mt-6 text-center text-sm text-white/50">
            Nothing found. Check the order number, or try their phone number.
          </p>
        )}

        <ul className="mt-4 space-y-2">
          {visible.map((r) => (
            <li key={r.orderId}>
              <Link
                href={`/pos/returns/${r.orderId}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">
                      {r.label}
                    </span>
                    {/* Said up front, so the cashier knows before they open it
                        that this one depends on the shop's settings. */}
                    {r.broughtIn && (
                      <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[11px] font-medium text-sky-300">
                        Bought elsewhere
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-white/50">
                    {fmtDate(r.createdAt)}
                    {r.paymentMethod === "razorpay"
                      ? " · paid online"
                      : r.paymentMethod === "cash_on_delivery"
                        ? " · cash on delivery"
                        : ""}
                  </div>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {money(r.total)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
