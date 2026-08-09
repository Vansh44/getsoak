"use client";

// Deciding on customer cancellation requests (roadmap Step 2).
//
// ★ ONE DECISION PER ORDER, never per line. There is no item-level approve or
// decline here and none is planned — this system has no partial fulfilment, so
// an order is cancelled or it is not.
//
// ★ APPROVING ASKS WHERE THE MONEY GOES. Cancelling and refunding are the same
// moment for a merchant, but they are not the same act, so the destination is
// chosen explicitly rather than assumed — and only the destinations this
// particular order can actually honour are offered (refundDestinationsFor).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { CircleSlash, Loader2 } from "lucide-react";
import {
  cancelOrder,
  declineCancellation,
  type CancellationRequest,
} from "@/app/actions/order-actions";
import {
  CANCEL_REASONS,
  type RefundDestination,
} from "@/lib/orders/cancellation";

const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;

const DESTINATION_LABEL: Record<RefundDestination, string> = {
  original: "Original payment method",
  store_credit: "Store credit",
  later: "Refund later",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  // Asia/Kolkata pinned: this renders on the server, where the zone is UTC on
  // Cloud Run, and a request timestamped three hours early is unreadable
  // (CODEBASE §24).
  return new Date(iso).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
}

export function CancellationQueueView({
  requests,
  error,
  canManage,
}: {
  requests: CancellationRequest[];
  error?: string;
  canManage: boolean;
}) {
  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <h1>Cancellation requests</h1>
        <p>
          Customers who have asked to cancel. Approving cancels the whole order;
          declining leaves it active and tells them why.
        </p>
      </header>

      {error && (
        <div className="dash-card mt-4">
          <div className="dash-card-body text-sm text-[#b3261e]">{error}</div>
        </div>
      )}

      {!error && requests.length === 0 && (
        <div className="dash-card mt-4">
          <div className="dash-card-body flex items-center gap-3 py-8 text-sm text-[#6b7280]">
            <CircleSlash className="h-4 w-4" strokeWidth={2} />
            No cancellation requests waiting.
          </div>
        </div>
      )}

      <div className="mt-4 max-w-3xl space-y-3">
        {requests.map((r) => (
          <RequestCard key={r.orderId} request={r} canManage={canManage} />
        ))}
      </div>
    </div>
  );
}

function RequestCard({
  request,
  canManage,
}: {
  request: CancellationRequest;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<null | "approve" | "decline">(null);

  // Only what this order can honour. Offering a gateway refund on a COD order
  // is a control that fails after the order is already cancelled.
  const destinations = request.refundDestinations;
  const [destination, setDestination] = useState<RefundDestination>(
    destinations[0] ?? "later",
  );
  const [reasonCode, setReasonCode] = useState<string>("customer_changed_mind");
  const [restock, setRestock] = useState(true);
  const [notify, setNotify] = useState(true);
  const [staffNote, setStaffNote] = useState("");
  const [declineReason, setDeclineReason] = useState("");

  const approve = () =>
    start(async () => {
      const res = await cancelOrder(request.orderId, {
        refundDestination: destination,
        reasonCode,
        restock,
        notify,
        staffNote,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      // ★ THE ORDER IS CANCELLED EITHER WAY, so these are told apart rather
      // than collapsed into one message. Saying "refunded" when the money did
      // not move is the failure this distinction exists to prevent — and
      // "in flight" must NOT invite a retry (CODEBASE §26).
      if (res.refundError) {
        toast.error(
          `Order cancelled, but the refund failed: ${res.refundError}`,
        );
      } else if (res.refundPending) {
        toast.success(
          "Order cancelled. The refund is in flight — we're checking with the gateway, so don't send it again.",
        );
      } else {
        toast.success("Order cancelled.");
      }
      router.refresh();
    });

  const decline = () =>
    start(async () => {
      const res = await declineCancellation(request.orderId, declineReason);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Request declined — the customer has been told.");
      router.refresh();
    });

  return (
    <div className="rounded-xl border border-[#e5e5e5] bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={`/dashboard/orders?q=${encodeURIComponent(request.orderRef ?? "")}`}
            className="text-sm font-semibold text-[#111827] underline-offset-2 hover:underline"
          >
            {request.orderRef ?? request.orderId}
          </Link>
          <p className="mt-0.5 text-xs text-[#6b7280]">
            {request.customerName ?? "Customer"}
            {request.customerEmail ? ` · ${request.customerEmail}` : ""} ·{" "}
            {when(request.requestedAt)}
          </p>
        </div>
        <div className="text-sm font-semibold text-[#111827]">
          {money(request.total)}
        </div>
      </div>

      {/* The customer's own words. Shown because it is usually the whole basis
          for the decision. */}
      {request.reason && (
        <p className="mt-3 rounded-lg bg-[#f9fafb] px-3 py-2 text-[13px] text-[#374151]">
          “{request.reason}”
        </p>
      )}

      {canManage && mode === null && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setMode("approve")}
            className="rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Approve &amp; cancel
          </button>
          <button
            type="button"
            onClick={() => setMode("decline")}
            className="rounded-lg border border-[#e5e5e5] px-3.5 py-2 text-sm font-medium text-[#111827] hover:bg-[#111827]/[0.03]"
          >
            Decline
          </button>
        </div>
      )}

      {mode === "approve" && (
        <div className="mt-3 space-y-3 border-t border-[#f0f0f0] pt-3">
          <Field label="Refund to">
            <select
              className="dash-input w-full"
              value={destination}
              onChange={(e) =>
                setDestination(e.target.value as RefundDestination)
              }
            >
              {destinations.map((d) => (
                <option key={d} value={d}>
                  {DESTINATION_LABEL[d]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Reason">
            <select
              className="dash-input w-full"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
            >
              {CANCEL_REASONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>

          <Checkbox checked={restock} onChange={setRestock}>
            Restock inventory
          </Checkbox>
          <Checkbox checked={notify} onChange={setNotify}>
            Notify customer
          </Checkbox>

          <Field label="Staff note (internal)">
            <textarea
              className="dash-input w-full"
              rows={2}
              maxLength={500}
              value={staffNote}
              onChange={(e) => setStaffNote(e.target.value)}
              placeholder="Only your team sees this."
            />
          </Field>

          <Actions
            pending={pending}
            confirmLabel="Cancel the order"
            onConfirm={approve}
            onCancel={() => setMode(null)}
          />
        </div>
      )}

      {mode === "decline" && (
        <div className="mt-3 space-y-3 border-t border-[#f0f0f0] pt-3">
          <Field label="Why are you declining?">
            <textarea
              className="dash-input w-full"
              rows={2}
              maxLength={300}
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              placeholder="The customer reads this exactly as written."
            />
          </Field>
          {/* Required, and the server refuses without it — a silent no is the
              most complained-about thing a request flow does. */}
          <Actions
            pending={pending}
            confirmLabel="Decline request"
            onConfirm={decline}
            onCancel={() => setMode(null)}
            disabled={!declineReason.trim()}
          />
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[#6b7280]">
        {label}
      </span>
      {children}
    </label>
  );
}

function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-[#111827]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4"
      />
      {children}
    </label>
  );
}

function Actions({
  pending,
  confirmLabel,
  onConfirm,
  onCancel,
  disabled,
}: {
  pending: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onConfirm}
        disabled={pending || disabled}
        className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        className="rounded-lg px-3 py-2 text-sm font-medium text-[#6b7280] hover:bg-[#111827]/[0.03] disabled:opacity-50"
      >
        Back
      </button>
    </div>
  );
}
