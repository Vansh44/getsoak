"use client";

import { useRef, useState } from "react";
import {
  ArrowLeft,
  Banknote,
  CreditCard,
  Loader2,
  QrCode,
  ShieldCheck,
  UserRound,
  WalletCards,
  X,
} from "lucide-react";
import type {
  PosCustomer,
  PosTender,
  PosTenderMethod,
} from "@/app/actions/pos-sale-actions";
import { changeDue, coversTotal, paise } from "@/lib/pos/totals";

// The panel follows the same three decisions a cashier makes in the real world:
// who is buying, how they are paying, and (only for cash or a split) how much.
// Keeping those decisions on separate screens avoids presenting every checkout
// as a dense form full of internal payment-system distinctions.

interface TenderOption {
  id: PosTenderMethod;
  label: string;
  hint: string;
}

const METHODS: TenderOption[] = [
  {
    id: "cash",
    label: "Cash",
    hint: "Enter the cash received and see the change",
  },
  {
    id: "card",
    label: "Card terminal",
    hint: "Record it after your terminal approves",
  },
  {
    id: "upi",
    label: "UPI / QR",
    hint: "Record it after the payment appears in your app",
  },
];

function labelFor(method: PosTenderMethod): string {
  switch (method) {
    case "razorpay":
      return "Razorpay";
    case "store_credit":
      return "Store credit";
    case "card":
      return "Card terminal";
    case "upi":
      return "UPI / QR";
    case "cash":
      return "Cash";
    default:
      return method;
  }
}

function MethodIcon({ method }: { method: PosTenderMethod }) {
  switch (method) {
    case "cash":
      return <Banknote className="h-5 w-5" strokeWidth={2} />;
    case "card":
      return <CreditCard className="h-5 w-5" strokeWidth={2} />;
    case "upi":
      return <QrCode className="h-5 w-5" strokeWidth={2} />;
    case "razorpay":
      return <ShieldCheck className="h-5 w-5" strokeWidth={2} />;
    default:
      return <WalletCards className="h-5 w-5" strokeWidth={2} />;
  }
}

const money = (value: number) => `₹${value.toLocaleString("en-IN")}`;

/** Exact cash first, followed by useful note totals above it. */
function quickCash(total: number): number[] {
  const out = new Set<number>([Math.ceil(total)]);
  for (const step of [50, 100, 500, 2000]) {
    const up = Math.ceil(total / step) * step;
    if (up >= total) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, 4);
}

type Screen = "customer" | "methods" | "amount";

export function TenderPanel({
  total,
  title = "Payment",
  confirmLabel = "Complete sale",
  onCancel,
  onComplete,
  onVerifyManager,
  receiptEmail,
  onReceiptEmail,
  customer,
  onCustomer,
  onResolveCustomer,
  gstin,
  onGstin,
  gstEnabled,
  storeCredit,
  onTakeOnline,
}: {
  total: number;
  title?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onComplete: (
    tenders: PosTender[],
    approvalToken?: string,
  ) => Promise<{ error?: string; needsApproval?: boolean }>;
  onVerifyManager?: (
    pin: string,
  ) => Promise<{ approved?: boolean; token?: string; error?: string }>;
  /** Receipt contact is optional and collapsed below the customer summary. */
  receiptEmail?: string;
  onReceiptEmail?: (value: string) => void;
  /** Present only on the Sell checkout. Collection payments skip this step. */
  customer?: PosCustomer | null;
  onCustomer?: (customer: PosCustomer | null) => void;
  /** One explicit server round-trip after a complete number, never per key. */
  onResolveCustomer?: (
    mobile: string,
  ) => Promise<{ customer?: PosCustomer; created?: boolean; error?: string }>;
  gstin?: string;
  onGstin?: (value: string) => void;
  gstEnabled?: boolean;
  storeCredit?: number | null;
  onTakeOnline?: (
    amount: number,
  ) => Promise<{ reference?: string; error?: string }>;
}) {
  const [screen, setScreen] = useState<Screen>(
    onResolveCustomer && !customer ? "customer" : "methods",
  );
  const [method, setMethod] = useState<PosTenderMethod>("cash");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [taken, setTaken] = useState<PosTender[]>([]);
  const [split, setSplit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managerPin, setManagerPin] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [mobile, setMobile] = useState(customer?.phone ?? "");
  const [customerWasCreated, setCustomerWasCreated] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(
    Boolean((gstin ?? "").trim() || (receiptEmail ?? "").trim()),
  );
  const resolvingCustomer = useRef(false);

  const paid = taken.reduce((sum, tender) => sum + tender.amount, 0);
  const remaining = changeDue(total, paid);
  const covered = coversTotal(paid, total);
  const entered = Number(amount) || 0;
  const cashChange = method === "cash" ? changeDue(paid + entered, total) : 0;
  const creditAvailable = Math.max(0, storeCredit ?? 0);
  const creditStaged = taken
    .filter((tender) => tender.method === "store_credit")
    .reduce((sum, tender) => sum + tender.amount, 0);
  const creditLeft = Math.max(0, creditAvailable - creditStaged);

  const resolveCustomer = async () => {
    if (
      !onResolveCustomer ||
      !onCustomer ||
      mobile.length !== 10 ||
      resolvingCustomer.current
    ) {
      return;
    }
    resolvingCustomer.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await onResolveCustomer(mobile);
      if (result.error || !result.customer) {
        setError(result.error ?? "Couldn't resolve that customer.");
        return;
      }
      onCustomer(result.customer);
      setCustomerWasCreated(result.created === true);
      // The identity remains visible on Payment, so making the cashier confirm
      // it with a second button buys no safety and adds a click to every sale.
      setScreen("methods");
    } catch {
      setError(
        "Couldn't resolve that customer. Check the connection and retry.",
      );
    } finally {
      resolvingCustomer.current = false;
      setBusy(false);
    }
  };

  const methods: TenderOption[] = [
    ...METHODS,
    ...(onTakeOnline
      ? [
          {
            id: "razorpay" as const,
            label: "Razorpay",
            hint: "Open a secure payment and verify it here",
          },
        ]
      : []),
    ...(creditLeft > 0
      ? [
          {
            id: "store_credit" as const,
            label: "Store credit",
            hint: `${money(creditLeft)} available for this customer`,
          },
        ]
      : []),
  ];

  const finish = async (
    approvalToken?: string,
    nextTenders: PosTender[] = taken,
  ) => {
    setBusy(true);
    setError(null);
    const result = await onComplete(nextTenders, approvalToken);
    setBusy(false);
    if (result.needsApproval && onVerifyManager) {
      setManagerPin("");
      setError(result.error ?? "A manager's approval is needed.");
      return;
    }
    if (result.error) setError(result.error);
  };

  const approveAndFinish = async () => {
    if (!onVerifyManager) return;
    setBusy(true);
    setError(null);
    const verification = await onVerifyManager(pin);
    if (!verification.approved || !verification.token) {
      setBusy(false);
      setError(verification.error ?? "Incorrect manager PIN.");
      return;
    }
    setManagerPin(null);
    setPin("");
    setBusy(false);
    await finish(verification.token);
  };

  const chooseMethod = (next: PosTenderMethod) => {
    setMethod(next);
    setReference("");
    setError(null);
    // A full, non-cash payment has no amount decision. A split starts blank so
    // the cashier must state how much this leg covers. Cash is prefilled with
    // the balance but remains editable because notes can produce change.
    setAmount(
      next === "store_credit"
        ? String(Math.min(creditLeft, remaining))
        : split
          ? ""
          : String(remaining),
    );
    setScreen("amount");
  };

  const recordCurrentPayment = async (
    value: number,
    completeImmediately: boolean,
  ) => {
    if (value <= 0) return;
    if (method !== "cash" && paise(value) > paise(remaining)) {
      setError(`This payment can't be more than the ${money(remaining)} due.`);
      return;
    }
    if (method === "store_credit" && paise(value) > paise(creditLeft)) {
      setError(`Only ${money(creditLeft)} of store credit is available.`);
      return;
    }

    setBusy(true);
    setError(null);
    let tender: PosTender;
    if (method === "razorpay") {
      if (!onTakeOnline) {
        setBusy(false);
        return;
      }
      try {
        const result = await onTakeOnline(value);
        if (result.error || !result.reference) {
          setBusy(false);
          setError(result.error ?? "That payment didn't go through.");
          return;
        }
        tender = {
          method: "razorpay",
          amount: value,
          reference: result.reference,
        };
      } catch {
        setBusy(false);
        setError("Couldn't reach the payment gateway.");
        return;
      }
    } else {
      tender = {
        method,
        amount: value,
        ...(method === "cash" ? { tendered: value } : {}),
        ...(reference ? { reference } : {}),
      };
    }

    const nextTenders = [...taken, tender];
    const nowCovered = coversTotal(
      nextTenders.reduce((sum, item) => sum + item.amount, 0),
      total,
    );
    setTaken(nextTenders);
    setAmount("");
    setReference("");
    setScreen("methods");

    if (completeImmediately) {
      // Keep the captured/recorded tender in state before completion. If a
      // manager approval or retry is needed, the same payment is submitted
      // again instead of being charged or recorded twice.
      await finish(undefined, nextTenders);
      return;
    }

    if (!nowCovered) setSplit(true);
    setBusy(false);
  };

  const removeTender = (index: number) => {
    // A captured Razorpay payment cannot be "removed" from reality. Keeping it
    // staged is what prevents a retry from charging the customer twice.
    if (taken[index]?.method === "razorpay") {
      setError(
        "That Razorpay payment is already captured. Complete the sale without charging it again.",
      );
      return;
    }
    setTaken((current) => current.filter((_, item) => item !== index));
    setSplit(true);
    setError(null);
  };

  const activeValue =
    method === "store_credit" ? Math.min(creditLeft, remaining) : entered;
  const canRecord =
    activeValue > 0 &&
    (method === "cash" || paise(activeValue) <= paise(remaining));
  const displayTitle =
    screen === "customer" ? "Checkout" : split ? "Split payment" : title;
  const hasCapturedOnline = taken.some(
    (tender) => tender.method === "razorpay",
  );

  const closePanel = () => {
    if (hasCapturedOnline) {
      setError(
        "This Razorpay payment is already captured. Complete the sale before closing.",
      );
      return;
    }
    onCancel();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-title"
        className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-center gap-2">
          {managerPin === null && screen === "amount" && (
            <button
              type="button"
              onClick={() => {
                setScreen("methods");
                setError(null);
              }}
              disabled={busy}
              className="rounded-lg p-1.5 text-[var(--pos-ink-2)] transition-colors hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)] disabled:opacity-40"
              aria-label="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <h2 id="payment-title" className="flex-1 text-lg font-bold">
            {managerPin !== null ? "Manager approval" : displayTitle}
          </h2>
          <button
            type="button"
            onClick={closePanel}
            disabled={busy}
            className="rounded-lg p-1.5 text-[var(--pos-ink-2)] transition-colors hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)] disabled:opacity-40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

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
              onChange={(event) =>
                setPin(event.target.value.replace(/\D/g, "").slice(0, 8))
              }
              onKeyDown={(event) =>
                event.key === "Enter" && void approveAndFinish()
              }
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
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                Approve
              </button>
            </div>
          </div>
        ) : screen === "customer" ? (
          <>
            <div className="mb-5 rounded-2xl bg-[var(--pos-surface-2)] p-4 text-center">
              <p className="text-sm text-[var(--pos-ink-2)]">Total</p>
              <p className="mt-0.5 text-3xl font-bold">{money(total)}</p>
            </div>

            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">Customer mobile</p>
                {customer && (
                  <button
                    type="button"
                    onClick={() => {
                      onCustomer?.(null);
                      setMobile("");
                      setCustomerWasCreated(false);
                      setError(null);
                    }}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--pos-ink-2)] transition-colors hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)]"
                  >
                    Change number
                  </button>
                )}
              </div>
              {customer ? (
                <div className="flex w-full items-center gap-3 rounded-xl border border-[var(--pos-ok-border)] bg-[var(--pos-ok-soft)] p-3 text-left">
                  <span className="rounded-full bg-[var(--pos-surface)] p-2 text-[var(--pos-ok)]">
                    <UserRound className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">
                      {customerWasCreated
                        ? "New customer created"
                        : customer.name}
                    </span>
                    <span className="block truncate text-xs text-[var(--pos-ink-2)]">
                      +91 {customer.phone}
                      {customer.email ? ` · ${customer.email}` : ""}
                    </span>
                  </span>
                </div>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void resolveCustomer();
                  }}
                >
                  <div className="flex items-stretch gap-2">
                    <label className="flex min-w-0 flex-1 items-center rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] focus-within:border-[var(--pos-border-strong)]">
                      <span className="border-r border-[var(--pos-border)] px-3 text-sm font-medium text-[var(--pos-ink-2)]">
                        +91
                      </span>
                      <input
                        autoFocus
                        aria-label="Customer mobile number"
                        autoComplete="off"
                        inputMode="numeric"
                        pattern="[0-9]{10}"
                        maxLength={10}
                        value={mobile}
                        placeholder="10-digit mobile"
                        onChange={(event) => {
                          const digits = event.target.value.replace(/\D/g, "");
                          const national =
                            digits.length > 10 && digits.startsWith("91")
                              ? digits.slice(2, 12)
                              : digits.slice(0, 10);
                          setMobile(national);
                          setError(null);
                        }}
                        className="min-w-0 flex-1 bg-transparent px-3 py-3 text-base outline-none"
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={busy || mobile.length !== 10}
                      className="inline-flex min-w-20 items-center justify-center gap-2 rounded-xl bg-[var(--pos-accent)] px-4 text-sm font-semibold text-[var(--pos-on-accent)] hover:opacity-90 disabled:opacity-40"
                    >
                      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                      OK
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-[var(--pos-ink-3)]">
                    We check only after OK. A new number creates the customer
                    automatically.
                  </p>
                </form>
              )}
            </div>

            {error && (
              <p role="alert" className="mb-3 text-sm text-[var(--pos-danger)]">
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="mb-4 rounded-2xl bg-[var(--pos-surface-2)] p-4 text-center">
              <p className="text-sm text-[var(--pos-ink-2)]">
                {covered ? "Payment complete" : "Amount due"}
              </p>
              <p className="mt-0.5 text-3xl font-bold">
                {money(covered ? total : remaining)}
              </p>
              {covered && changeDue(paid, total) > 0 && (
                <p className="mt-1 text-sm font-medium text-[var(--pos-ok)]">
                  Give {money(changeDue(paid, total))} change
                </p>
              )}
            </div>

            {onResolveCustomer && customer && taken.length === 0 && (
              <div className="mb-4 rounded-xl border border-[var(--pos-ok-border)] bg-[var(--pos-ok-soft)] p-3">
                <div className="flex items-center gap-3">
                  <span className="rounded-full bg-[var(--pos-surface)] p-2 text-[var(--pos-ok)]">
                    <UserRound className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {customerWasCreated ? "New customer" : customer.name}
                    </span>
                    <span className="block truncate text-xs text-[var(--pos-ink-2)]">
                      +91 {customer.phone}
                      {customer.email ? ` · ${customer.email}` : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onCustomer?.(null);
                      setMobile("");
                      setCustomerWasCreated(false);
                      setScreen("customer");
                      setError(null);
                    }}
                    className="rounded-lg px-2 py-1 text-xs font-medium text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface)] disabled:opacity-40"
                  >
                    Change
                  </button>
                </div>
              </div>
            )}

            {onResolveCustomer &&
              ((gstEnabled && onGstin) ||
                (onReceiptEmail && (!customer || !customer.email))) && (
                <div className="mb-4">
                  <button
                    type="button"
                    onClick={() => setDetailsOpen((open) => !open)}
                    className="w-full rounded-lg py-1.5 text-left text-xs font-medium text-[var(--pos-ink-2)] hover:text-[var(--pos-ink)]"
                    aria-expanded={detailsOpen}
                  >
                    {detailsOpen ? "Hide" : "Add"} receipt email or GSTIN
                  </button>
                  {detailsOpen && (
                    <div className="mt-2 space-y-3 rounded-xl border border-[var(--pos-border)] p-3">
                      {onReceiptEmail && (!customer || !customer.email) && (
                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-[var(--pos-ink-2)]">
                            Receipt email (optional)
                          </span>
                          <input
                            value={receiptEmail ?? ""}
                            inputMode="email"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            placeholder="name@example.com"
                            onChange={(event) =>
                              onReceiptEmail(event.target.value.slice(0, 160))
                            }
                            className="w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2.5 text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
                          />
                          <span className="mt-1 block text-[11px] text-[var(--pos-ink-3)]">
                            Sends this receipt only; it does not change the
                            customer profile.
                          </span>
                        </label>
                      )}
                      {gstEnabled && onGstin && (
                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-[var(--pos-ink-2)]">
                            Customer GSTIN (optional)
                          </span>
                          <input
                            value={gstin ?? ""}
                            autoCapitalize="characters"
                            placeholder="22AAAAA0000A1Z5"
                            onChange={(event) =>
                              onGstin(
                                event.target.value.toUpperCase().slice(0, 15),
                              )
                            }
                            className="w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2.5 text-sm outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)]"
                          />
                        </label>
                      )}
                    </div>
                  )}
                </div>
              )}

            {taken.length > 0 && (
              <div className="mb-4 space-y-2" aria-label="Payments added">
                {taken.map((tender, index) => (
                  <div
                    key={`${tender.method}-${index}`}
                    className="flex items-center justify-between rounded-xl border border-[var(--pos-border)] px-3 py-2.5 text-sm"
                  >
                    <span>{labelFor(tender.method)}</span>
                    <span className="flex items-center gap-2 font-medium">
                      {money(tender.amount)}
                      {tender.method === "razorpay" ? (
                        <span className="text-[11px] font-normal text-[var(--pos-ok)]">
                          Verified
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => removeTender(index)}
                          disabled={busy}
                          className="rounded p-0.5 text-[var(--pos-ink-3)] hover:text-[var(--pos-ink)] disabled:opacity-40"
                          aria-label={`Remove ${labelFor(tender.method)} payment`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {screen === "methods" && !covered && (
              <>
                <p className="mb-2 text-sm font-semibold">
                  {split
                    ? `Choose how to collect ${money(remaining)}`
                    : "Choose a payment method"}
                </p>
                <div className="space-y-2">
                  {methods.map((option) => {
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => chooseMethod(option.id)}
                        className="flex w-full items-center gap-3 rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-3 text-left transition-colors hover:bg-[var(--pos-surface-2)]"
                      >
                        <span className="rounded-lg bg-[var(--pos-surface-2)] p-2 text-[var(--pos-ink-2)]">
                          <MethodIcon method={option.id} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold">
                            {option.label}
                          </span>
                          <span className="block text-xs text-[var(--pos-ink-2)]">
                            {option.hint}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {!split && taken.length === 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSplit(true);
                      setError(null);
                    }}
                    className="mt-3 w-full rounded-xl border border-[var(--pos-border)] py-2.5 text-sm font-semibold transition-colors hover:bg-[var(--pos-surface-2)]"
                  >
                    Split payment
                    <span className="mt-0.5 block text-xs font-normal text-[var(--pos-ink-3)]">
                      Use two or more payment methods
                    </span>
                  </button>
                )}

                {split && taken.length === 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSplit(false);
                      setError(null);
                    }}
                    className="mt-2 w-full rounded-lg py-2 text-xs font-medium text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-2)]"
                  >
                    Cancel split payment
                  </button>
                )}
              </>
            )}

            {screen === "amount" && !covered && (
              <>
                <div className="mb-3 flex items-center gap-3 rounded-xl border border-[var(--pos-border)] p-3">
                  <span className="rounded-lg bg-[var(--pos-surface-2)] p-2 text-[var(--pos-ink-2)]">
                    <MethodIcon method={method} />
                  </span>
                  <div>
                    <p className="text-sm font-semibold">{labelFor(method)}</p>
                    <p className="text-xs text-[var(--pos-ink-2)]">
                      {split
                        ? "Add this part of the payment"
                        : `Pay the full ${money(remaining)}`}
                    </p>
                  </div>
                </div>

                {(split || method === "cash") && method !== "store_credit" && (
                  <label className="mb-3 block">
                    <span className="mb-1 block text-xs font-medium text-[var(--pos-ink-2)]">
                      {method === "cash" ? "Cash received" : "Amount"}
                    </span>
                    <input
                      value={amount}
                      inputMode="decimal"
                      autoFocus
                      placeholder={`Up to ${money(remaining)}`}
                      onChange={(event) => {
                        setAmount(event.target.value.replace(/[^\d.]/g, ""));
                        setError(null);
                      }}
                      className="w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-3 text-lg font-semibold outline-none focus:border-[var(--pos-border-strong)]"
                    />
                  </label>
                )}

                {method === "cash" && (
                  <div className="mb-3 grid grid-cols-4 gap-1.5">
                    {quickCash(remaining).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          setAmount(String(value));
                          setError(null);
                        }}
                        className="rounded-lg bg-[var(--pos-surface-2)] py-2 text-sm font-medium hover:bg-[var(--pos-surface-3)]"
                      >
                        {money(value)}
                      </button>
                    ))}
                  </div>
                )}

                {method === "card" && (
                  <p className="mb-3 rounded-lg bg-[var(--pos-surface-2)] px-3 py-2 text-xs text-[var(--pos-ink-2)]">
                    Confirm the terminal approved the payment before recording
                    it.
                  </p>
                )}
                {method === "upi" && (
                  <p className="mb-3 rounded-lg bg-[var(--pos-surface-2)] px-3 py-2 text-xs text-[var(--pos-ink-2)]">
                    Confirm the payment appears in your UPI app before recording
                    it.
                  </p>
                )}
                {method === "razorpay" && (
                  <p className="mb-3 rounded-lg bg-[var(--pos-ok-soft)] px-3 py-2 text-xs text-[var(--pos-ink-2)]">
                    StoreMink opens Razorpay and verifies the payment before
                    continuing.
                  </p>
                )}
                {method === "store_credit" && (
                  <p className="mb-3 rounded-lg bg-[var(--pos-surface-2)] px-3 py-2 text-sm text-[var(--pos-ink-2)]">
                    Apply {money(activeValue)} from the customer&apos;s{" "}
                    {money(creditLeft)} balance.
                    {activeValue < remaining
                      ? ` ${money(remaining - activeValue)} will still be due.`
                      : ""}
                  </p>
                )}

                {cashChange > 0 && (
                  <p className="mb-3 rounded-lg bg-[var(--pos-ok-soft)] px-3 py-2 text-center text-sm font-semibold text-[var(--pos-ok)]">
                    Give {money(cashChange)} change
                  </p>
                )}

                {method !== "cash" &&
                  method !== "razorpay" &&
                  method !== "store_credit" && (
                    <input
                      value={reference}
                      placeholder="Reference code (optional)"
                      onChange={(event) =>
                        setReference(event.target.value.slice(0, 60))
                      }
                      className="mb-3 w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2.5 text-sm outline-none focus:border-[var(--pos-border-strong)]"
                    />
                  )}

                <button
                  type="button"
                  disabled={busy || !canRecord}
                  onClick={() =>
                    void recordCurrentPayment(
                      activeValue,
                      !split && activeValue >= remaining,
                    )
                  }
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--pos-accent)] py-3 font-semibold text-[var(--pos-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {activeValue <= 0
                    ? "Enter amount"
                    : split || activeValue < remaining
                      ? method === "razorpay"
                        ? `Charge ${money(activeValue)}`
                        : `Add ${money(activeValue)}`
                      : method === "razorpay"
                        ? `Charge ${money(activeValue)}`
                        : method === "store_credit"
                          ? `Apply ${money(activeValue)} & complete`
                          : confirmLabel}
                </button>
              </>
            )}

            {covered && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void finish()}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {confirmLabel}
              </button>
            )}

            {error && (
              <p role="alert" className="mt-3 text-sm text-[var(--pos-danger)]">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
