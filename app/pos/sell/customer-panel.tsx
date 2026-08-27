"use client";

// Attach an existing customer to the sale, and capture a B2B GSTIN.
//
// A walk-in who isn't on file can be added here. That was blocked until pos_13
// gave it the claim story it needed — a till-created row carries a `pos_…` id
// and is ADOPTED by that person's later online signup rather than colliding
// with it (lib/pos/claim-customer.ts).
//
// Existing-customer search and new-customer creation intentionally share this
// one screen, matching the checkout decision the cashier is making. Creating is
// a clear action rather than a reward for producing an empty search result; the
// server still collapses duplicate phone numbers back to the existing customer.
// Any typed query is carried into the form so nothing is retyped.
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
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      const res = await searchPosCustomers(q);
      if (cancelled) return;
      setSearching(false);
      setError(res.error ?? null);
      setResults(res.customers);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const startCreating = () => {
    const looksLikeEmail = q.includes("@");
    const asPhone = normalizePhone(q);
    setError(null);
    setDraft({
      name: !asPhone && !looksLikeEmail ? q : "",
      phone: asPhone || "",
      email: looksLikeEmail ? q : "",
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="customer-panel-title"
        className="max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--pos-border)] bg-[var(--pos-bg)] p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="customer-panel-title" className="font-semibold">
            {customer ? "Customer details" : "Add customer"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)]"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {customer ? (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-[var(--pos-ok-border)] bg-[var(--pos-ok-soft)] px-3 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {customer.name}
              </div>
              <div className="truncate text-xs text-[var(--pos-ink-2)]">
                {customer.phone}
                {customer.email ? ` · ${customer.email}` : ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onPick(null)}
              className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)]"
            >
              Remove
            </button>
          </div>
        ) : (
          <>
            <p className="mb-2 text-xs text-[var(--pos-ink-2)]">
              Search by name, mobile number or email.
            </p>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--pos-ink-3)]" />
              <input
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Phone, name or email…"
                className="w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] py-2.5 pl-9 pr-3 text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
              />
              {q.length >= 2 && searching && (
                <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--pos-ink-3)]" />
              )}
            </div>

            {error && (
              <p className="mb-2 text-sm text-[var(--pos-danger)]">{error}</p>
            )}

            <div className="mb-4 max-h-56 overflow-y-auto">
              {visible.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onPick(c)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-[var(--pos-surface-2)]"
                >
                  <UserRound
                    className="h-4 w-4 shrink-0 text-[var(--pos-ink-3)]"
                    strokeWidth={2}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{c.name}</span>
                    <span className="block truncate text-xs text-[var(--pos-ink-2)]">
                      {c.phone}
                      {c.email ? ` · ${c.email}` : ""}
                    </span>
                  </span>
                </button>
              ))}
              {q.length >= 2 && !searching && visible.length === 0 && (
                <div className="px-1 py-4 text-center">
                  <p className="text-sm text-[var(--pos-ink-3)]">
                    No customer found.
                  </p>
                </div>
              )}
            </div>

            {!draft && (
              <button
                type="button"
                onClick={startCreating}
                className="mb-4 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--pos-surface-2)] px-3 py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--pos-surface-3)]"
              >
                <UserPlus className="h-4 w-4" />
                Create new customer
              </button>
            )}
          </>
        )}

        {draft && !customer && (
          <div className="mb-4 rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-3">
            <div className="mb-1 text-sm font-semibold">New customer</div>
            <p className="mb-2 text-xs text-[var(--pos-ink-2)]">
              Name and mobile are required. Email is optional.
            </p>
            <div className="grid gap-2">
              <input
                value={draft.name}
                autoFocus={!draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Name"
                className="w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2 text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
              />
              <input
                value={draft.phone}
                inputMode="numeric"
                autoFocus={!!draft.name}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                placeholder="Mobile number"
                className="w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2 text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
              />
              <input
                value={draft.email}
                inputMode="email"
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="Email (optional)"
                className="w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2 text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
              />
            </div>
            {/* The mobile is what a later signup matches on, so it earns a line
                of explanation rather than just being required. */}
            <p className="mt-2 text-xs text-[var(--pos-ink-3)]">
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
                className="rounded-lg px-3 py-2 text-sm text-[var(--pos-ink-2)] transition-colors hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {gstEnabled && (
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--pos-ink-2)]">
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
              className="w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2.5 text-sm tracking-wide outline-none placeholder:tracking-normal placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
            />
          </label>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-xl bg-[var(--pos-surface-2)] py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--pos-surface-3)]"
        >
          Done
        </button>
      </div>
    </div>
  );
}
