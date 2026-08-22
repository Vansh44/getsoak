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

// ★★ SOME OF THESE TAKE MONEY; THE REST ONLY WRITE IT DOWN. The shop swipes on
// their own terminal and the cashier types what it said (docs/pos-plan.md §7) —
// StoreMink never sees that money. "Charge online" is the one method actually
// charged and verified against the gateway.
//
// That distinction used to live in small grey hint text under the amount field,
// with four identically-styled buttons above it reading Cash / Card / UPI /
// Online. It did not survive contact with a real till: the store owner tapped
// UPI expecting a gateway QR, got a plain amount box, and completed a ₹99 sale
// as two unverified records. If the person who commissioned the feature reads
// the buttons that way, a cashier under queue pressure certainly will.
//
// So `kind` is the organising idea, and it is rendered as a GROUP HEADING
// rather than a hint: "Take payment" vs "Record a payment already taken".
// A cashier picks the row that matches what physically happened.
type TenderKind = "take" | "record" | "apply";

interface TenderOption {
  id: PosTenderMethod;
  label: string;
  hint?: string;
  kind: TenderKind;
}

const GROUP_LABEL: Record<TenderKind, string> = {
  take: "Take payment now",
  record: "Record a payment already taken",
  apply: "Apply a balance",
};

const METHODS: TenderOption[] = [
  { id: "cash", label: "Cash", kind: "take", hint: "Goes in the drawer" },
  // Named for the DEVICE, not the rail: "Card" and "UPI" describe what the
  // customer did, which is exactly the ambiguity — "Card machine" and "UPI app"
  // describe whose equipment took it, which is the thing that matters here.
  {
    id: "card",
    label: "Card machine",
    kind: "record",
    hint: "Your own terminal — StoreMink can't verify this",
  },
  {
    id: "upi",
    label: "UPI app",
    kind: "record",
    hint: "Your own UPI — StoreMink can't verify this",
  },
];

/** The cashier-facing name for a tender already added to this sale. */
function labelFor(method: PosTenderMethod): string {
  switch (method) {
    case "razorpay":
      return "Charged online";
    case "store_credit":
      return "Store credit";
    case "card":
      return "Card machine";
    case "upi":
      return "UPI app";
    case "cash":
      return "Cash";
    default:
      return method;
  }
}

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
  storeCredit,
  onTakeOnline,
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
  /**
   * The attached customer's store-credit balance, or null when no customer is
   * attached (a balance belongs to somebody).
   *
   * ★ DISPLAY AND A CAP, NEVER THE AUTHORITY. `placePosSale` re-reads the
   * balance and spends it through a conditional UPDATE, so a number that went
   * stale between opening this panel and completing the sale costs a clear
   * refusal, not an overdraw.
   */
  storeCredit?: number | null;
  /**
   * Take a VERIFIED gateway payment for `amount` (roadmap Step 12).
   *
   * ★ OPT-IN VIA THE HANDLER, like `onVerifyManager` — so the method appears
   * only where it can actually settle. The collection counter shares this panel
   * and `markCollected` has no gateway verification wired, so it passes nothing
   * and is untouched; that is the same rule `COUNTER_TENDER_METHODS` states for
   * store credit.
   *
   * The parent owns the whole start → modal → confirm dance and hands back the
   * gateway's payment id. The panel never talks to Razorpay itself, and never
   * decides that money arrived.
   */
  onTakeOnline?: (
    amount: number,
  ) => Promise<{ reference?: string; error?: string }>;
}) {
  const [method, setMethod] = useState<PosTenderMethod>("cash");
  const [amount, setAmount] = useState<string>("");
  const [reference, setReference] = useState("");
  const [taken, setTaken] = useState<PosTender[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ★★ TWO STAGES, BECAUSE ONE SCREEN COULD NOT ANSWER "WHAT DO I TAP".
  // The pad used to open straight onto a method row and an amount box, which
  // silently made every payment a potential split and every split invisible.
  // Now: pick what happened (options), then say how much (pay). `splitting`
  // is the difference between "pay all of it this way" and "pay part of it
  // this way" — the latter is Shopify's named door, and the thing the store
  // owner asked for twice after unknowingly using it.
  const [stage, setStage] = useState<"options" | "pay">("options");
  const [splitting, setSplitting] = useState(false);
  const [managerPin, setManagerPin] = useState<string | null>(null);
  const [pin, setPin] = useState("");

  const paid = taken.reduce((s, t) => s + t.amount, 0);
  const remaining = changeDue(total, paid);
  const entered = Number(amount) || 0;
  const change = method === "cash" ? changeDue(entered, remaining) : 0;
  // Cash can be over-handed (change), and a split is a part by definition.
  // Every other single-method payment settles the balance exactly.
  const amountIsEditable = splitting || method === "cash";
  // Store credit already renders its own "Apply ₹N" action above, bounded by
  // the balance on the account — a second full-width button under it would be
  // the same tap twice.
  const hasOwnAction = method === "store_credit";

  // ★ OFFERED ONLY WHEN THERE IS SOMETHING TO SPEND. A greyed-out "Store
  // credit" button on every walk-in sale is a control that never works and one
  // more thing to read past at a busy counter.
  const creditAvailable = Math.max(0, storeCredit ?? 0);
  // What is left of the balance after credit already staged on THIS sale —
  // otherwise tapping it twice would offer the full balance again.
  const creditStaged = taken
    .filter((t) => t.method === "store_credit")
    .reduce((sum, t) => sum + t.amount, 0);
  const creditLeft = Math.max(0, creditAvailable - creditStaged);
  const methods: TenderOption[] = [
    ...METHODS,
    ...(onTakeOnline
      ? [
          {
            id: "razorpay" as const,
            // A VERB, because this button does something: it opens the gateway
            // and charges. "Online" sat beside "UPI" reading like another way
            // to describe the same tap.
            label: "Charge online",
            kind: "take" as const,
            hint: "Charged and verified with Razorpay",
          },
        ]
      : []),
    ...(creditLeft > 0
      ? [
          {
            id: "store_credit" as const,
            label: "Store credit",
            kind: "apply" as const,
          },
        ]
      : []),
  ];
  // Only the groups that actually have a method in them, in a fixed order so
  // the pad does not reshuffle under a cashier's finger between sales.
  const groups: TenderKind[] = (["take", "record", "apply"] as const).filter(
    (k) => methods.some((m) => m.kind === k),
  );
  const activeHint = methods.find((m) => m.id === method)?.hint;

  /**
   * Charge `value` through the gateway, and stage it ONLY once the server says
   * the money is really there.
   *
   * ★★ THE TENDER IS ADDED AFTER CONFIRMATION, NEVER BEFORE. Staging it
   * optimistically would let a cashier complete a sale on a payment that never
   * captured — the till would be balanced against money the shop does not have,
   * and the goods are already across the counter.
   *
   * ★ A DISMISSED MODAL IS A NORMAL OUTCOME, not an error to recover from: the
   * customer changed their mind, or the card failed. Nothing is staged, the
   * other tenders on this sale survive untouched, and the cashier can take the
   * amount another way — which is the half-tendered exit a counter needs.
   */
  const takeOnline = async (value: number) => {
    if (!onTakeOnline || value <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onTakeOnline(value);
      if (res.error || !res.reference) {
        setError(res.error ?? "That payment didn't go through.");
        return;
      }
      setTaken((t) => [
        ...t,
        { method: "razorpay", amount: value, reference: res.reference },
      ]);
      setAmount("");
      setStage("options");
    } catch {
      setError("Couldn't reach the payment gateway.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * ★★ ONE TAP, NOT TWO. A card/UPI/gateway payment for the whole balance left
   * the cashier looking at "Charge ₹52" and a separate "Complete sale" that
   * could do nothing else — the sale was fully covered the instant the tender
   * landed, so the second button was a question with one answer.
   *
   * Cash and splits keep the explicit confirm: cash can be over-handed and the
   * change is worth reading before committing, and a split is by definition
   * unfinished when a tender is added.
   */
  const settleNow = async (value: number) => {
    if (value <= 0) return;
    setBusy(true);
    setError(null);
    let tender: PosTender;
    if (method === "razorpay") {
      if (!onTakeOnline) return setBusy(false);
      const res = await onTakeOnline(value);
      if (res.error || !res.reference) {
        setBusy(false);
        setError(res.error ?? "That payment didn't go through.");
        return;
      }
      tender = { method: "razorpay", amount: value, reference: res.reference };
    } else {
      tender = {
        method,
        amount: value,
        ...(reference ? { reference } : {}),
      };
    }
    setBusy(false);
    await finish(undefined, [...taken, tender]);
  };

  const addTender = (value: number) => {
    if (value <= 0) return;
    // ★ Clamped to what is actually on the account. The server refuses an
    // overdraw anyway, but a refusal that arrives AFTER the customer has been
    // told a total is the thing to avoid — the counter should not be able to
    // stage a payment that cannot settle.
    if (method === "store_credit" && value > creditLeft + 0.0001) {
      setError(
        `Only ₹${creditLeft.toLocaleString("en-IN")} of store credit is available.`,
      );
      return;
    }
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
    // Back to the grid for whatever is still owed, so the next portion is
    // picked from the same screen as the first rather than from a row of
    // chips the cashier has to notice.
    setStage("options");
  };

  const finish = async (approvalToken?: string, tenders?: PosTender[]) => {
    setBusy(true);
    setError(null);
    // ★ Takes the list explicitly so a one-tap settle can pass the tender it
    // just created: setTaken is async, so reading state here would submit the
    // sale WITHOUT the payment that triggered it.
    const res = await onComplete(tenders ?? taken, approvalToken);
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
      <div className="w-full max-w-lg rounded-2xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded p-1 text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-2)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Manager approval gate */}
        {managerPin !== null ? (
          <div>
            <div className="mb-3 flex items-center gap-2 text-[var(--pos-warn)]">
              <ShieldCheck className="h-5 w-5" strokeWidth={2} />
              <span className="font-semibold">Manager approval needed</span>
            </div>
            {error && (
              <p className="mb-3 text-sm text-[var(--pos-danger)]">{error}</p>
            )}
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
              className="w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 py-3 text-center outline-none focus:border-[var(--pos-border-strong)]"
            />
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setManagerPin(null);
                  setPin("");
                  setError(null);
                }}
                className="flex-1 rounded-xl bg-[var(--pos-surface-2)] py-3 text-sm font-medium hover:bg-[var(--pos-surface-3)]"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || pin.length !== 8}
                onClick={approveAndFinish}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-40 text-white"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Approve
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-4 rounded-xl bg-[var(--pos-surface)] p-4 text-center">
              <div className="text-sm text-[var(--pos-ink-2)]">
                {covered ? "Paid in full" : "Remaining"}
              </div>
              <div className="text-3xl font-bold">
                ₹{(covered ? total : remaining).toLocaleString("en-IN")}
              </div>
              {change > 0 && (
                <div className="mt-1 text-sm text-[var(--pos-ok)]">
                  Change ₹{change.toLocaleString("en-IN")}
                </div>
              )}
            </div>

            {taken.length > 0 && (
              <div className="mb-3 space-y-1">
                {taken.map((t, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between rounded-lg bg-[var(--pos-surface)] px-3 py-1.5 text-sm"
                  >
                    <span>{labelFor(t.method)}</span>
                    <span className="flex items-center gap-2">
                      ₹{t.amount.toLocaleString("en-IN")}
                      <button
                        type="button"
                        onClick={() =>
                          setTaken((x) => x.filter((_, j) => j !== i))
                        }
                        className="text-[var(--pos-ink-3)] hover:text-[var(--pos-ink)]"
                        aria-label="Remove payment"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ── Stage 1: what happened ──────────────────────────────
                Big, evenly-weighted tiles rather than a chip row, so the
                choice reads as a decision rather than a filter. Each says what
                it DOES underneath its name; the gateway one carries a badge,
                because "verified" belongs on the control, not in a hint. */}
            {!covered && stage === "options" && (
              <div className="mb-1 grid grid-cols-2 gap-2">
                {methods.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setMethod(m.id);
                      setSplitting(false);
                      // ★ PREFILLED, because the amount is not in question:
                      // the cashier has just said this method is paying the
                      // whole balance. Typing a figure the screen already
                      // shows twice is pure friction, and a blank box that
                      // silently means "all of it" is worse — it teaches
                      // nothing and looks like an unfinished form.
                      setAmount(String(remaining));
                      setError(null);
                      setStage("pay");
                    }}
                    className="rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface-2)] px-3 py-4 text-left transition-colors hover:bg-[var(--pos-surface-3)]"
                  >
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      {m.id === "razorpay" && (
                        <ShieldCheck className="h-4 w-4 shrink-0" />
                      )}
                      {m.label}
                    </span>
                    {m.hint && (
                      <span className="mt-0.5 block text-xs text-[var(--pos-ink-3)]">
                        {m.hint}
                      </span>
                    )}
                  </button>
                ))}

                {/* ★ Shown DISABLED rather than hidden when no gateway is
                    connected. A merchant who has never linked one otherwise has
                    no way to learn from the till that the option exists. */}
                {!onTakeOnline && (
                  <div
                    aria-disabled
                    className="rounded-xl border border-[var(--pos-border)] px-3 py-4 text-left opacity-50"
                  >
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      <ShieldCheck className="h-4 w-4 shrink-0" />
                      Charge online
                    </span>
                    <span className="mt-0.5 block text-xs text-[var(--pos-ink-3)]">
                      Connect a payment gateway in Channels
                    </span>
                  </div>
                )}

                {/* The named door. Splitting was always possible and never
                    discoverable; this is the same behaviour with a handle. */}
                <button
                  type="button"
                  onClick={() => {
                    setSplitting(true);
                    setAmount("");
                    setError(null);
                    setStage("pay");
                  }}
                  className="col-span-2 rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface-2)] px-3 py-3.5 text-center text-sm font-semibold transition-colors hover:bg-[var(--pos-surface-3)]"
                >
                  Split payment
                  <span className="mt-0.5 block text-xs font-normal text-[var(--pos-ink-3)]">
                    Pay part now, the rest another way
                  </span>
                </button>
              </div>
            )}

            {!covered && stage === "pay" && (
              <>
                {/* Which method this portion is going on, and the way back. */}
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    {method === "razorpay" && (
                      <ShieldCheck className="h-4 w-4 shrink-0" />
                    )}
                    {splitting ? "Split payment" : labelFor(method)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setStage("options");
                      setAmount("");
                      setError(null);
                    }}
                    className="rounded-lg px-2 py-1 text-xs text-[var(--pos-ink-2)] transition-colors hover:bg-[var(--pos-surface-2)]"
                  >
                    Change
                  </button>
                </div>

                {/* Splitting still has to say WHICH method this portion is on,
                    so the grouped rows stay — but only here, where the cashier
                    has already declared they are dividing the payment. */}
                {splitting && (
                  <div className="mb-3 space-y-2.5">
                    {groups.map((kind) => (
                      <div key={kind}>
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--pos-ink-3)]">
                          {GROUP_LABEL[kind]}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {methods
                            .filter((m) => m.kind === kind)
                            .map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => setMethod(m.id)}
                                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-colors ${
                                  method === m.id
                                    ? "bg-[var(--pos-accent)] text-[var(--pos-on-accent)]"
                                    : "bg-[var(--pos-surface-2)] text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-3)]"
                                }`}
                              >
                                {m.id === "razorpay" && (
                                  <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                                )}
                                {m.label}
                              </button>
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {method === "store_credit" && (
                  <div className="mb-3">
                    <button
                      type="button"
                      onClick={() => addTender(Math.min(creditLeft, remaining))}
                      className="w-full rounded-lg bg-[var(--pos-surface-2)] py-2.5 text-sm font-medium transition-colors hover:bg-[var(--pos-surface-3)]"
                    >
                      Apply ₹
                      {Math.min(creditLeft, remaining).toLocaleString("en-IN")}
                    </button>
                    <p className="mt-1.5 text-center text-xs text-[var(--pos-ink-3)]">
                      ₹{creditLeft.toLocaleString("en-IN")} available
                      {creditLeft < remaining
                        ? " — the rest still needs paying"
                        : ""}
                    </p>
                  </div>
                )}

                {method === "cash" && (
                  <div className="mb-3 grid grid-cols-4 gap-1.5">
                    {quickCash(remaining).map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => addTender(v)}
                        className="rounded-lg bg-[var(--pos-surface-2)] py-2 text-sm font-medium hover:bg-[var(--pos-surface-3)]"
                      >
                        ₹{v}
                      </button>
                    ))}
                  </div>
                )}

                {/* Says which of these StoreMink actually charges. */}
                {activeHint && (
                  <p className="mb-2 text-xs text-[var(--pos-ink-3)]">
                    {activeHint}
                  </p>
                )}

                {/* ★★ THE AMOUNT IS ONLY A QUESTION IN TWO CASES: the cashier
                    is splitting, or it is CASH, which can be over-handed and
                    produce change. Picking a card/UPI/gateway tile already
                    said "this pays the whole sale", so leaving the figure
                    editable there just invites the accident it was meant to
                    remove — one keystroke turned a ₹599 charge into ₹59 with a
                    part-payment banner as the only warning. Non-cash,
                    non-split now shows no box at all: the balance is the
                    heading, and the button carries it. */}
                {amountIsEditable ? (
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
                          // ★ In split mode a blank box means "I haven't said how
                          // much yet", NOT "all of it" — defaulting there would
                          // quietly settle the sale the cashier was dividing.
                          const value = splitting
                            ? entered
                            : entered || remaining;
                          if (!value) return;
                          if (method === "razorpay") takeOnline(value);
                          else addTender(value);
                        }
                      }}
                      className="flex-1 rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2.5 text-sm outline-none focus:border-[var(--pos-border-strong)]"
                    />
                    {method === "razorpay" ? (
                      <button
                        type="button"
                        disabled={busy || (splitting && !entered)}
                        onClick={() =>
                          takeOnline(splitting ? entered : entered || remaining)
                        }
                        className="flex items-center gap-2 rounded-xl bg-[var(--pos-surface-2)] px-4 text-sm font-medium hover:bg-[var(--pos-surface-3)] disabled:opacity-40"
                      >
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        {entered > 0
                          ? `Charge ₹${entered.toLocaleString("en-IN")}`
                          : "Charge"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={splitting && !entered}
                        onClick={() =>
                          addTender(splitting ? entered : entered || remaining)
                        }
                        className="rounded-xl bg-[var(--pos-surface-2)] px-4 text-sm font-medium hover:bg-[var(--pos-surface-3)] disabled:opacity-40"
                      >
                        {entered > 0
                          ? `Add ₹${entered.toLocaleString("en-IN")}`
                          : "Add"}
                      </button>
                    )}
                  </div>
                ) : hasOwnAction ? null : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => settleNow(remaining)}
                    className="mb-2 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--pos-accent)] py-3 text-sm font-semibold text-[var(--pos-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {method === "razorpay"
                      ? `Charge ₹${remaining.toLocaleString("en-IN")}`
                      : `${confirmLabel} · ₹${remaining.toLocaleString("en-IN")}`}
                  </button>
                )}

                {/* ★ NOT for a gateway payment: its reference is the gateway's
                    own payment id, returned by the server after verification.
                    A typed box here would invite a cashier to hand-enter one,
                    which is precisely the unverified tender Step 12 removes. */}
                {/* ★★ SPLITTING WAS ALREADY POSSIBLE AND COMPLETELY INVISIBLE.
                    Add a tender for less than the total and the rest simply
                    stays outstanding — but nothing on the pad said so, the
                    amount box is pre-filled with the whole balance, and the
                    store owner asked for "a split payment option" days after
                    unknowingly performing one. This is that feature: not new
                    behaviour, just the existing behaviour made legible.

                    It resolves to a live preview once an amount under the
                    balance is typed, so the cashier sees the outcome BEFORE
                    committing rather than discovering it afterwards. */}
                {entered > 0 && entered < remaining ? (
                  <p className="mb-2 rounded-lg bg-[var(--pos-surface-2)] px-3 py-2 text-xs text-[var(--pos-ink-2)]">
                    Part payment — ₹{entered.toLocaleString("en-IN")} now, ₹
                    {(remaining - entered).toLocaleString("en-IN")} still to
                    pay.
                  </p>
                ) : (
                  splitting && (
                    <p className="mb-2 text-xs text-[var(--pos-ink-3)]">
                      Enter the part being paid this way.
                    </p>
                  )
                )}

                {method !== "cash" && method !== "razorpay" && (
                  <input
                    value={reference}
                    placeholder="Approval / reference code (optional)"
                    onChange={(e) => setReference(e.target.value.slice(0, 60))}
                    className="mb-2 w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--pos-border-strong)]"
                  />
                )}
              </>
            )}

            {onReceiptEmail && (
              <label className="mb-2 block">
                <span className="mb-1 block text-xs text-[var(--pos-ink-2)]">
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
                  className="w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2 text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
                />
              </label>
            )}

            {error && (
              <p className="mb-2 text-sm text-[var(--pos-danger)]">{error}</p>
            )}

            {/* ★ NEVER GATED ON THE EMAIL. A typo or an empty box must not stop
                someone paying — the paper receipt is the real one, and a till
                that refuses a sale over an optional field is unusable
                (roadmap invariant 6). */}
            {/* ★ HIDDEN on the one-tap path, where the button above already
                settles and completes. Leaving it there put two buttons on
                screen for a sale with one remaining action, the second of them
                permanently disabled until the first was pressed — which reads
                as a broken form, not a sequence. It stays for cash (change is
                worth reading first), for splits (unfinished by definition) and
                once the balance is covered. */}
            {(amountIsEditable || hasOwnAction || covered) && (
              <button
                type="button"
                disabled={busy || taken.length === 0 || !covered}
                onClick={() => finish()}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {confirmLabel}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
