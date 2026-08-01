"use client";

// POS Phase 3 — the cash drawer: open with a counted float, bank cash during
// the day, close with a count and see the variance.
//
// Deliberately arithmetic-forward. The screen shows the whole equation rather
// than just the answer, because the number a merchant will question is the
// variance, and "expected 1,895" is only trustworthy if you can see what went
// into it.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Banknote,
  Loader2,
  Lock,
  TrendingDown,
  TrendingUp,
  Vault,
} from "lucide-react";
import {
  closeShift,
  openShift,
  recordCashMovement,
  type ShiftReport,
} from "@/app/actions/pos-shift-actions";
import type { CashMovementType } from "@/lib/pos/shifts";

// The sign goes BEFORE the symbol: "₹-45.00" reads like a currency called
// "₹-", and a variance is the one figure here people scan for a minus.
const money = (n: number) => {
  const abs = Math.abs(n).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? "−" : ""}₹${abs}`;
};

/** "upi" is an initialism; title-casing it to "Upi" looks like a typo. */
const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  upi: "UPI",
  gift_card: "Gift card",
  store_credit: "Store credit",
  razorpay: "Razorpay",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

const MOVEMENT_META: Record<
  CashMovementType,
  { label: string; icon: typeof Vault; hint: string }
> = {
  drop: { label: "Drop to safe", icon: Vault, hint: "Cash out of the drawer" },
  payout: {
    label: "Payout",
    icon: ArrowUpFromLine,
    hint: "Cash paid out (supplier, expense)",
  },
  paid_in: {
    label: "Paid in",
    icon: ArrowDownToLine,
    hint: "Cash added to the drawer",
  },
};

export function ShiftClient({
  initial,
  canManage,
  required,
  locationName,
}: {
  initial: ShiftReport | null;
  canManage: boolean;
  required: boolean;
  locationName: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [float, setFloat] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState(false);
  const [movement, setMovement] = useState<CashMovementType | null>(null);
  const [movementAmount, setMovementAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");

  const run = (fn: () => Promise<{ error?: string }>) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.error) {
        setError(res.error);
        return;
      }
      setFloat("");
      setCounted("");
      setNote("");
      setMovement(null);
      setMovementAmount("");
      setMovementReason("");
      setClosing(false);
      router.refresh();
    });
  };

  // ── No shift open ─────────────────────────────────────────────────────────
  if (!initial) {
    return (
      <Shell locationName={locationName}>
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
          <Banknote
            className="mx-auto h-8 w-8 text-white/40"
            strokeWidth={1.5}
          />
          <h2 className="mt-3 font-semibold">No shift open</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-white/50">
            {required
              ? "This store requires an open shift before selling."
              : "Open one to reconcile the drawer at the end of the day."}
          </p>

          {canManage ? (
            <div className="mx-auto mt-5 max-w-xs">
              <label className="block text-left">
                <span className="mb-1 block text-xs text-white/50">
                  Opening float (cash in the drawer now)
                </span>
                <input
                  value={float}
                  onChange={(e) =>
                    setFloat(e.target.value.replace(/[^\d.]/g, ""))
                  }
                  inputMode="decimal"
                  placeholder="0"
                  className="w-full rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-right text-lg outline-none focus:border-white/40"
                />
              </label>
              {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
              <button
                type="button"
                disabled={pending || float.trim() === ""}
                onClick={() => run(() => openShift(Number(float)))}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                Open shift
              </button>
            </div>
          ) : (
            <p className="mt-4 text-sm text-white/40">
              Ask a manager to open the drawer.
            </p>
          )}
        </div>
      </Shell>
    );
  }

  const s = initial;
  const closed = s.status === "closed";

  return (
    <Shell locationName={locationName}>
      <div className="space-y-3">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-semibold">
                {closed ? "Shift closed" : "Shift open"}
              </h2>
              <p className="text-sm text-white/50">
                Opened {when(s.openedAt)}
                {s.openedByName ? ` by ${s.openedByName}` : ""}
                {closed && s.closedAt ? ` · closed ${when(s.closedAt)}` : ""}
              </p>
            </div>
            <div className="text-right">
              <div className="text-xs text-white/50">
                {closed ? "Expected at close" : "Expected in drawer"}
              </div>
              <div className="text-2xl font-bold">{money(s.expectedCash)}</div>
            </div>
          </div>

          {/* The whole equation, not just the answer. */}
          <dl className="mt-4 space-y-1.5 text-sm">
            <Row label="Opening float" value={s.openingFloat} />
            <Row label="Cash sales" value={s.cashSales} sign="+" />
            {s.paidIn > 0 && <Row label="Paid in" value={s.paidIn} sign="+" />}
            {s.payouts > 0 && (
              <Row label="Payouts" value={s.payouts} sign="−" />
            )}
            {s.drops > 0 && (
              <Row label="Dropped to safe" value={s.drops} sign="−" />
            )}
            <div className="!mt-2 flex items-center justify-between border-t border-white/10 pt-2 font-semibold">
              <dt>Expected</dt>
              <dd>{money(s.expectedCash)}</dd>
            </div>
          </dl>

          {closed && s.countedCash !== null && (
            <div
              className={`mt-3 rounded-xl border p-3 ${
                s.varianceState === "balanced"
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-amber-500/30 bg-amber-500/10"
              }`}
            >
              <div className="flex items-center justify-between text-sm">
                <span className="text-white/70">Counted</span>
                <span className="font-semibold">{money(s.countedCash)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm text-white/70">
                  {s.varianceState === "short" ? (
                    <TrendingDown className="h-4 w-4" />
                  ) : s.varianceState === "over" ? (
                    <TrendingUp className="h-4 w-4" />
                  ) : null}
                  {s.varianceState === "balanced"
                    ? "Balanced"
                    : s.varianceState === "short"
                      ? "Short"
                      : "Over"}
                </span>
                <span className="text-lg font-bold">
                  {s.variance !== null && s.variance > 0 ? "+" : ""}
                  {money(s.variance ?? 0)}
                </span>
              </div>
              {s.note && <p className="mt-2 text-sm text-white/60">{s.note}</p>}
            </div>
          )}
        </div>

        {/* Takings — cash is only part of the day. */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <h3 className="mb-2 font-semibold">
            Takings
            <span className="ml-2 text-sm font-normal text-white/50">
              {s.saleCount} {s.saleCount === 1 ? "sale" : "sales"} ·{" "}
              {money(s.grossSales)}
            </span>
          </h3>
          {Object.keys(s.byMethod).length === 0 ? (
            <p className="text-sm text-white/40">No sales on this shift yet.</p>
          ) : (
            <dl className="space-y-1.5 text-sm">
              {Object.entries(s.byMethod).map(([method, amount]) => (
                <div key={method} className="flex justify-between">
                  <dt className="text-white/60">
                    {METHOD_LABEL[method] ?? method.replace(/_/g, " ")}
                  </dt>
                  <dd>{money(amount)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {/* Cash movements */}
        {(s.movements.length > 0 || (!closed && canManage)) && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <h3 className="mb-2 font-semibold">Cash movements</h3>
            {s.movements.length === 0 ? (
              <p className="text-sm text-white/40">Nothing banked yet.</p>
            ) : (
              <ul className="mb-3 space-y-1.5 text-sm">
                {s.movements.map((m) => (
                  <li key={m.id} className="flex justify-between gap-2">
                    <span className="min-w-0 text-white/60">
                      {MOVEMENT_META[m.type].label}
                      {m.reason ? ` · ${m.reason}` : ""}
                      {m.byName ? ` · ${m.byName}` : ""}
                    </span>
                    <span className="shrink-0">
                      {m.type === "paid_in" ? "+" : "−"}
                      {money(Math.abs(m.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {!closed && canManage && (
              <>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(MOVEMENT_META) as CashMovementType[]).map(
                    (t) => {
                      const Icon = MOVEMENT_META[t].icon;
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => {
                            setMovement(movement === t ? null : t);
                            setError(null);
                          }}
                          title={MOVEMENT_META[t].hint}
                          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                            movement === t
                              ? "bg-white text-[#0b0f14]"
                              : "bg-white/10 hover:bg-white/20"
                          }`}
                        >
                          <Icon className="h-4 w-4" strokeWidth={2} />
                          {MOVEMENT_META[t].label}
                        </button>
                      );
                    },
                  )}
                </div>

                {movement && (
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <label className="min-w-28 flex-1">
                      <span className="mb-1 block text-xs text-white/50">
                        Amount
                      </span>
                      <input
                        value={movementAmount}
                        autoFocus
                        onChange={(e) =>
                          setMovementAmount(
                            e.target.value.replace(/[^\d.]/g, ""),
                          )
                        }
                        inputMode="decimal"
                        placeholder="0"
                        className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-right outline-none focus:border-white/40"
                      />
                    </label>
                    <label className="min-w-40 flex-[2]">
                      <span className="mb-1 block text-xs text-white/50">
                        Reason (optional)
                      </span>
                      <input
                        value={movementReason}
                        onChange={(e) => setMovementReason(e.target.value)}
                        placeholder="e.g. banked at 4pm"
                        className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 outline-none focus:border-white/40"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={pending || movementAmount.trim() === ""}
                      onClick={() =>
                        run(() =>
                          recordCashMovement(
                            movement,
                            Number(movementAmount),
                            movementReason,
                          ),
                        )
                      }
                      className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
                    >
                      Record
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {error && (
          <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        {/* Close */}
        {!closed && canManage && (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            {!closing ? (
              <button
                type="button"
                onClick={() => setClosing(true)}
                className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-white/20"
              >
                <Lock className="h-4 w-4" strokeWidth={2} />
                Close shift
              </button>
            ) : (
              <>
                <h3 className="font-semibold">Count the drawer</h3>
                <p className="mb-3 text-sm text-white/50">
                  Enter what is physically there. The expected figure is hidden
                  until you have — a count you can see the answer to is not a
                  count.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-32 flex-1">
                    <span className="mb-1 block text-xs text-white/50">
                      Counted cash
                    </span>
                    <input
                      value={counted}
                      autoFocus
                      onChange={(e) =>
                        setCounted(e.target.value.replace(/[^\d.]/g, ""))
                      }
                      inputMode="decimal"
                      placeholder="0"
                      className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-right text-lg outline-none focus:border-white/40"
                    />
                  </label>
                  <label className="min-w-40 flex-[2]">
                    <span className="mb-1 block text-xs text-white/50">
                      Note (optional)
                    </span>
                    <input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. 50 short, till jam at 3pm"
                      className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 outline-none focus:border-white/40"
                    />
                  </label>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={pending || counted.trim() === ""}
                    onClick={() => run(() => closeShift(Number(counted), note))}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Close shift
                  </button>
                  <button
                    type="button"
                    onClick={() => setClosing(false)}
                    className="rounded-xl bg-white/10 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-white/20"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}

function Row({
  label,
  value,
  sign,
}: {
  label: string;
  value: number;
  sign?: "+" | "−";
}) {
  return (
    <div className="flex justify-between">
      <dt className="text-white/60">{label}</dt>
      <dd>
        {sign === "−" ? "−" : sign === "+" ? "+" : ""}
        {money(value)}
      </dd>
    </div>
  );
}

function Shell({
  locationName,
  children,
}: {
  locationName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      {/* The drawer is a detour from selling, so the way back has to be
          obvious — this screen had no exit at all on first build. */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Banknote className="h-5 w-5 shrink-0" strokeWidth={2} />
          <h1 className="truncate text-lg font-semibold">Cash drawer</h1>
          <span className="truncate text-sm text-white/50">
            · {locationName}
          </span>
        </div>
        <Link
          href="/pos/sell"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-white/20"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2} />
          Back to register
        </Link>
      </div>
      {children}
    </div>
  );
}
