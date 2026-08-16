/* eslint-disable @typescript-eslint/no-explicit-any */

// The collection counter. Two things are being pinned here:
//
//   1. The CLAIM — awaiting/ready → collected happens exactly once, so two
//      staff scanning the same order hand it over once.
//   2. The MONEY — a `pay_at_store` collection is where cash enters the drawer,
//      and until 2026-08-06 none of it was recorded, so every shift reported
//      OVER by the value of every collection it took (CODEBASE §23).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  recordEvent: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/inventory/reservations", () => ({
  commitHold: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
vi.mock("./pos-shift-actions", () => ({
  currentShiftIdFor: vi.fn(async () => null),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { resolvePosOperator } from "@/lib/pos/operator";
import { getStoreSettings } from "@/lib/settings/resolve";
import { emitEvent } from "@/lib/notifications/record";
import { commitHold } from "@/lib/inventory/reservations";
import { currentShiftIdFor } from "./pos-shift-actions";
import {
  getPickupQueue,
  markCollected,
  markReadyForPickup,
} from "./pos-pickup-actions";

const CASHIER = {
  role: "cashier" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "st1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};

/** What the claim returns when it WINS. */
const CLAIMED = [
  {
    id: "ord-1",
    order_ref: "ORD100110006",
    customer_id: "cust-1",
    location_name: "Main",
    location_address: { line1: "12 MG Road", city: "Delhi" },
  },
];

// Both fixtures are `ready`: these cases exercise the MONEY path, and an order
// at the counter has normally been packed and checked off. The preparation gate
// gets its own block below — leaving the status unset here would make every one
// of these a test of `handoverGate` by accident.
/** The pre-claim read: an order still owing money at the counter. */
const UNPAID = {
  total: 340,
  payment_method: "pay_at_store",
  payment_status: "pending",
  pickup_status: "ready",
};
/** The common case — bought and paid for online, just being picked up. */
const PREPAID = {
  total: 340,
  payment_method: "razorpay",
  payment_status: "paid",
  pickup_status: "ready",
};

/** markCollected's reads in order: the pre-claim look, then this order's holds. */
const seed = (order: any, holds: any[] = []) =>
  makeDbMock({
    returning: CLAIMED,
    selectQueue: [order ? [order] : [], holds],
  });

const cash = (amount: number, tendered = amount) => [
  { method: "cash" as const, amount, tendered },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
  vi.mocked(getStoreSettings).mockResolvedValue({
    "pos.requireOpenShift": false,
  } as any);
  vi.mocked(currentShiftIdFor).mockResolvedValue("sh1");
  dbHolder.current = seed(PREPAID);
});

describe("markCollected — the claim", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await markCollected("ord-1")).error).toMatch(/signed in/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("refuses an empty order id before touching the database", async () => {
    expect((await markCollected("")).error).toMatch(/invalid order/i);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("hands over a prepaid order", async () => {
    const res = await markCollected("ord-1");
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.update).toHaveLength(1);
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      pickupStatus: "collected",
      status: "completed",
      collectedBy: "st1",
    });
  });

  it("★ a second tap changes nothing — the claim matched no rows", async () => {
    // The customer already has the goods. The order must not be re-collected,
    // and nothing downstream may run a second time.
    dbHolder.current = makeDbMock({
      returning: [],
      selectQueue: [[UNPAID], []],
    });
    const res = await markCollected("ord-1", cash(340));
    expect(res.error).toMatch(/already have been collected/i);
    expect(res.success).toBeUndefined();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(commitHold).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("refuses an order that isn't waiting at THIS counter", async () => {
    dbHolder.current = seed(null);
    const res = await markCollected("ord-1");
    expect(res.error).toMatch(/isn't waiting for collection here/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("commits the holds and announces the collection once claimed", async () => {
    dbHolder.current = seed(PREPAID, [{ id: "hold-1" }, { id: "hold-2" }]);
    await markCollected("ord-1");
    expect(commitHold).toHaveBeenCalledTimes(2);
    expect(commitHold).toHaveBeenCalledWith("hold-1", "ord-1");
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.collected" }),
    );
  });

  it("a stranded hold does not undo a hand-over the customer already has", async () => {
    dbHolder.current = seed(PREPAID, [{ id: "hold-1" }]);
    vi.mocked(commitHold).mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await markCollected("ord-1")).success).toBe(true);
  });
});

describe("markCollected — the money", () => {
  it("★ records the cash so shift reconciliation can see it", async () => {
    dbHolder.current = seed(UNPAID);
    const res = await markCollected("ord-1", cash(340));

    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(1);
    expect(dbHolder.current.calls.values[0]).toEqual([
      expect.objectContaining({
        orderId: "ord-1",
        storeId: "store-1",
        method: "cash",
        amount: 340,
        tendered: 340,
        changeDue: 0,
      }),
    ]);
  });

  it("★ stamps the drawer, or the payment row joins to nothing", async () => {
    // loadReport reads cash as order_payments INNER JOIN orders ON shift_id.
    // Without the stamp the row exists and still contributes 0 to expectedCash.
    dbHolder.current = seed(UNPAID);
    await markCollected("ord-1", cash(340));
    expect(dbHolder.current.calls.set[0]).toMatchObject({ shiftId: "sh1" });
  });

  it("★ does NOT stamp a prepaid collection — it never touched this drawer", async () => {
    // Stamping would pull the whole total into the Z-report's gross as takings
    // the till never took.
    await markCollected("ord-1");
    expect(dbHolder.current.calls.set[0]).not.toHaveProperty("shiftId");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ pay_at_store is NOT assumed to be cash", async () => {
    // The checkout copy is "Pay at the counter", deliberately silent on the
    // instrument. Recording a card payment as cash would report the drawer
    // SHORT — the same bug pointed the other way.
    dbHolder.current = seed(UNPAID);
    await markCollected("ord-1", [
      { method: "card", amount: 340, reference: "APPROVAL-9" },
    ]);
    expect(dbHolder.current.calls.values[0][0]).toMatchObject({
      method: "card",
      amount: 340,
      tendered: null,
      changeDue: null,
      reference: "APPROVAL-9",
    });
  });

  it("splits a mixed tender into one row each, with change only on the cash", async () => {
    dbHolder.current = seed(UNPAID);
    const res = await markCollected("ord-1", [
      { method: "card", amount: 200 },
      { method: "cash", amount: 200, tendered: 200 },
    ]);
    expect(res.changeDue).toBe(60);
    const rows = dbHolder.current.calls.values[0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ method: "card", changeDue: null });
    expect(rows[1]).toMatchObject({ method: "cash", changeDue: 60 });
  });

  it("returns change on an over-tender and records it on the row", async () => {
    dbHolder.current = seed(UNPAID);
    const res = await markCollected("ord-1", cash(500));
    expect(res.changeDue).toBe(160);
    expect(dbHolder.current.calls.values[0][0]).toMatchObject({
      tendered: 500,
      changeDue: 160,
    });
  });

  it("★ refuses a short payment BEFORE claiming — the goods stay on the shelf", async () => {
    // Claiming first and then refusing the money is the one outcome with no
    // recovery: the order reads as collected and nothing was ever taken.
    dbHolder.current = seed(UNPAID);
    const res = await markCollected("ord-1", cash(300));
    expect(res.error).toMatch(/doesn't cover/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses to hand over an unpaid order with no payment at all", async () => {
    dbHolder.current = seed(UNPAID);
    const res = await markCollected("ord-1");
    expect(res.error).toMatch(/₹340/);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★ refuses a tender the system cannot settle", async () => {
    // ★ store_credit is in the SELL counter's allowlist now (§29), but not
    // this one — no spend is wired here, so accepting it would mark a
    // collection paid against a balance nothing deducted.
    for (const method of ["gift_card", "store_credit", "bitcoin"]) {
      // Re-seeded per case: each call consumes the queued pre-claim read.
      dbHolder.current = seed(UNPAID);
      const res = await markCollected("ord-1", [
        { method, amount: 340 } as any,
      ]);
      expect(res.error).toMatch(/invalid payment method/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    }
  });

  it("★ refuses tenders on an order that owes nothing", async () => {
    // Recording them would inflate the drawer's expected cash with money never
    // handed over, reporting it SHORT.
    const res = await markCollected("ord-1", cash(340));
    expect(res.error).toMatch(/already paid/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★ does not settle an order whose payment FAILED", async () => {
    dbHolder.current = seed({ ...UNPAID, payment_status: "failed" });
    const res = await markCollected("ord-1", cash(340));
    expect(res.error).toMatch(/already paid/i);
  });
});

describe("markCollected — no open shift", () => {
  it("waits for a drawer when the store requires one", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValue(null);
    vi.mocked(getStoreSettings).mockResolvedValue({
      "pos.requireOpenShift": true,
    } as any);
    dbHolder.current = seed(UNPAID);
    const res = await markCollected("ord-1", cash(340));
    expect(res.error).toMatch(/open a shift/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("★ takes the money unattributed when it doesn't — the same home a counter sale gets", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValue(null);
    dbHolder.current = seed(UNPAID);
    const res = await markCollected("ord-1", cash(340));
    expect(res.success).toBe(true);
    expect(dbHolder.current.calls.set[0]).not.toHaveProperty("shiftId");
    // Still recorded: the payment exists to be reconciled against, which is
    // what surfaces the missing drawer.
    expect(dbHolder.current.calls.insert).toHaveLength(1);
  });

  it("hands over a PREPAID order with no shift open and no setting consulted", async () => {
    // No money changes hands, so the drawer is irrelevant. Blocking here would
    // refuse a customer their own paid-for goods.
    vi.mocked(currentShiftIdFor).mockResolvedValue(null);
    vi.mocked(getStoreSettings).mockResolvedValue({
      "pos.requireOpenShift": true,
    } as any);
    expect((await markCollected("ord-1")).success).toBe(true);
    expect(getStoreSettings).not.toHaveBeenCalled();
  });

  it("a settings failure does not refuse a customer at the counter", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValue(null);
    vi.mocked(getStoreSettings).mockRejectedValue(new Error("db down"));
    dbHolder.current = seed(UNPAID);
    expect((await markCollected("ord-1", cash(340))).success).toBe(true);
  });
});

describe("getPickupQueue", () => {
  it("quotes what is still owed, and 0 for a prepaid order", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "ord-1",
            order_ref: "ORD1",
            shipping_address: { firstName: "Asha", lastName: "R" },
            total: "340.00",
            payment_method: "pay_at_store",
            payment_status: "pending",
            created_at: "2026-08-06T09:00:00Z",
            expires_at: null,
            status: "ready",
          },
          {
            id: "ord-2",
            order_ref: "ORD2",
            shipping_address: null,
            total: "99.50",
            payment_method: "razorpay",
            payment_status: "paid",
            created_at: "2026-08-06T09:00:00Z",
            expires_at: null,
            status: "awaiting",
          },
        ],
        [{ order_id: "ord-1", n: 3 }],
      ],
    });

    const res = await getPickupQueue();
    expect(res.orders[0]).toMatchObject({
      orderRef: "ORD1",
      customerName: "Asha R",
      itemCount: 3,
      total: 340,
      amountDue: 340,
    });
    expect(res.orders[1]).toMatchObject({ total: 99.5, amountDue: 0 });
  });

  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    const res = await getPickupQueue();
    expect(res.error).toMatch(/signed in/i);
    expect(res.orders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Who may mark an order ready (roadmap Step 3)
//
// ★★ EVERY POS ROLE MAY MARK READY, cashier included (2026-08-16). It was
// manager-and-above on the reasoning that this is the step that TELLS A CUSTOMER
// TO TRAVEL, so it should be someone who has seen the box. True of the promise,
// wrong about who packs: in most shops the person at the counter IS the person
// picking the order off the shelf, so withholding the button meant the "To
// prepare" queue could only be worked by someone who might not be in the
// building.
//
// It stays a NAMED capability rather than collapsing into `sell`, so a future
// till-only or restricted role can sell without it.
// ---------------------------------------------------------------------------

const MANAGER = { ...CASHIER, role: "manager" as const, name: "Asha" };

describe("markReadyForPickup — the capability split", () => {
  it("★ allows a cashier — they are the one holding the box", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    dbHolder.current = makeDbMock({ returning: CLAIMED });
    const res = await markReadyForPickup("ord-1");
    expect(res.success).toBe(true);
    // And the customer is told, which is the whole point of the step.
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.ready_for_pickup" }),
    );
  });

  it("allows a manager", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(MANAGER as any);
    dbHolder.current = makeDbMock({ returning: CLAIMED });
    const res = await markReadyForPickup("ord-1");
    expect(res.success).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "order.ready_for_pickup" }),
    );
  });

  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await markReadyForPickup("ord-1")).error).toMatch(/signed in/i);
  });

  // ★ HANDING OVER IS STILL A CASHIER'S JOB. Tightening mark-ready must not
  // quietly tighten this too — that would stop a shop serving customers.
  it("★ leaves markCollected open to a cashier", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            total: 0,
            payment_method: "razorpay",
            payment_status: "paid",
            pickup_status: "ready",
          },
        ],
      ],
      returning: CLAIMED,
    });
    const res = await markCollected("ord-1");
    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handing over an order nobody prepared
//
// markCollected accepted 'awaiting' as readily as 'ready', so a cashier could
// close an order out of the "To prepare" queue that nobody had packed, in one
// tap, silently. The fix is an acknowledgement, not a refusal: a customer who
// arrives before the shop has packed is ordinary, and a cashier alone at the
// counter must still be able to serve them.
// ---------------------------------------------------------------------------

/**
 * The literal text of a Drizzle `sql` fragment.
 *
 * It cannot be stringified — a fragment holds Column objects, and a column
 * points back at its table, which points back at the column.
 */
const sqlText = (frag: unknown): string =>
  ((frag as { queryChunks?: unknown[] })?.queryChunks ?? [])
    .map((c) => {
      const v = (c as { value?: unknown })?.value;
      return Array.isArray(v) ? v.join("") : "";
    })
    .join(" ");

describe("markCollected — an order that was never marked ready", () => {
  const AWAITING = { ...PREPAID, pickup_status: "awaiting" };

  beforeEach(() => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    vi.mocked(getStoreSettings).mockResolvedValue({} as any);
  });

  it("refuses the first tap and offers the confirmation", async () => {
    dbHolder.current = seed(AWAITING);
    const res = await markCollected("ord-1");
    expect(res.success).toBeUndefined();
    expect(res.error).toMatch(/hasn't been marked ready/i);
    expect(res.needsPreparedAck).toBe(true);
    // ★ NOTHING MOVED. The refusal lands before the claim, so the goods stay on
    // the shelf and the order is still waiting — the same ordering the money
    // read already uses.
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("goes through once the cashier confirms they have the goods", async () => {
    dbHolder.current = seed(AWAITING);
    const res = await markCollected("ord-1", [], {
      acknowledgeUnprepared: true,
    });
    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
  });

  // ★ THE AUDIT TRAIL WITH NO NEW COLUMN: pickup_ready_at is written by the
  // same statement as collected_at, so the two match exactly when nobody
  // prepared it — and coalesce keeps a genuine earlier one.
  it("stamps a ready time so the shopper's tracker is coherent", async () => {
    dbHolder.current = seed(AWAITING);
    await markCollected("ord-1", [], { acknowledgeUnprepared: true });
    const set = dbHolder.current.calls.set[0];
    expect(set.pickupReadyAt).toBeDefined();
    expect(sqlText(set.pickupReadyAt)).toMatch(/coalesce/i);
  });

  // ★ NO SETTINGS READ AT ALL. The preparation question is answered from the
  // order's own status; there is no policy to consult since `fulfil_pickup`
  // reaches every POS role, which is what retired the `manager_only` option.
  it("does not consult settings to decide the preparation question", async () => {
    vi.mocked(getStoreSettings).mockRejectedValue(new Error("down"));
    dbHolder.current = seed(AWAITING);
    const res = await markCollected("ord-1", [], {
      acknowledgeUnprepared: true,
    });
    expect(res.success).toBe(true);
  });

  // ★ The acknowledgement is for the PREPARATION step only. It must not become
  // a way to wave through an order that is already collected or expired — that
  // is still the claim's job, and it matches zero rows.
  it("does not let the acknowledgement revive a dead order", async () => {
    dbHolder.current = seed(null);
    const res = await markCollected("ord-1", [], {
      acknowledgeUnprepared: true,
    });
    expect(res.success).toBeUndefined();
    expect(res.error).toBeTruthy();
  });
});
