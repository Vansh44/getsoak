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
    <div className="min-h-dvh bg-neutral-950 pb-32 text-white">
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <Link
          href="/pos/sales"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 hover:bg-white/20"
          aria-label="Back to sales"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Return</h1>
          <p className="font-mono text-xs text-white/50">{sale.receiptNo}</p>
        </div>
        <span className="ml-auto text-sm text-white/50">
          {money(sale.total)}
        </span>
      </header>

      <div className="space-y-3 px-4 py-4">
        {!anythingLeft && (
          <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-white/60">
            Everything on this sale has already been returned.
          </p>
        )}

        {sale.lines.map((l) => {
          const chosen = qty[l.id] ?? 0;
          const done = l.remaining === 0;
          return (
            <div
              key={l.id}
              className={`rounded-xl border border-white/10 bg-white/5 p-4 ${done ? "opacity-50" : ""}`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{l.name}</div>
                  {l.variantName && (
                    <div className="text-xs text-white/50">{l.variantName}</div>
                  )}
                  <div className="mt-0.5 text-xs text-white/50">
                    {l.quantity} sold
                    {l.returned > 0 ? ` · ${l.returned} returned` : ""}
                    {done ? "" : ` · ${l.remaining} can come back`}
                  </div>
                </div>
                <div className="shrink-0 text-sm text-white/70">
                  {money(l.unitPrice)}
                </div>
              </div>

              {!done && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 rounded-lg bg-white/10 p-1">
                    <button
                      type="button"
                      aria-label="One fewer"
                      onClick={() =>
                        setQty((q) => ({
                          ...q,
                          [l.id]: Math.max(0, (q[l.id] ?? 0) - 1),
                        }))
                      }
                      className="h-9 w-9 rounded-md text-lg hover:bg-white/10"
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
                      className="h-9 w-9 rounded-md text-lg hover:bg-white/10"
                    >
                      +
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setQty((q) => ({ ...q, [l.id]: l.remaining }))
                    }
                    className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium hover:bg-white/20"
                  >
                    All {l.remaining}
                  </button>

                  {chosen > 0 && (
                    <label className="ml-auto flex items-center gap-2 text-xs text-white/70">
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
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs font-medium tracking-wide text-white/50 uppercase">
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
                          ? "bg-white text-neutral-900"
                          : "bg-white/10 hover:bg-white/20"
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
                <p className="mt-2 rounded-lg bg-white/10 px-3 py-2.5 text-sm text-white/80">
                  {route.copy}
                </p>
              )}
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (optional)"
                className="mt-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm outline-none focus:border-white/30"
              />
            </div>

            <div className="fixed inset-x-0 bottom-0 border-t border-white/10 bg-neutral-950/95 p-4 backdrop-blur">
              <div className="mx-auto flex max-w-3xl items-center gap-4">
                <div className="min-w-0">
                  <div className="text-xs text-white/50">Refund</div>
                  <div className="text-2xl font-bold tabular-nums">
                    {money(preview.total)}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={nothingChosen || pending}
                  onClick={submit}
                  className="ml-auto inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3.5 font-semibold hover:bg-emerald-500 disabled:opacity-40"
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
    </div>
  );
}
