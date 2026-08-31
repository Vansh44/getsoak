import { describe, expect, it } from "vitest";
import {
  evaluateMinkOrderTransition,
  nextMinkOrderStatus,
  type MinkOrderTransitionFacts,
} from "./order-status-policy";

const BASE: MinkOrderTransitionFacts = {
  status: "pending",
  salesChannel: "online",
  fulfilmentType: "delivery",
  paymentMethod: "cash_on_delivery",
  paymentStatus: "pending",
  cancellationStatus: null,
  shipmentStatus: null,
};

describe("Mink Phase 5C order transition policy", () => {
  it.each([
    ["pending", "processing"],
    ["processing", "shipped"],
    ["shipped", "delivered"],
  ])("allows exactly one forward step from %s to %s", (status, target) => {
    expect(evaluateMinkOrderTransition({ ...BASE, status }, target)).toEqual({
      allowed: true,
      targetStatus: target,
    });
    expect(nextMinkOrderStatus(status)).toBe(target);
  });

  it.each([
    ["pending", "shipped"],
    ["processing", "delivered"],
    ["shipped", "processing"],
    ["delivered", "delivered"],
    ["cancelled", "processing"],
    ["completed", "processing"],
  ])(
    "rejects skipped, reverse or terminal transition %s -> %s",
    (status, target) => {
      expect(
        evaluateMinkOrderTransition({ ...BASE, status }, target).allowed,
      ).toBe(false);
    },
  );

  it.each([
    [{ salesChannel: "pos" }, "mink_order_channel_unsupported"],
    [{ fulfilmentType: "pickup" }, "mink_order_fulfilment_unsupported"],
    [{ cancellationStatus: "requested" }, "mink_order_cancellation_pending"],
    [{ cancellationStatus: "approved" }, "mink_order_cancellation_state"],
    [{ paymentStatus: "refunded" }, "mink_order_payment_refunded"],
    [{ paymentStatus: "partially_refunded" }, "mink_order_payment_refunded"],
    [
      {
        paymentMethod: "razorpay",
        paymentStatus: "pending",
      },
      "mink_order_payment_unsettled",
    ],
    [{ paymentStatus: "failed" }, "mink_order_payment_failed"],
  ])("fails closed for ineligible order context %#", (patch, code) => {
    const decision = evaluateMinkOrderTransition(
      { ...BASE, ...patch } as MinkOrderTransitionFacts,
      "processing",
    );
    expect(decision).toMatchObject({ allowed: false, code });
  });

  it("allows a previously declined cancellation to continue through normal policy", () => {
    expect(
      evaluateMinkOrderTransition(
        { ...BASE, cancellationStatus: "declined" },
        "processing",
      ).allowed,
    ).toBe(true);
  });

  it("requires carrier evidence before shipped or delivered", () => {
    expect(
      evaluateMinkOrderTransition(
        { ...BASE, status: "processing", shipmentStatus: "ready_to_ship" },
        "shipped",
      ),
    ).toMatchObject({
      allowed: false,
      code: "mink_order_shipment_not_collected",
    });
    expect(
      evaluateMinkOrderTransition(
        { ...BASE, status: "processing", shipmentStatus: "in_transit" },
        "shipped",
      ).allowed,
    ).toBe(true);
    expect(
      evaluateMinkOrderTransition(
        { ...BASE, status: "shipped", shipmentStatus: "out_for_delivery" },
        "delivered",
      ),
    ).toMatchObject({
      allowed: false,
      code: "mink_order_shipment_not_delivered",
    });
    expect(
      evaluateMinkOrderTransition(
        { ...BASE, status: "shipped", shipmentStatus: "delivered" },
        "delivered",
      ).allowed,
    ).toBe(true);
  });

  it.each(["ndr", "rto_initiated", "cancelled", "lost", "damaged"])(
    "blocks shipment exception state %s",
    (shipmentStatus) => {
      expect(
        evaluateMinkOrderTransition({ ...BASE, shipmentStatus }, "processing"),
      ).toMatchObject({
        allowed: false,
        code: "mink_order_shipment_exception",
      });
    },
  );
});
