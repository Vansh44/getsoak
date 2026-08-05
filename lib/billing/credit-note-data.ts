import "server-only";

// What a GST credit note says (roadmap Step 6, docs/returns-exchanges-plan.md §6.5).
//
// ── A credit note is not a receipt ─────────────────────────────────────────
// It is the document that REVERSES output tax the store has already declared.
// So it must name the invoice it reverses, carry its own serial, and split the
// refunded tax the same way it was charged — CGST+SGST for an intra-state
// sale, IGST for inter-state. Getting the split wrong doesn't just look wrong;
// it files the reversal against the wrong head.
//
// ── Everything comes from the ORDER's snapshot ─────────────────────────────
// Not from live settings. The tax rate on the invoice is the rate that was
// charged, possibly months ago, and a store that has since changed its rates
// must not reverse at the new one.

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  orderItems,
  orderRefunds,
  orderReturnItems,
  orderReturns,
  orders,
  storeBillingSettings,
} from "@/drizzle/schema";
import { getActingStoreId } from "@/app/dashboard/lib/access";
import { splitGst, type GstSplit } from "./gst";
import { rowToBillingSettings } from "./types";
import type { BillingSettings } from "./types";
import { logError } from "@/lib/observability/logger";

export interface CreditNoteLine {
  name: string;
  variantName: string | null;
  hsnCode: string | null;
  quantity: number;
  /** Goods value being credited, excluding tax. */
  amount: number;
  taxRate: number;
  taxAmount: number;
  gst: GstSplit;
}

export interface CreditNoteData {
  storeId: string;
  /** The note's own serial. Null means it has none — see `reason`. */
  creditNoteRef: string | null;
  creditNoteAt: string | null;
  /** The invoice this reverses. A credit note that doesn't name one is
   *  meaningless. */
  orderRef: string | null;
  orderDate: string | null;
  refundedAt: string | null;
  refundMethod: string;
  /** Why no serial, when there is none — shown instead of a blank document. */
  missingReason: string | null;
  billTo: Record<string, unknown> | null;
  placeOfSupplyState: string | null;
  supplierState: string | null;
  intraState: boolean;
  lines: CreditNoteLine[];
  /** Goods value credited, excluding tax. */
  subtotal: number;
  taxTotal: number;
  gst: GstSplit;
  /** What actually went back — may be LESS than subtotal + tax when the
   *  store deducted a restocking or postage fee. */
  refundTotal: number;
  feesWithheld: number;
  billing: BillingSettings;
}

/**
 * Build the credit note for one refund.
 *
 * Store-scoped by the acting store, so one merchant can't print another's.
 * Caller must already be gated on `orders`.
 */
export async function loadCreditNote(
  refundId: string,
): Promise<CreditNoteData | null> {
  if (!refundId) return null;
  const storeId = await getActingStoreId();

  try {
    return await withService(async (db) => {
      const refundRows = await db
        .select({
          id: orderRefunds.id,
          order_id: orderRefunds.orderId,
          return_id: orderRefunds.returnId,
          amount: orderRefunds.amount,
          method: orderRefunds.method,
          status: orderRefunds.status,
          created_at: orderRefunds.createdAt,
          credit_note_ref: orderRefunds.creditNoteRef,
          credit_note_at: orderRefunds.creditNoteAt,
        })
        .from(orderRefunds)
        .where(
          and(eq(orderRefunds.id, refundId), eq(orderRefunds.storeId, storeId)),
        )
        .limit(1);
      const refund = refundRows[0];
      if (!refund) return null;

      const orderRows = await db
        .select({
          order_ref: orders.orderRef,
          created_at: orders.createdAt,
          billing_address: orders.billingAddress,
          shipping_address: orders.shippingAddress,
          tax: orders.tax,
          place_of_supply_state: orders.placeOfSupplyState,
          supplier_state: orders.supplierState,
        })
        .from(orders)
        .where(eq(orders.id, refund.order_id))
        .limit(1);
      const order = orderRows[0];
      if (!order) return null;

      const billingRows = await db
        .select()
        .from(storeBillingSettings)
        .where(eq(storeBillingSettings.storeId, storeId))
        .limit(1);
      const billing = rowToBillingSettings(
        (billingRows[0] as Record<string, unknown> | undefined) ?? null,
      );

      // Which lines came back. A refund tied to a RETURN credits exactly those
      // lines; a refund with no return (a cancellation) credits the whole
      // order, because that is what was reversed.
      const returnedLines = refund.return_id
        ? await db
            .select({
              order_item_id: orderReturnItems.orderItemId,
              quantity: orderReturnItems.quantity,
              amount: orderReturnItems.amount,
              tax: orderReturnItems.tax,
            })
            .from(orderReturnItems)
            .innerJoin(
              orderReturns,
              eq(orderReturns.id, orderReturnItems.returnId),
            )
            .where(eq(orderReturnItems.returnId, refund.return_id))
        : [];

      const items = await db
        .select({
          id: orderItems.id,
          name: orderItems.name,
          variant_name: orderItems.variantName,
          hsn_code: orderItems.hsnCode,
          quantity: orderItems.quantity,
          total: orderItems.total,
          tax_rate: orderItems.taxRate,
          tax_amount: orderItems.taxAmount,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, refund.order_id));

      // Intra vs inter-state decides CGST+SGST against IGST. Unknown data
      // defaults to INTRA, matching lib/billing/gst.ts — most sales are.
      const intraState =
        !order.place_of_supply_state ||
        !order.supplier_state ||
        order.place_of_supply_state === order.supplier_state;

      const byId = new Map(items.map((i) => [i.id, i]));
      const lines: CreditNoteLine[] = [];

      if (returnedLines.length > 0) {
        for (const r of returnedLines) {
          const item = byId.get(r.order_item_id);
          if (!item) continue;
          const taxAmount = Number(r.tax ?? 0);
          lines.push({
            name: item.name,
            variantName: item.variant_name,
            hsnCode: item.hsn_code,
            quantity: r.quantity,
            amount: Number(r.amount ?? 0),
            taxRate: Number(item.tax_rate ?? 0),
            taxAmount,
            gst: splitGst(taxAmount, intraState),
          });
        }
      } else {
        for (const item of items) {
          const taxAmount = Number(item.tax_amount ?? 0);
          lines.push({
            name: item.name,
            variantName: item.variant_name,
            hsnCode: item.hsn_code,
            quantity: item.quantity,
            amount: Number(item.total ?? 0),
            taxRate: Number(item.tax_rate ?? 0),
            taxAmount,
            gst: splitGst(taxAmount, intraState),
          });
        }
      }

      const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
      const taxTotal = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
      const refundTotal = Number(refund.amount ?? 0);

      return {
        storeId,
        creditNoteRef: refund.credit_note_ref,
        creditNoteAt: refund.credit_note_at,
        orderRef: order.order_ref,
        orderDate: order.created_at,
        refundedAt: refund.created_at,
        refundMethod: refund.method,
        missingReason: missingReasonFor(refund.status, Number(order.tax ?? 0)),
        billTo: (order.billing_address ?? order.shipping_address) as Record<
          string,
          unknown
        > | null,
        placeOfSupplyState: order.place_of_supply_state,
        supplierState: order.supplier_state,
        intraState,
        lines,
        subtotal,
        taxTotal,
        gst: splitGst(taxTotal, intraState),
        refundTotal,
        // What the store kept: a restocking fee or return postage. Shown
        // because the customer's refund not matching the credited value is
        // otherwise an unexplained discrepancy on a legal document.
        feesWithheld: round2(Math.max(0, subtotal + taxTotal - refundTotal)),
        billing,
      };
    });
  } catch (err) {
    logError("credit-note: load", err, { refundId });
    return null;
  }
}

/**
 * Why this refund has no credit note serial.
 *
 * Both cases are correct behaviour, not failures — so the page explains rather
 * than 404s. A blank document with no number would look like a bug and get
 * printed anyway.
 */
function missingReasonFor(status: string, orderTax: number): string | null {
  if (status !== "completed") {
    return "This refund hasn't settled yet. A credit note is raised once the money has actually gone back — a serial issued for a refund that then fails would leave a gap in the series.";
  }
  if (orderTax <= 0) {
    return "No tax was charged on this order, so there is no output tax to reverse and no credit note is needed.";
  }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
