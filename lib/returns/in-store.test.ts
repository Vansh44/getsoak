import { describe, it, expect } from "vitest";
import { canTakeReturnHere, isTenderAllowed, refundRouteFor } from "./in-store";

describe("canTakeReturnHere", () => {
  it("★ a sale rung at THIS counter is always returnable here", () => {
    // Invariant 1. The till has taken its own returns since pos_12; making
    // that conditional on a setting introduced later would break every shop
    // doing it today, the moment they upgrade.
    expect(
      canTakeReturnHere({
        soldHere: true,
        storeAllows: false,
        locationAccepts: false,
      }).allowed,
    ).toBe(true);
  });

  it("accepts a foreign order when both gates are open", () => {
    expect(
      canTakeReturnHere({
        soldHere: false,
        storeAllows: true,
        locationAccepts: true,
      }).allowed,
    ).toBe(true);
  });

  it("refuses a foreign order when the store hasn't enabled in-store returns", () => {
    const v = canTakeReturnHere({
      soldHere: false,
      storeAllows: false,
      locationAccepts: true,
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain("only take back");
  });

  it("refuses when THIS location lacks the capability, and says where to fix it", () => {
    const v = canTakeReturnHere({
      soldHere: false,
      storeAllows: true,
      locationAccepts: false,
    });
    expect(v.allowed).toBe(false);
    expect(v.allowed === false && v.reason).toContain("Locations");
  });
});

describe("refundRouteFor", () => {
  it("★ an online order refunds to the GATEWAY, with no counter choice", () => {
    // Refunding cash for a card sale is the card-not-present laundering path:
    // buy online with a stolen card, return in store, walk out with clean cash.
    const r = refundRouteFor({
      paymentMethod: "razorpay",
      paymentStatus: "paid",
    });
    expect(r.method).toBe("razorpay");
    expect(r.counterChoice).toBe(false);
    expect(r.affectsDrawer).toBe(false);
    expect(r.copy).toContain("5–7 working days");
  });

  it("★ a gateway refund NEVER touches the drawer", () => {
    // The shift report must not count money that never left the till.
    expect(
      refundRouteFor({ paymentMethod: "razorpay", paymentStatus: "paid" })
        .affectsDrawer,
    ).toBe(false);
  });

  it("★ COD is the one case where cash at the counter is right", () => {
    const r = refundRouteFor({
      paymentMethod: "cash_on_delivery",
      paymentStatus: "paid",
    });
    expect(r.method).toBe("cash");
    expect(r.counterChoice).toBe(true);
    expect(r.affectsDrawer).toBe(true);
  });

  it("a till sale offers the counter tenders", () => {
    const r = refundRouteFor({ paymentMethod: "card", paymentStatus: "paid" });
    expect(r.counterChoice).toBe(true);
  });

  it("says so when an online order was never paid", () => {
    const r = refundRouteFor({
      paymentMethod: "razorpay",
      paymentStatus: "pending",
    });
    expect(r.copy).toContain("nothing to refund");
    expect(r.counterChoice).toBe(false);
  });

  it("treats an unknown method as a counter sale rather than crashing", () => {
    expect(
      refundRouteFor({ paymentMethod: null, paymentStatus: "paid" }).method,
    ).toBe("cash");
  });
});

describe("isTenderAllowed", () => {
  const gateway = refundRouteFor({
    paymentMethod: "razorpay",
    paymentStatus: "paid",
  });
  const counter = refundRouteFor({
    paymentMethod: "cash_on_delivery",
    paymentStatus: "paid",
  });

  it("★ REFUSES cash for a gateway order, even if the client asks", () => {
    // The till hides the option; this is the server saying no anyway.
    expect(isTenderAllowed(gateway, "cash")).toBe(false);
    expect(isTenderAllowed(gateway, "card")).toBe(false);
    expect(isTenderAllowed(gateway, "upi")).toBe(false);
    expect(isTenderAllowed(gateway, "razorpay")).toBe(true);
  });

  it("allows any counter tender on a COD order", () => {
    expect(isTenderAllowed(counter, "cash")).toBe(true);
    expect(isTenderAllowed(counter, "card")).toBe(true);
    expect(isTenderAllowed(counter, "upi")).toBe(true);
  });

  it("★ refuses the GATEWAY on a COD order — there's nothing to reverse", () => {
    expect(isTenderAllowed(counter, "razorpay")).toBe(false);
  });

  it("refuses junk", () => {
    expect(isTenderAllowed(counter, "bitcoin")).toBe(false);
    expect(isTenderAllowed(gateway, "")).toBe(false);
  });
});
