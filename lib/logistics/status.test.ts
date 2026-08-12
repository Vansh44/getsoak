import { describe, expect, it } from "vitest";
import { acceptShipmentTransition, mapShiprocketStatus } from "./status";

describe("Shiprocket shipment statuses", () => {
  it("maps the carrier's important numeric milestones", () => {
    expect(mapShiprocketStatus(27, "Pickup Booked")).toBe("pickup_scheduled");
    expect(mapShiprocketStatus(42, "PICKED UP")).toBe("picked_up");
    expect(mapShiprocketStatus(17, "Out For Delivery")).toBe(
      "out_for_delivery",
    );
    expect(mapShiprocketStatus(7, "Delivered")).toBe("delivered");
    expect(mapShiprocketStatus(9, "RTO Initiated")).toBe("rto_initiated");
    expect(mapShiprocketStatus(10, "RTO Delivered")).toBe("rto_delivered");
  });

  it("falls back to status text when no code is supplied", () => {
    expect(mapShiprocketStatus(undefined, "Reached at destination hub")).toBe(
      "in_transit",
    );
    expect(mapShiprocketStatus(undefined, "Undelivered")).toBe("ndr");
  });

  it("does not regress on a late webhook", () => {
    expect(acceptShipmentTransition("out_for_delivery", "in_transit")).toBe(
      "out_for_delivery",
    );
    expect(acceptShipmentTransition("delivered", "in_transit")).toBe(
      "delivered",
    );
  });

  it("allows an NDR reattempt to rejoin the forward journey", () => {
    expect(acceptShipmentTransition("ndr", "in_transit")).toBe("in_transit");
    expect(acceptShipmentTransition("ndr", "out_for_delivery")).toBe(
      "out_for_delivery",
    );
  });
});
