import { describe, it, expect } from "vitest";
import { refundCopy } from "./refund-copy";

describe("refundCopy", () => {
  it("promises the original payment method ONLY for a gateway refund", () => {
    expect(refundCopy("razorpay").destination).toMatch(/original payment/i);
    for (const m of ["manual", "cash", "store_credit", "card", "upi"]) {
      expect(refundCopy(m).destination, m).not.toMatch(/original payment/i);
    }
  });

  it("never claims money moved for a store-credit refund", () => {
    const c = refundCopy("store_credit");
    expect(c.destination).toMatch(/store credit/i);
    expect(c.bankDelay).toBe(false);
  });

  it("only mentions a bank wait where a bank is involved", () => {
    expect(refundCopy("razorpay").bankDelay).toBe(true);
    expect(refundCopy("card").bankDelay).toBe(true);
    expect(refundCopy("upi").bankDelay).toBe(true);
    // Cash clears at the counter; credit never leaves.
    expect(refundCopy("cash").bankDelay).toBe(false);
    expect(refundCopy("store_credit").bankDelay).toBe(false);
    expect(refundCopy("manual").bankDelay).toBe(false);
  });

  it("falls back to copy that is true of every method", () => {
    for (const bad of [undefined, null, "", "  ", 42, {}, "cheque"]) {
      const c = refundCopy(bad);
      expect(c.destination, String(bad)).toBe("on its way back to you");
      expect(c.bankDelay, String(bad)).toBe(false);
    }
  });

  it("is case and whitespace tolerant", () => {
    expect(refundCopy(" Razorpay ").destination).toBe(
      refundCopy("razorpay").destination,
    );
    expect(refundCopy("STORE_CREDIT").bankDelay).toBe(false);
  });
});
