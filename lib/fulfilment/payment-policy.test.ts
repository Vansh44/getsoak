import { describe, expect, it } from "vitest";
import {
  canRequirePrepaid,
  defaultPaymentMethod,
  isPaymentMethodAllowed,
  normalizePickupPayment,
  paymentOptionsFor,
  type PaymentOptionsInput,
} from "./payment-policy";

const delivery = (
  over: Partial<PaymentOptionsInput> = {},
): PaymentOptionsInput => ({
  fulfilment: "delivery",
  onlineAvailable: true,
  policy: "customer_choice",
  ...over,
});
const pickup = (
  over: Partial<PaymentOptionsInput> = {},
): PaymentOptionsInput => ({
  fulfilment: "pickup",
  onlineAvailable: true,
  policy: "customer_choice",
  ...over,
});

describe("normalizePickupPayment", () => {
  it("reads the three policies", () => {
    expect(normalizePickupPayment("prepaid")).toBe("prepaid");
    expect(normalizePickupPayment("at_store")).toBe("at_store");
    expect(normalizePickupPayment("customer_choice")).toBe("customer_choice");
  });

  // ★ Fails OPEN. A stricter policy nobody chose would stop a store selling on
  // a typo or a retired option id.
  it("resolves anything unknown to today's behaviour", () => {
    for (const v of [undefined, null, "", "PREPAID", 3, {}]) {
      expect(normalizePickupPayment(v)).toBe("customer_choice");
    }
  });
});

describe("paymentOptionsFor", () => {
  // ★ A merchant requiring prepayment for COLLECTIONS has said nothing about
  // their courier orders. Switching COD off for those would be a policy they
  // never set.
  it("★ never lets the pickup policy touch delivery", () => {
    for (const policy of ["customer_choice", "prepaid", "at_store"] as const) {
      expect(paymentOptionsFor(delivery({ policy }))).toEqual({
        online: true,
        offline: true,
      });
    }
  });

  it("offers both on a pickup under customer_choice", () => {
    expect(paymentOptionsFor(pickup())).toEqual({
      online: true,
      offline: true,
    });
  });

  it("prepaid drops the counter option", () => {
    expect(paymentOptionsFor(pickup({ policy: "prepaid" }))).toEqual({
      online: true,
      offline: false,
    });
  });

  it("at_store drops the online option", () => {
    expect(paymentOptionsFor(pickup({ policy: "at_store" }))).toEqual({
      online: false,
      offline: true,
    });
  });

  // ★ NO SILENT FALLBACK. Serving pay-at-store to a store that requires
  // prepayment is the opposite of the merchant's policy; offering nothing is
  // the honest answer, and canRequirePrepaid stops the state arising at all.
  it("★ prepaid with no gateway offers nothing rather than the opposite", () => {
    expect(
      paymentOptionsFor(pickup({ policy: "prepaid", onlineAvailable: false })),
    ).toEqual({ online: false, offline: false });
  });

  it("a store with no gateway still takes COD and pay-at-store", () => {
    expect(paymentOptionsFor(delivery({ onlineAvailable: false }))).toEqual({
      online: false,
      offline: true,
    });
    expect(paymentOptionsFor(pickup({ onlineAvailable: false }))).toEqual({
      online: false,
      offline: true,
    });
  });
});

// ★ PINS AN ASSUMPTION placeOrder DEPENDS ON. It reuses its own gateway lookup
// and passes `onlineAvailable: false` for any non-razorpay method, which is only
// correct while `offline` is independent of `onlineAvailable`. A future policy
// that coupled them would silently start refusing COD orders at checkout, so the
// property is asserted here rather than left as a comment.
describe("★ offline availability never depends on the gateway", () => {
  it("holds for every fulfilment mode and policy", () => {
    for (const fulfilment of ["delivery", "pickup"] as const) {
      for (const policy of [
        "customer_choice",
        "prepaid",
        "at_store",
      ] as const) {
        const withGateway = paymentOptionsFor({
          fulfilment,
          policy,
          onlineAvailable: true,
        });
        const without = paymentOptionsFor({
          fulfilment,
          policy,
          onlineAvailable: false,
        });
        expect(without.offline).toBe(withGateway.offline);
      }
    }
  });
});

describe("isPaymentMethodAllowed", () => {
  it("allows what the options say", () => {
    expect(isPaymentMethodAllowed("razorpay", pickup())).toBe(true);
    expect(isPaymentMethodAllowed("pay_at_store", pickup())).toBe(true);
    expect(isPaymentMethodAllowed("cod", delivery())).toBe(true);
  });

  it("refuses what the policy removed", () => {
    expect(
      isPaymentMethodAllowed("pay_at_store", pickup({ policy: "prepaid" })),
    ).toBe(false);
    expect(
      isPaymentMethodAllowed("razorpay", pickup({ policy: "at_store" })),
    ).toBe(false);
  });

  // The pairing rule, kept here so the picker and the server cannot disagree
  // about it — placeOrder checks it too, deliberately.
  it("★ keeps cod and pay_at_store on their own fulfilment mode", () => {
    expect(isPaymentMethodAllowed("pay_at_store", delivery())).toBe(false);
    expect(isPaymentMethodAllowed("cod", pickup())).toBe(false);
  });

  it("refuses online when no gateway is connected", () => {
    expect(
      isPaymentMethodAllowed("razorpay", delivery({ onlineAvailable: false })),
    ).toBe(false);
  });
});

describe("defaultPaymentMethod", () => {
  // ★ THE BUG THIS STEP EXISTS FOR. checkout hardcoded "cod", so every merchant
  // who connected a gateway watched shoppers land on Cash on Delivery.
  it("★ pre-selects online when a gateway is connected", () => {
    expect(defaultPaymentMethod(delivery())).toBe("razorpay");
    expect(defaultPaymentMethod(pickup())).toBe("razorpay");
  });

  it("falls to the right offline method per fulfilment mode", () => {
    expect(defaultPaymentMethod(delivery({ onlineAvailable: false }))).toBe(
      "cod",
    );
    expect(defaultPaymentMethod(pickup({ onlineAvailable: false }))).toBe(
      "pay_at_store",
    );
  });

  it("honours at_store even with a gateway connected", () => {
    expect(defaultPaymentMethod(pickup({ policy: "at_store" }))).toBe(
      "pay_at_store",
    );
  });

  // The caller must render this as an explanation, not an empty section.
  it("returns null when nothing can be offered", () => {
    expect(
      defaultPaymentMethod(
        pickup({ policy: "prepaid", onlineAvailable: false }),
      ),
    ).toBeNull();
  });
});

describe("canRequirePrepaid", () => {
  // ★ Refused where the setting is SAVED, so the unorderable state never
  // exists — rather than being discovered by a shopper at checkout.
  it("needs a connected gateway", () => {
    expect(canRequirePrepaid(true)).toBe(true);
    expect(canRequirePrepaid(false)).toBe(false);
  });
});
