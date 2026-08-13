"use client";

// Buying and releasing metered extra locations (roadmap Step 5).
//
// The whole card is a statement of ONE number — how many shops this store may
// have — and the two ways to move it. It replaces the "coming soon" line that
// used to sit under the header, which was the only thing standing between a
// merchant and a third location they wanted to pay for.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Loader2, MinusCircle, PlusCircle } from "lucide-react";
import {
  confirmBuyLocations,
  releaseExtraLocations,
  startBuyLocations,
} from "@/app/actions/subscribe-actions";
// ★ The TYPE comes from the pure module — a type re-export from a "use server"
// file fails the build (see lib/billing/invoice-types.ts).
import type { LocationBillingState } from "@/lib/billing/invoice-types";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";

export function LocationBillingCard({
  state,
  canManage,
}: {
  state: LocationBillingState;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState<null | "buy" | "release">(null);

  const each = state.period === "yearly" ? "year" : "month";
  const price = state.pricePerPeriodInr.toLocaleString("en-IN");

  // ★ BUYING TAKES A PAYMENT; RELEASING DOES NOT. Two different flows, because
  // they are two different acts — the part period is charged on session, while a
  // release only books a change for the end of the cycle already paid for.
  const buy = (next: number) => {
    start(async () => {
      const startRes = await startBuyLocations(next);
      if (!startRes.ok) {
        setConfirming(null);
        // Not an error when the part period rounded to nothing — the location was
        // granted and it says so.
        toast.info(startRes.error);
        router.refresh();
        return;
      }
      const opened = await openRazorpayModal({
        keyId: startRes.keyId,
        rzpOrderId: startRes.providerOrderId,
        amountPaise: startRes.amountPaise,
        name: "StoreMink",
        description: `Extra location · part period`,
        onSuccess: async (res) => {
          const done = await confirmBuyLocations(
            startRes.invoiceId,
            res.razorpay_payment_id,
            res.razorpay_signature,
          );
          setConfirming(null);
          if (!done.ok) {
            // ★ Money may have moved. Never "failed" — the server's wording says
            // not to pay again (§26's rule).
            toast.info(done.error);
          } else {
            toast.success("Location added.");
          }
          router.refresh();
        },
        onDismiss: () => {
          setConfirming(null);
          toast.error("Payment wasn't completed.");
        },
      });
      if (!opened) {
        setConfirming(null);
        toast.error("Couldn't open the payment window. Please try again.");
      }
    });
  };

  const release = (next: number) => {
    start(async () => {
      const res = await releaseExtraLocations(next);
      setConfirming(null);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // The message says WHEN it takes effect, which is what a merchant most
      // needs to read.
      toast.success(res.message);
      router.refresh();
    });
  };

  return (
    <div className="mt-4 max-w-3xl rounded-xl border border-[#e5e5e5] bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Building2
            className="mt-0.5 h-4 w-4 shrink-0 text-[#9aa1ab]"
            strokeWidth={2}
          />
          <div>
            <p className="text-sm font-medium text-[#111827]">
              {state.existing} of {state.allowance} location
              {state.allowance === 1 ? "" : "s"} used
            </p>
            <p className="mt-0.5 text-xs text-[#6b7280]">
              {state.included} included with your plan
              {state.billed > 0 && (
                <>
                  {" · "}
                  {state.billed} extra at ₹{price}/{each} each
                </>
              )}
            </p>
            {/* A booked release, so the merchant is not left wondering whether
                it registered. */}
            {state.scheduled !== null && (
              <p className="mt-1 text-xs text-[#b45309]">
                Dropping to {state.scheduled} extra at the end of this cycle.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Why the controls are absent, when they are. A disabled button with no
          explanation is the thing merchants open a support ticket about. */}
      {!state.canBuy && (
        <p className="mt-3 rounded-lg bg-[#f9fafb] px-3 py-2 text-xs text-[#6b7280]">
          {state.blockedReason}
        </p>
      )}

      {canManage && state.canBuy && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {confirming === "buy" ? (
            <ConfirmRow
              text={
                state.nextPurchaseInr > 0
                  ? `Add a location for ₹${price}/${each}. You'll pay ₹${state.nextPurchaseInr.toLocaleString("en-IN")} now for the rest of this cycle, then ₹${price}/${each} from your next renewal.`
                  : `Add a location for ₹${price}/${each}, billed from your next renewal.`
              }
              confirmLabel={
                state.nextPurchaseInr > 0
                  ? `Pay ₹${state.nextPurchaseInr.toLocaleString("en-IN")}`
                  : "Add location"
              }
              pending={pending}
              onCancel={() => setConfirming(null)}
              onConfirm={() => buy(state.billed + 1)}
            />
          ) : confirming === "release" ? (
            <ConfirmRow
              text="Stop paying for one unused location? You keep it until the end of this billing cycle."
              confirmLabel="Release"
              pending={pending}
              onCancel={() => setConfirming(null)}
              onConfirm={() => release(state.billed - 1)}
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirming("buy")}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm font-medium text-[#111827] transition-colors hover:bg-[#111827]/[0.03] disabled:opacity-50"
              >
                <PlusCircle className="h-4 w-4" strokeWidth={2} />
                Add a location · ₹{price}/{each}
              </button>

              {/* Only when something is actually unused. Offering "release" to
                  someone using every shop they pay for is offering an action
                  that can only be refused. */}
              {state.releasable > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirming("release")}
                  disabled={pending}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[#6b7280] transition-colors hover:bg-[#111827]/[0.03] disabled:opacity-50"
                >
                  <MinusCircle className="h-4 w-4" strokeWidth={2} />
                  Release {state.releasable} unused
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmRow({
  text,
  confirmLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  text: string;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="w-full">
      {/* The price and the timing are stated HERE, at the point of no return,
          not only on the button that opened this. */}
      <p className="text-xs text-[#6b7280]">{text}</p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-lg px-3 py-2 text-sm font-medium text-[#6b7280] transition-colors hover:bg-[#111827]/[0.03] disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
