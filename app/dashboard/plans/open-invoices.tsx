"use client";

/**
 * "You owe this" — the manual payment surface (§34).
 *
 * ★★ WITHOUT THIS THE NEW SYSTEM CANNOT COLLECT A RENEWAL AT ALL. Automatic
 * collection is gated behind `RECURRING_CHARGE_VERIFIED` (lib/billing/gateway.ts),
 * so every renewal invoice the worker writes is settled here or not at all — a
 * merchant with no way to pay is downgraded 48 hours later for a bill they never
 * saw. It stays a first-class path after the recurring charge lands, for amounts
 * over the ₹15,000 AFA-exempt limit and for merchants with no live mandate.
 *
 * ★ It renders NOTHING when nothing is owed. A permanent "no outstanding
 * invoices" panel is a bill-shaped thing on a page a merchant reads for
 * reassurance.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  confirmPayInvoice,
  startPayInvoice,
} from "@/app/actions/subscribe-actions";
// ★ The TYPE comes from the pure module, never from the "use server" file —
// every export of one of those is registered as a server action, and a type
// re-export fails the BUILD while typecheck passes. See invoice-types.ts.
import type { PayableInvoice } from "@/lib/billing/invoice-types";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";

function money(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

function period(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  return `${fmt(from)} — ${fmt(to)}`;
}

export function OpenInvoices({
  invoices,
  canManage,
}: {
  invoices: PayableInvoice[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [paying, setPaying] = useState<string | null>(null);

  if (invoices.length === 0) return null;

  async function pay(invoiceId: string) {
    setPaying(invoiceId);
    const start = await startPayInvoice(invoiceId);
    if (!start.ok) {
      toast.error(start.error);
      setPaying(null);
      return;
    }
    const opened = await openRazorpayModal({
      keyId: start.keyId,
      rzpOrderId: start.providerOrderId,
      amountPaise: start.amountPaise,
      name: "StoreMink",
      description: start.invoiceRef
        ? `Invoice ${start.invoiceRef}`
        : "Subscription invoice",
      onSuccess: async (res) => {
        const done = await confirmPayInvoice(
          invoiceId,
          res.razorpay_payment_id,
          res.razorpay_signature,
        );
        setPaying(null);
        if (!done.ok) {
          // ★ Money may well have moved. Never report this as a failure — a
          // merchant told "payment failed" pays twice (§26's rule, same shape).
          toast.info(done.error);
        } else if (done.planRestored) {
          toast.success("Paid — your plan is active again.");
        } else {
          toast.success("Paid. Thank you!");
        }
        router.refresh();
      },
      onDismiss: () => {
        setPaying(null);
        toast.error("Payment wasn't completed.");
      },
    });
    if (!opened) {
      setPaying(null);
      toast.error("Couldn't open the payment window. Please try again.");
    }
  }

  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-6">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-amber-900">
            {invoices.length === 1
              ? "You have an invoice to pay"
              : `You have ${invoices.length} invoices to pay`}
          </h2>
          <p className="mt-0.5 text-sm text-amber-800">
            Pay to keep your plan running. If a subscription invoice stays
            unpaid past its due date your store moves to the Free plan.
          </p>

          <ul className="mt-4 space-y-2">
            {invoices.map((inv) => {
              const span = period(inv.periodStart, inv.periodEnd);
              // `processing` means a payment is already with the gateway.
              // Offering "Pay" would open a second one against the same money.
              const inFlight = inv.status === "processing";
              return (
                <li
                  key={inv.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#111827]">
                      {money(inv.totalPaise)}
                      {inv.invoiceRef ? (
                        <span className="ml-2 font-mono text-xs font-normal text-[#5b6472]">
                          {inv.invoiceRef}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-[#5b6472]">
                      {span ? `Service period ${span}` : "Subscription"}
                      {inv.dueAt
                        ? ` · due ${new Date(inv.dueAt).toLocaleDateString(
                            "en-GB",
                            { day: "2-digit", month: "short" },
                          )}`
                        : null}
                    </div>
                  </div>
                  {inFlight ? (
                    <span className="text-xs font-medium text-amber-700">
                      Payment in progress…
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => pay(inv.id)}
                      disabled={!canManage || paying !== null}
                      className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-50"
                      title={
                        canManage
                          ? undefined
                          : "Only an admin who can manage billing may pay this"
                      }
                    >
                      {paying === inv.id ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Opening…
                        </>
                      ) : (
                        "Pay now"
                      )}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
