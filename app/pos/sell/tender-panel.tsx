"use client";

import { useState } from "react";
import { Loader2, X, ShieldCheck } from "lucide-react";
import type {
  PosTender,
  PosTenderMethod,
} from "@/app/actions/pos-sale-actions";
import { changeDue, coversTotal } from "@/lib/pos/totals";

// Taking payment. The client proposes tenders; placePosSale re-derives the
// total, validates coverage, and computes change server-side — but the figures
// here now come from the SAME pure helper (lib/pos/totals.ts) working off the
// SAME tax-inclusive total, so what the cashier is shown is what gets charged.
// Before that, `total` was the pre-tax subtotal: the panel would say "Paid in
// full ₹238" and the server would answer "the payment doesn't cover the total".

const METHODS: { id: PosTenderMethod; label: string }[] = [
  { id: "cash", label: "Cash" },
  { id: "card", label: "Card" },
  { id: "upi", label: "UPI" },
];

/** Quick cash buttons: exact, then the next sensible round notes above it. */
function quickCash(total: number): number[] {
  const out = new Set<number>([Math.ceil(total)]);
  for (const step of [50, 100, 500, 2000]) {
    const up = Math.ceil(total / step) * step;
    if (up >= total) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, 4);
}

export function TenderPanel({
  total,
  title = "Take payment",
  confirmLabel = "Complete sale",
  onCancel,
  onComplete,
  onVerifyManager,
  receiptEmail,
  onReceiptEmail,
}: {
  total: number;
  /** The collection counter is settling an order bought weeks ago, not ringing
   *  a sale, so it says so. */
  title?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onComplete: (
    tenders: PosTender[],
    /** The manager's signed approval, passed straight through. The panel never
     *  decides that a sale is approved — it only carries what the server
     *  minted. */
    approvalToken?: string,
  ) => Promise<{ error?: string; needsApproval?: boolean }>;
  /** Absent where nothing can need approval — a collection is priced at
   *  checkout, so there is no discount to authorise. The PIN branch is then
   *  unreachable rather than merely unused. */
  onVerifyManager?: (
    pin: string,
  ) => Promise<{ approved?: boolean; token?: string; error?: string }>;
  /**
   * Where to email a copy of the receipt (Shopify's receipt options).
   *
   * ★ OPT-IN VIA THE HANDLER, so the collection counter — which shares this
   * panel — is untouched: that order was placed online and already has an
   * address on it, so asking again at hand-over would be a field with no job.
   */
  receiptEmail?: string;
  onReceiptEmail?: (value: string) => void;
}) {
  const [method, setMethod] = useState<PosTenderMethod>("cash");
  const [amount, setAmount] = useState<string>("");
  const [reference, setReference] = useState("");
  const [taken, setTaken] = useState<PosTender[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managerPin, setManagerPin] = useState<string | null>(null);
  const [pin, setPin] = useState("");

  const paid = taken.reduce((s, t) => s + t.amount, 0);
  const remaining = changeDue(total, paid);
  const entered = Number(amount) || 0;
  const change = method === "cash" ? changeDue(entered, remaining) : 0;

  const addTender = (value: number) => {
    if (value <= 0) return;
    setError(null);
    setTaken((t) => [
      ...t,
      {
        method,
        amount: value,
        ...(method === "cash" ? { tendered: value } : {}),
        ...(reference ? { reference } : {}),
      },
    ]);
    setAmount("");
    setReference("");
  };

  const finish = async (approvalToken?: string) => {
    setBusy(true);
    setError(null);
    const res = await onComplete(taken, approvalToken);
    setBusy(false);
    // Only open the PIN pad where a manager could actually approve. Without the
    // guard a caller with no approval path would show a keypad that can never
    // succeed, in front of a customer.
    if (res.needsApproval && onVerifyManager) {
      setManagerPin("");
      setError(res.error ?? "A manager's approval is needed.");
      return;
    }
    if (res.error) setError(res.error);
  };

  const approveAndFinish = async () => {
    if (!onVerifyManager) return;
    setBusy(true);
    setError(null);
    const v = await onVerifyManager(pin);
    if (!v.approved || !v.token) {
      setBusy(false);
      setError(v.error ?? "Incorrect manager PIN.");
      return;
    }
    setManagerPin(null);
    setPin("");
    setBusy(false);
    await finish(v.token);
  };

  // Compared in PAISE via the same helper placePosSale uses. A float compare
  // could call an exactly-covering payment short by a fraction of a paisa and
  // refuse a sale the server would have accepted.
  const covered = coversTotal(paid, total);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#12171f] p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded p-1 text-white/50 hover:bg-white/10"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Manager approval gate */}
        {managerPin !== null ? (
          <div>
            <div className="mb-3 flex items-center gap-2 text-amber-300">
              <ShieldCheck className="h-5 w-5" strokeWidth={2} />
              <span className="font-semibold">Manager approval needed</span>
            </div>
            {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
            <input
              value={pin}
              type="password"
              inputMode="numeric"
              autoFocus
              placeholder="Manager's 8-digit PIN"
              onChange={(e) =>
                setPin(e.target.value.replace(/\D/g, "").slice(0, 8))
              }
              onKeyDown={(e) => e.key === "Enter" && void approveAndFinish()}
              className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-center outline-none focus:border-white/40"
            />
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setManagerPin(null);
                  setPin("");
                  setError(null);
                }}
                className="flex-1 rounded-xl bg-white/10 py-3 text-sm font-medium hover:bg-white/20"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || pin.length !== 8}
                onClick={approveAndFinish}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-40"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Approve
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-4 rounded-xl bg-white/5 p-4 text-center">
              <div className="text-sm text-white/60">
                {covered ? "Paid in full" : "Remaining"}
              </div>
              <div className="text-3xl font-bold">
                ₹{(covered ? total : remaining).toLocaleString("en-IN")}
              </div>
              {change > 0 && (
                <div className="mt-1 text-sm text-emerald-400">
                  Change ₹{change.toLocaleString("en-IN")}
                </div>
              )}
            </div>

            {taken.length > 0 && (
              <div className="mb-3 space-y-1">
                {taken.map((t, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-sm"
                  >
                    <span className="capitalize">{t.method}</span>
                    <span className="flex items-center gap-2">
                      ₹{t.amount.toLocaleString("en-IN")}
                      <button
                        type="button"
                        onClick={() =>
                          setTaken((x) => x.filter((_, j) => j !== i))
                        }
                        className="text-white/40 hover:text-white"
                        aria-label="Remove payment"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!covered && (
              <>
                <div className="mb-3 flex gap-1.5">
                  {METHODS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMethod(m.id)}
                      className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
                        method === m.id
                          ? "bg-white text-[#0b0f14]"
                          : "bg-white/10 text-white/70 hover:bg-white/20"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                {method === "cash" && (
                  <div className="mb-3 grid grid-cols-4 gap-1.5">
                    {quickCash(remaining).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => addTender(v)}
                        className="rounded-lg bg-white/10 py-2 text-sm font-medium hover:bg-white/20"
                      >
                        ₹{v}
                      </button>
                    ))}
                  </div>
                )}

                <div className="mb-2 flex gap-2">
                  <input
                    value={amount}
                    inputMode="decimal"
                    autoFocus
                    placeholder={`Amount (₹${remaining})`}
                    onChange={(e) =>
                      setAmount(e.target.value.replace(/[^\d.]/g, ""))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTender(entered || remaining);
                      }
                    }}
                    className="flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm outline-none focus:border-white/40"
                  />
                  <button
                    type="button"
                    onClick={() => addTender(entered || remaining)}
                    className="rounded-xl bg-white/10 px-4 text-sm font-medium hover:bg-white/20"
                  >
                    Add
                  </button>
                </div>

                {method !== "cash" && (
                  <input
                    value={reference}
                    placeholder="Approval / reference code (optional)"
                    onChange={(e) => setReference(e.target.value.slice(0, 60))}
                    className="mb-2 w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:border-white/40"
                  />
                )}
              </>
            )}

            {onReceiptEmail && (
              <label className="mb-2 block">
                <span className="mb-1 block text-xs text-white/50">
                  Email a receipt (optional)
                </span>
                <input
                  value={receiptEmail ?? ""}
                  inputMode="email"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="name@example.com"
                  onChange={(e) => onReceiptEmail(e.target.value.slice(0, 160))}
                  className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-white/25 focus:border-white/40"
                />
              </label>
            )}

            {error && <p className="mb-2 text-sm text-red-400">{error}</p>}

            {/* ★ NEVER GATED ON THE EMAIL. A typo or an empty box must not stop
                someone paying — the paper receipt is the real one, and a till
                that refuses a sale over an optional field is unusable
                (roadmap invariant 6). */}
            <button
              type="button"
              disabled={busy || taken.length === 0 || !covered}
              onClick={() => finish()}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirmLabel}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
