"use client";

// Attach an existing customer to the sale, and capture a B2B GSTIN.
//
// Only customers who already exist are searchable. The register cannot CREATE
// one: `users.id` is the Firebase uid and (phone, store_id) is unique, so a
// till-invented row would collide with — and break — that same person's later
// online signup. Walk-in capture needs a claim/merge story (CRM phase).
//
// The GSTIN is independent of the attach: a business buyer can get their GSTIN
// on the invoice without having an account at all.

import { useEffect, useState } from "react";
import { Loader2, Search, UserRound, X } from "lucide-react";
import {
  searchPosCustomers,
  type PosCustomer,
} from "@/app/actions/pos-sale-actions";

export function CustomerPanel({
  customer,
  gstin,
  gstEnabled,
  onPick,
  onGstin,
  onClose,
}: {
  customer: PosCustomer | null;
  gstin: string;
  /** Hide the GSTIN field entirely for stores that don't charge GST. */
  gstEnabled: boolean;
  onPick: (c: PosCustomer | null) => void;
  onGstin: (v: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PosCustomer[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = query.trim();
  // Derived, not stored: below the 2-character floor there is nothing to show,
  // and deriving it means the list can't linger from a longer previous query.
  const visible = q.length >= 2 ? results : [];

  useEffect(() => {
    if (q.length < 2) return;
    // Debounced, and it still round-trips: a customer list is personal data
    // and has no business being cached on a shared till.
    const t = setTimeout(async () => {
      setSearching(true);
      const res = await searchPosCustomers(q);
      setSearching(false);
      setError(res.error ?? null);
      setResults(res.customers);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0b0f14] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Customer</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/50 hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {customer ? (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {customer.name}
              </div>
              <div className="truncate text-xs text-white/50">
                {customer.phone}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onPick(null)}
              className="shrink-0 rounded-lg px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white"
            >
              Remove
            </button>
          </div>
        ) : (
          <>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
              <input
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Phone, name or email…"
                className="w-full rounded-xl border border-white/15 bg-white/5 py-2.5 pl-9 pr-3 text-sm outline-none placeholder:text-white/30 focus:border-white/40"
              />
              {searching && (
                <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-white/40" />
              )}
            </div>

            {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

            <div className="mb-4 max-h-56 overflow-y-auto">
              {visible.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onPick(c)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/10"
                >
                  <UserRound
                    className="h-4 w-4 shrink-0 text-white/40"
                    strokeWidth={2}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{c.name}</span>
                    <span className="block truncate text-xs text-white/50">
                      {c.phone}
                      {c.email ? ` · ${c.email}` : ""}
                    </span>
                  </span>
                </button>
              ))}
              {q.length >= 2 && !searching && visible.length === 0 && (
                <p className="px-1 py-4 text-center text-sm text-white/40">
                  No customer found. The sale can go through without one.
                </p>
              )}
            </div>
          </>
        )}

        {gstEnabled && (
          <label className="block">
            <span className="mb-1 block text-xs text-white/50">
              GSTIN (for a business invoice)
            </span>
            <input
              value={gstin}
              onChange={(e) =>
                onGstin(e.target.value.toUpperCase().slice(0, 15))
              }
              placeholder="22AAAAA0000A1Z5"
              autoCapitalize="characters"
              autoCorrect="off"
              className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm tracking-wide outline-none placeholder:tracking-normal placeholder:text-white/25 focus:border-white/40"
            />
          </label>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-xl bg-white/10 py-2.5 text-sm font-semibold transition-colors hover:bg-white/20"
        >
          Done
        </button>
      </div>
    </div>
  );
}
