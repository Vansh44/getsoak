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
import { changeBilledLocations } from "@/app/actions/subscription-actions";
import type { LocationBillingState } from "@/app/actions/subscription-actions";

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

  const apply = (next: number) => {
    start(async () => {
      const res = await changeBilledLocations(next);
      setConfirming(null);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      // The message says WHEN it takes effect, which differs by direction —
      // buying charges now, releasing waits for the cycle end. That distinction
      // is the thing a merchant most needs to read, so it is the toast.
      toast.success(res.message ?? "Updated.");
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
              text={`Add a location for ₹${price}/${each}? You'll be charged the difference for the rest of this cycle.`}
              confirmLabel="Add location"
              pending={pending}
              onCancel={() => setConfirming(null)}
              onConfirm={() => apply(state.billed + 1)}
            />
          ) : confirming === "release" ? (
            <ConfirmRow
              text="Stop paying for one unused location? You keep it until the end of this billing cycle."
              confirmLabel="Release"
              pending={pending}
              onCancel={() => setConfirming(null)}
              onConfirm={() => apply(state.billed - 1)}
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
