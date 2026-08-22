import { describe, it, expect } from "vitest";
import { POS_MONEY_EVENTS, isPosMoneyEvent } from "./audit";

// The money/security split decides what the two dashboard feeds show. Getting
// it wrong buries device pairings under a busy shop's discounts, or hides a
// discount from the one page an owner opens to find it.

describe("the money/security split", () => {
  it("★ classifies exactly the four discretionary money events", () => {
    expect([...POS_MONEY_EVENTS].sort()).toEqual([
      "cash_movement",
      "price_override",
      "refund_issued",
      "sale_discount",
    ]);
  });

  it("★★ a gateway tender is NOT a money event", () => {
    // Deliberate. The cashier chose nothing, and it is fully reconstructible
    // from order_payments + orders.cashier_id. Auditing it would be noise in
    // the one feed that has to stay readable.
    expect(isPosMoneyEvent("gateway_tender")).toBe(false);
  });

  it("keeps auth and device events on the security side", () => {
    for (const e of [
      "device_authorized",
      "device_revoked",
      "device_clone_detected",
      "operator_login",
      "operator_login_failed",
      "credential_reset",
    ]) {
      expect(isPosMoneyEvent(e)).toBe(false);
    }
  });

  it("recognises every money event", () => {
    for (const e of POS_MONEY_EVENTS) expect(isPosMoneyEvent(e)).toBe(true);
  });

  it("does not recognise an unknown event", () => {
    expect(isPosMoneyEvent("bitcoin_paid")).toBe(false);
  });
});
