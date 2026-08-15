"use client";

// Attach an existing customer to the sale, and capture a B2B GSTIN.
//
// A walk-in who isn't on file can be added here. That was blocked until pos_13
// gave it the claim story it needed — a till-created row carries a `pos_…` id
// and is ADOPTED by that person's later online signup rather than colliding
// with it (lib/pos/claim-customer.ts).
//
// ★ THE FORM OPENS FROM THE EMPTY STATE, NOT FROM A SECOND BUTTON. "Add
// customer" sitting beside the search box invites a cashier to create a
// duplicate of someone already on file; reaching it only after a search came
// back empty means the search has happened by construction. The typed query is
// carried into the form, so nothing is retyped.
//
// The GSTIN is independent of the attach: a business buyer can get their GSTIN
// on the invoice without having an account at all.

import { useEffect, useState } from "react";
import { Loader2, Search, UserPlus, UserRound, X } from "lucide-react";
import {
  createPosCustomer,
  searchPosCustomers,
  type PosCustomer,
} from "@/app/actions/pos-sale-actions";
import { normalizePhone } from "@/lib/pos/customer-claim";

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
  // null = not adding. An object = the form is open, seeded from the query.
  const [draft, setDraft] = useState<{
    name: string;
    phone: string;
    email: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

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
                <div className="px-1 py-4 text-center">
                  <p className="text-sm text-white/40">No customer found.</p>
                  <button
                    type="button"
                    onClick={() => {
                      // Seed whichever field the query looks like, so the
                      // cashier types each detail exactly once.
                      const asPhone = normalizePhone(q);
                      setError(null);
                      setDraft({
                        name: asPhone ? "" : q,
                        phone: asPhone ? asPhone : "",
                        email: "",
                      });
                    }}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/20"
                  >
                    <UserPlus className="h-4 w-4" />
                    Add as a new customer
                  </button>
                  <p className="mt-2 text-xs text-white/30">
                    Or leave it — the sale can go through without one.
                  </p>
                </div>
              )}
            </div>
          </>
        )}

        {draft && !customer && (
          <div className="mb-4 rounded-xl border border-white/15 bg-white/5 p-3">
            <div className="mb-2 text-xs font-medium text-white/60">
              New customer
            </div>
            <div className="grid gap-2">
              <input
                value={draft.name}
                autoFocus={!draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Name"
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-white/30 focus:border-white/40"
              />
              <input
                value={draft.phone}
                inputMode="numeric"
                autoFocus={!!draft.name}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                placeholder="Mobile number"
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-white/30 focus:border-white/40"
              />
              <input
                value={draft.email}
                inputMode="email"
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="Email (optional)"
                className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-white/30 focus:border-white/40"
              />
            </div>
            {/* The mobile is what a later signup matches on, so it earns a line
                of explanation rather than just being required. */}
            <p className="mt-2 text-xs text-white/35">
              The mobile links this to their account if they ever sign up
              online.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  setError(null);
                  const res = await createPosCustomer(draft);
                  setSaving(false);
                  if (res.error || !res.customer) {
                    setError(res.error ?? "Couldn't save that customer.");
                    return;
                  }
                  // Attaching immediately is the point of having opened this —
                  // nobody adds a customer in order to then search for them.
                  onPick(res.customer);
                  setDraft(null);
                }}
                className="flex-1 rounded-lg bg-emerald-500 py-2 text-sm font-semibold text-black transition-colors hover:bg-emerald-400 disabled:opacity-60"
              >
                {saving ? "Saving…" : "Save & attach"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
                className="rounded-lg px-3 py-2 text-sm text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              >
                Cancel
              </button>
            </div>
          </div>
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
