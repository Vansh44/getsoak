import { describe, it, expect } from "vitest";
import {
  customerStatusLabel,
  isPickup,
  orderProgress,
  pickupNote,
  PAYMENT_LABEL,
} from "./order-status";

const NOW = new Date("2026-08-05T09:42:00.000Z"); // 3:12 pm IST

describe("orderProgress", () => {
  it("walks the delivery journey", () => {
    const steps = ["Order placed", "Being prepared", "On the way", "Delivered"];
    expect(orderProgress({ status: "pending" })).toEqual({ steps, reached: 0 });
    expect(orderProgress({ status: "shipped" })).toEqual({ steps, reached: 2 });
    expect(orderProgress({ status: "delivered" })).toEqual({
      steps,
      reached: 3,
    });
  });

  // ★ A collection order never ships, so on the delivery track it could not
  // advance past "Being prepared" for the rest of its life — and the last two
  // steps described a van that was never coming.
  it("gives a collection order its own steps", () => {
    const { steps } = orderProgress({
      status: "pending",
      fulfilment_type: "pickup",
      pickup_status: "awaiting",
    });
    expect(steps).toEqual([
      "Order placed",
      "Being prepared",
      "Ready to collect",
      "Collected",
    ]);
  });

  it("advances a collection on pickup_status, not order status", () => {
    const at = (pickup_status: string, status = "pending") =>
      orderProgress({ status, fulfilment_type: "pickup", pickup_status })
        .reached;

    expect(at("awaiting")).toBe(0);
    expect(at("awaiting", "processing")).toBe(1);
    expect(at("ready")).toBe(2);
    // The till writes status "completed" alongside pickup_status "collected".
    expect(at("collected", "completed")).toBe(3);
  });

  // ★ "completed" is not in ORDER_FLOW, so indexOf returned -1 and a finished
  // order rendered with every step un-started.
  it("does not blank the track for a completed order", () => {
    expect(orderProgress({ status: "completed" }).reached).toBe(3);
  });
});

describe("customerStatusLabel", () => {
  it("reads a delivery order's own status", () => {
    expect(customerStatusLabel({ status: "shipped" })).toBe("On the way");
  });

  it("speaks collection for a pickup order", () => {
    const label = (pickup_status: string, status = "pending") =>
      customerStatusLabel({ status, fulfilment_type: "pickup", pickup_status });

    expect(label("awaiting")).toBe("Order placed");
    expect(label("awaiting", "processing")).toBe("Being prepared");
    expect(label("ready")).toBe("Ready to collect");
    expect(label("collected", "completed")).toBe("Collected");
  });

  // The expiry sweep sets BOTH pickup_status 'expired' and status 'cancelled'.
  // "Cancelled" alone reads like the shop pulled the order.
  it("says why an uncollected order died", () => {
    expect(
      customerStatusLabel({
        status: "cancelled",
        fulfilment_type: "pickup",
        pickup_status: "expired",
      }),
    ).toBe("Not collected");
  });

  it("never leaks a raw enum", () => {
    expect(customerStatusLabel({ status: "completed" })).toBe("Completed");
  });
});

describe("pickupNote", () => {
  // ★ The bug: a store set to same-day collection quoted "Available today" at
  // checkout, then the order page said "We'll let you know as soon as it's
  // ready" — because it read only pickup_status, which stays 'awaiting' until
  // a human at the till presses ready.
  it("keeps the promise the checkout made", () => {
    const note = pickupNote(
      {
        pickup_status: "awaiting",
        pickup_ready_at: "2026-08-05T09:42:00.000Z", // same-day: ready now
        pickup_expires_at: "2026-08-10T09:42:00.000Z",
      },
      NOW,
    );
    expect(note).toContain("Ready for collection today.");
    expect(note).toContain("Held until 10 August.");
    // Still tells them to wait for the ping — the shop hasn't packed it yet.
    expect(note).toContain("We'll let you know the moment it's packed.");
  });

  it("quotes a date when it isn't ready yet", () => {
    const note = pickupNote(
      {
        pickup_status: "awaiting",
        pickup_ready_at: "2026-08-07T09:42:00.000Z",
        pickup_expires_at: "2026-08-12T09:42:00.000Z",
      },
      NOW,
    );
    expect(note).toContain("Ready for collection from 7 August.");
  });

  it("upgrades once the shop has packed it", () => {
    const note = pickupNote(
      {
        pickup_status: "ready",
        pickup_ready_at: "2026-08-05T09:42:00.000Z",
        pickup_expires_at: "2026-08-10T09:42:00.000Z",
      },
      NOW,
    );
    expect(note).toBe("Packed and waiting for you. Held until 10 August.");
  });

  it("stops quoting a hold window once it's over", () => {
    expect(
      pickupNote(
        {
          pickup_status: "collected",
          pickup_expires_at: "2026-08-10T00:00:00Z",
        },
        NOW,
      ),
    ).toBe("Handed over — thank you.");
    expect(
      pickupNote(
        { pickup_status: "expired", pickup_expires_at: "2026-08-10T00:00:00Z" },
        NOW,
      ),
    ).toContain("wasn't collected in time");
  });

  // ★ Rendered server-side, where the zone is UTC on Cloud Run — an unpinned
  // date would quote the day before for anything lapsing after 18:30 UTC.
  it("renders the hold date in IST", () => {
    const note = pickupNote(
      {
        pickup_status: "ready",
        // 19:00 UTC on the 10th is 00:30 IST on the 11th.
        pickup_expires_at: "2026-08-10T19:00:00.000Z",
      },
      NOW,
    );
    expect(note).toContain("Held until 11 August.");
  });

  it("falls back to today when the ready date is missing", () => {
    expect(
      pickupNote({ pickup_status: "awaiting", pickup_ready_at: null }, NOW),
    ).toContain("Ready for collection today.");
  });
});

describe("isPickup / PAYMENT_LABEL", () => {
  it("only pickup counts as pickup", () => {
    expect(isPickup({ status: "pending", fulfilment_type: "pickup" })).toBe(
      true,
    );
    expect(isPickup({ status: "pending", fulfilment_type: "delivery" })).toBe(
      false,
    );
    expect(isPickup({ status: "pending" })).toBe(false);
  });

  // The header read "Placed 5 Aug 2026 · pay_at_store" on every collection order.
  it("names the pay-at-store method", () => {
    expect(PAYMENT_LABEL["pay_at_store"]).toBe("Pay at store");
  });
});
