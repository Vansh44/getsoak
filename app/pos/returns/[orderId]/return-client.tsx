"use client";

// Taking goods back. The cashier says WHAT comes back and in what condition;
// the server decides what that is worth — this screen's total is a preview
// computed with the same pure function, never the figure that gets refunded.

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  processReturn,
  type RefundMethod,
  type ReturnableSale,
} from "@/app/actions/pos-return-actions";
import { refundBreakdown } from "@/lib/pos/returns";
import { CustomerPhoneVerification } from "../../customer-phone-verification";

const money = (n: number) =>
  `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const METHODS: { id: RefundMethod; label: string }[] = [
  { id: "cash", label: "Cash" },
  { id: "card", label: "Card" },
  { id: "upi", label: "UPI" },
];

export function ReturnClient({ sale }: { sale: ReturnableSale }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [damaged, setDamaged] = useState<Record<string, boolean>>({});
  // ★ The route comes from the SERVER, computed from the tender that paid.
  // A card sale offers no cash button at all — a control that always fails
  // server-side, in front of a customer, is worse than no control.
  const route = sale.refundRoute;
  const [method, setMethod] = useState<RefundMethod>(route.method);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [verificationOpen, setVerificationOpen] = useState(false);

  const preview = useMemo(
    () =>
      refundBreakdown({
        lines: sale.lines.map((l) => ({
          id: l.id,
          quantity: l.quantity,
          lineTotal: l.lineTotal,
          taxAmount: l.taxAmount,
          alreadyReturned: l.returned,
        })),
        orderDiscount: sale.orderDiscount,
        request: Object.entries(qty).map(([id, q]) => ({ id, quantity: q })),
      }),
    [qty, sale],
  );

  const nothingChosen = preview.total <= 0;
  const anythingLeft = sale.lines.some((l) => l.remaining > 0);

  const submit = () =>
    start(async () => {
      const res = await processReturn(
        sale.orderId,
        Object.entries(qty)
          .filter(([, q]) => q > 0)
          .map(([orderItemId, quantity]) => ({
            orderItemId,
            quantity,
            condition: damaged[orderItemId]
              ? ("damaged" as const)
              : ("sellable" as const),
          })),
        method,
        reason,
      );
      if (res.verificationRequired) {
        setVerificationOpen(true);
        return;
      }
      if (res.error) {
        toast.error(res.error);
        return;
      }
      // A gateway refund that failed or hasn't confirmed still means the goods
      // came back — so it is a WARNING, not an error, and the return stands.
      if (res.note) {
        toast.warning(res.note, { duration: 8000 });
      } else {
        toast.success(
          route.counterChoice
            ? `Refunded ${money(res.refunded ?? 0)}`
            : `${money(res.refunded ?? 0)} on its way back to their card`,
        );
      }
      router.push("/pos/sales");
    });

  return (
    // ★ THE ONE SCREEN THAT KEEPS A BACK ARROW. Everywhere else it was a
    // redundant second exit next to the rail — but this is a STEP IN A FLOW, not
    // a destination: you arrived from a specific order and the way out is back
    // to the counter, not sideways to another part of the till. It has no rail
    // entry of its own for the same reason (Returns stays lit — see
    // activePosNavKey).
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--pos-border)] px-4">
        <Link
          href="/pos/returns"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--pos-surface-2)] hover:bg-[var(--pos-surface-3)]"
          aria-label="Back to returns"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Return</h1>
          <p className="truncate font-mono text-xs text-[var(--pos-ink-2)]">
            {sale.receiptNo}
          </p>
        </div>
        <span className="ml-auto shrink-0 text-sm text-[var(--pos-ink-2)]">
          {money(sale.total)}
        </span>
      </header>

      <div className="mx-auto w-full max-w-3xl min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {!anythingLeft && (
          <p className="rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 py-6 text-center text-sm text-[var(--pos-ink-2)]">
            Everything on this sale has already been returned.
          </p>
        )}

        {sale.lines.map((l) => {
          const chosen = qty[l.id] ?? 0;
          const done = l.remaining === 0;
          return (
            <div
              key={l.id}
              className={`rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-4 ${done ? "opacity-50" : ""}`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{l.name}</div>
                  {l.variantName && (
                    <div className="text-xs text-[var(--pos-ink-2)]">
                      {l.variantName}
                    </div>
                  )}
                  <div className="mt-0.5 text-xs text-[var(--pos-ink-2)]">
                    {l.quantity} sold
                    {l.returned > 0 ? ` · ${l.returned} returned` : ""}
                    {done ? "" : ` · ${l.remaining} can come back`}
                  </div>
                </div>
                <div className="shrink-0 text-sm text-[var(--pos-ink-2)]">
                  {money(l.unitPrice)}
                </div>
              </div>

              {!done && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 rounded-lg bg-[var(--pos-surface-2)] p-1">
                    <button
                      type="button"
                      aria-label="One fewer"
                      onClick={() =>
                        setQty((q) => ({
                          ...q,
                          [l.id]: Math.max(0, (q[l.id] ?? 0) - 1),
                        }))
                      }
                      className="h-9 w-9 rounded-md text-lg hover:bg-[var(--pos-surface-2)]"
                    >
                      −
                    </button>
                    <span className="w-8 text-center font-semibold tabular-nums">
                      {chosen}
                    </span>
                    <button
                      type="button"
                      aria-label="One more"
                      onClick={() =>
                        setQty((q) => ({
                          ...q,
                          [l.id]: Math.min(l.remaining, (q[l.id] ?? 0) + 1),
                        }))
                      }
                      className="h-9 w-9 rounded-md text-lg hover:bg-[var(--pos-surface-2)]"
                    >
                      +
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setQty((q) => ({ ...q, [l.id]: l.remaining }))
                    }
                    className="rounded-lg bg-[var(--pos-surface-2)] px-3 py-2 text-xs font-medium hover:bg-[var(--pos-surface-3)]"
                  >
                    All {l.remaining}
                  </button>

                  {chosen > 0 && (
                    <label className="ml-auto flex items-center gap-2 text-xs text-[var(--pos-ink-2)]">
                      <input
                        type="checkbox"
                        checked={!!damaged[l.id]}
                        onChange={(e) =>
                          setDamaged((d) => ({
                            ...d,
                            [l.id]: e.target.checked,
                          }))
                        }
                        className="h-4 w-4 accent-amber-500"
                      />
                      Damaged — don&apos;t restock
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {anythingLeft && (
          <>
            <div className="rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-4">
              <div className="text-xs font-medium tracking-wide text-[var(--pos-ink-2)] uppercase">
                Money goes back as
              </div>
              {route.counterChoice ? (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {METHODS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMethod(m.id)}
                      className={`rounded-lg py-2.5 text-sm font-semibold ${
                        method === m.id
                          ? "bg-[var(--pos-accent)] text-neutral-900"
                          : "bg-[var(--pos-surface-2)] hover:bg-[var(--pos-surface-3)]"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              ) : (
                // No buttons. The tender decided this, and there is nothing
                // for the cashier to pick — so say what will happen instead,
                // in words they can read out to the customer.
                <p className="mt-2 rounded-lg bg-[var(--pos-surface-2)] px-3 py-2.5 text-sm text-[var(--pos-ink)]">
                  {route.copy}
                </p>
              )}
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (optional)"
                className="mt-3 w-full rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-3 py-2.5 text-sm outline-none focus:border-[var(--pos-border-strong)]"
              />
            </div>

            {/* STICKY, not FIXED. `fixed inset-x-0` is measured against the
                viewport, so with the rail on screen the bar ran underneath it;
                sticking it to the bottom of its own scroll container keeps it
                inside the content column, and drops the `pb-32` spacer that
                only existed to stop the fixed bar covering the last card. */}
            <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-[var(--pos-border)] bg-[var(--pos-bg)]/95 p-4 backdrop-blur">
              <div className="flex items-center gap-4">
                <div className="min-w-0">
                  <div className="text-xs text-[var(--pos-ink-2)]">Refund</div>
                  <div className="text-2xl font-bold tabular-nums">
                    {money(preview.total)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={nothingChosen || pending}
                  onClick={submit}
                  className="ml-auto inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3.5 font-semibold hover:bg-emerald-500 disabled:opacity-40 text-white"
                >
                  {pending ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-5 w-5" />
                  )}
                  Refund {money(preview.total)}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {verificationOpen && (
        <CustomerPhoneVerification
          orderId={sale.orderId}
          purpose="return"
          onCancel={() => setVerificationOpen(false)}
          onVerified={() => {
            setVerificationOpen(false);
            submit();
          }}
        />
      )}
    </div>
  );
}
