/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlText } from "./_test-helpers";

// Approval tokens are HMAC-signed, so the tests need a key to sign with.
process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";

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
vi.mock("@/lib/inventory/alerts", () => ({ reportStockChanges: vi.fn() }));
vi.mock("@/lib/email/pos-receipt", async (orig) => ({
  // Keep the REAL rule — the point of these tests is that placePosSale asks it
  // correctly — and stub only the send.
  ...(await orig<Record<string, unknown>>()),
  sendPosReceipt: vi.fn(),
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
  clientIp: vi.fn(() => "1.2.3.4"),
}));
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
// The drawer lookup is exercised in pos-shift-actions.test.ts; stubbing it here
// keeps it out of this file's seeded query sequence.
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

import { withService } from "@/lib/db/client";
import { currentShiftIdFor } from "./pos-shift-actions";
import { resolvePosOperator } from "@/lib/pos/operator";
import { getStoreSettings } from "@/lib/settings/resolve";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";
import { sendPosReceipt } from "@/lib/email/pos-receipt";
import {
  getCatalogSnapshot,
  placePosSale,
  searchPosCustomers,
  createPosCustomer,
  listPosSales,
} from "./pos-sale-actions";
import { saleFingerprint, signApprovalToken } from "@/lib/pos/approval";

const CASHIER = {
  role: "cashier" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "st1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};

/** The store's superadmin ringing the till — the ONLY actor who may discount. */
const OWNER = {
  ...CASHIER,
  role: "superadmin" as const,
  staffId: null,
  name: "Vansh",
  source: "owner" as const,
};

/** A dashboard admin the owner delegated POS access to. Runs the till, but may
 *  not give money away — that is the point of the owner/superadmin split. */
const DELEGATED_ADMIN = { ...OWNER, role: "owner" as const, name: "Asha" };

const SETTINGS = {
  "pos.allowPriceOverride": true,
  // The default, stated explicitly: discounts are the owner's to give.
  "pos.ownerOnlyDiscounts": true,
  "pos.requireManagerForDiscount": true,
  "pos.maxDiscountPercent": 10,
} as any;

/** A merchant who has deliberately handed discounting to their staff, which is
 *  what re-arms the cap + manager-PIN machinery. */
const STAFF_MAY_DISCOUNT = {
  ...SETTINGS,
  "pos.ownerOnlyDiscounts": false,
} as any;

// A ₹100 product, 18% GST, exclusive pricing, supplier in state 07.
const PRODUCT = {
  id: "p1",
  name: "Cold Brew",
  selling_price: 100,
  tax_class_id: "tc1",
  hsn_code: "2202",
};
const BILLING = {
  store_id: "store-1",
  tax_enabled: true,
  prices_include_tax: false,
  default_tax_class_id: "tc1",
  gst_enabled: true,
};
const TAX_CLASS = { id: "tc1", name: "GST 18%", rate: 18, sort_order: 0 };

/**
 * placePosSale's reads, in order:
 *  1 products, 2 variants(skipped when none), 3 billing, 4 tax classes,
 *  5 location state, 6 receipt prefix.
 * db.execute() calls (receipt seq, reserve_stock_at) come from executeQueue.
 */
function seedHappyPath(over: { productRows?: any[] } = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      over.productRows ?? [PRODUCT], // 1 products
      [BILLING], // 2 billing (variants skipped: no variantIds)
      [TAX_CLASS], // 3 tax classes
      [{ state_code: "07" }], // 4 location state
      [{ prefix: "DEL" }], // 5 receipt prefix
    ],
    executeQueue: [
      [{ seq: 42 }], // next_pos_receipt_no
      [{ reserved: true }], // reserve_stock_at
    ],
    returning: [{ id: "o1", order_ref: "ORD100110006" }],
  });
}

const line = { productId: "p1", variantId: null, quantity: 1 };
const cash = [{ method: "cash" as const, amount: 118, tendered: 200 }];

/**
 * A genuine manager approval for a given cart, as verifyManagerPin would mint
 * it. Tests use the REAL token rather than a stubbed flag, so "an approval
 * doesn't unlock this" means the same thing here as at the till.
 */
function approvalFor(
  sale: { lines: any[]; orderDiscount?: number },
  op: { storeId: string; locationId: string; staffId: string | null } = CASHIER,
): string {
  return signApprovalToken({
    storeId: op.storeId,
    locationId: op.locationId,
    operatorId: op.staffId,
    approverId: "mgr-1",
    fingerprint: saleFingerprint(sale),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
  vi.mocked(getStoreSettings).mockResolvedValue(SETTINGS);
  seedHappyPath();
});

describe("placePosSale — gates", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await placePosSale([line], cash)).error).toMatch(/signed out/i);
  });

  it("rejects an empty cart and a cart with no payment", async () => {
    expect((await placePosSale([], cash)).error).toMatch(/empty/i);
    expect((await placePosSale([line], [])).error).toMatch(/take a payment/i);
  });

  it("★ refuses a tender the system cannot settle — gift card and store credit are declared but unbuilt", async () => {
    // The register only offers cash/card/upi, but this is a server action and
    // the register's JS is not its only caller. Accepting either would mark a
    // sale paid in full against a balance that does not exist.
    for (const method of ["gift_card", "store_credit"] as const) {
      const res = await placePosSale([line], [
        { method, amount: 100 },
      ] as never);
      expect(res.error).toMatch(/invalid payment method/i);
    }
  });

  it("rejects invalid quantities and unknown tender methods", async () => {
    expect(
      (await placePosSale([{ ...line, quantity: 0 }], cash)).error,
    ).toMatch(/quantity/i);
    expect(
      (await placePosSale([{ ...line, quantity: 1.5 }], cash)).error,
    ).toMatch(/quantity/i);
    expect(
      (await placePosSale([line], [{ method: "crypto", amount: 5 } as any]))
        .error,
    ).toMatch(/payment method/i);
  });

  it("refuses a product that isn't in this store", async () => {
    seedHappyPath({ productRows: [] });
    expect((await placePosSale([line], cash)).error).toMatch(
      /no longer available/i,
    );
  });
});

describe("placePosSale — pricing is server-authoritative", () => {
  it("prices from the DB and computes GST, ignoring client-side money", async () => {
    const r = await placePosSale([line], cash);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);

    const order = dbHolder.current.calls.values[0];
    // ₹100 + 18% = ₹118, priced entirely from the DB row.
    expect(order.subtotal).toBe(100);
    expect(order.tax).toBe(18);
    expect(order.total).toBe(118);
    expect(order.salesChannel).toBe("pos");
    expect(order.status).toBe("completed");
    expect(order.paymentStatus).toBe("paid");
    // A walk-in has no account and no delivery address.
    expect(order.customerId).toBeNull();
    expect(order.shippingAddress).toBeNull();
    // Sale context for the receipt + reporting.
    expect(order.locationId).toBe("loc-1");
    expect(order.cashierId).toBe("st1");
    expect(order.cashierName).toBe("Priya");
    expect(r.receiptNo).toBe("DEL-000042");
  });

  it("splits GST into CGST+SGST for an intra-state sale", async () => {
    await placePosSale([line], cash);
    const items = dbHolder.current.calls.values[1];
    expect(items[0]).toMatchObject({
      taxAmount: 18,
      taxCgst: 9,
      taxSgst: 9,
      taxIgst: 0,
      hsnCode: "2202",
    });
  });

  it("returns change for an over-tender and records it", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 200, tendered: 200 }],
    );
    expect(r.changeDue).toBe(82); // 200 - 118
    const payments = dbHolder.current.calls.values[2];
    expect(payments[0]).toMatchObject({
      method: "cash",
      amount: 200,
      changeDue: 82,
    });
  });

  it("refuses when the tenders don't cover the total", async () => {
    const r = await placePosSale([line], [{ method: "cash", amount: 50 }]);
    expect(r.error).toMatch(/doesn't cover/i);
    // Nothing was written.
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a non-cash overpayment", async () => {
    // ★ The message changed when the overpayment rule landed: this used to be
    // caught by "only a cash payment can produce change", which is true and
    // tells a cashier nothing about the figure they mistyped. The refusal is
    // what matters, so that is what is asserted.
    const r = await placePosSale([line], [{ method: "card", amount: 500 }]);
    expect(r.error).toMatch(/can't be more than/i);
  });

  it("★★ refuses a card overpayment PROPPED UP by a token cash tender", async () => {
    // The hole this rule closes: a ₹1 cash tender satisfied the old
    // change-needs-cash check, so an arbitrary card amount was accepted and the
    // difference left the drawer as change.
    const r = await placePosSale(
      [line],
      [
        { method: "cash", amount: 1, tendered: 1 },
        { method: "card", amount: 100_000 },
      ],
    );
    expect(r.error).toMatch(/can't be more than/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("records split tenders as separate rows", async () => {
    const r = await placePosSale(
      [line],
      [
        { method: "cash", amount: 18, tendered: 18 },
        { method: "card", amount: 100, reference: "APPROVED-77" },
      ],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].paymentMethod).toBe("split");
    const payments = dbHolder.current.calls.values[2];
    expect(payments).toHaveLength(2);
    expect(payments[1]).toMatchObject({
      method: "card",
      amount: 100,
      reference: "APPROVED-77",
    });
  });
});

// ★ The default: giving money away belongs to the owner.
describe("placePosSale — only the owner may discount", () => {
  it("refuses a cashier's order discount OUTRIGHT, not for approval", async () => {
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50,
    });
    expect(r.error).toMatch(/only the owner/i);
    // Not `needsApproval` — that would put a PIN prompt on screen and let a
    // manager wave it through.
    expect(r.needsApproval).toBeUndefined();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a MANAGER's discount too", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "manager",
    } as any);
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50,
    });
    expect(r.error).toMatch(/only the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ cannot be unlocked with a manager's PIN", async () => {
    // The manager is one of the people being kept out, so their own PIN must
    // not be the key. This is the whole point of refusing rather than queuing.
    // Note the approval here is REAL and correctly signed — it still doesn't
    // open this door.
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50,
      approvalToken: approvalFor({ lines: [line], orderDiscount: 50 }),
    });
    expect(r.error).toMatch(/only the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ blocks a per-line markdown as well", async () => {
    // Otherwise "Less ₹50" on the line does exactly what "Discount ₹50" is
    // forbidden from doing, and the rule is a rule in name only.
    const r = await placePosSale(
      [{ ...line, quantity: 2, lineDiscount: 50 }],
      [{ method: "cash", amount: 1 }],
    );
    expect(r.error).toMatch(/only the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses a DELEGATED dashboard admin too", async () => {
    // POS access is delegable; discounting is not. Otherwise "owner only" would
    // quietly mean "anyone the owner ever gave a dashboard login with POS on".
    vi.mocked(resolvePosOperator).mockResolvedValue(DELEGATED_ADMIN as any);
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50,
    });
    expect(r.error).toMatch(/only the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("lets the owner discount", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50 },
    );
    expect(r.success).toBe(true);
    const order = dbHolder.current.calls.values[0];
    expect(order.discount).toBe(50);
    // ₹100 − ₹50 discount = ₹50 taxable, +18% = ₹59.
    expect(order.total).toBe(59);
  });

  it("a sale with no discount is unaffected", async () => {
    expect((await placePosSale([line], cash)).success).toBe(true);
  });
});

// ★ A price override is a discount by another name, so it answers to the same
// rule. Leaving it open would have made the block above decorative — a manager
// would just reprice the line instead.
describe("placePosSale — only the owner may override a price", () => {
  const cheap = { ...line, priceOverride: 50 };

  it("refuses a cashier", async () => {
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(r.error).toMatch(/only the owner can change a price/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a manager, and a manager's PIN doesn't help", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "manager",
    } as any);
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { approvalToken: approvalFor({ lines: [cheap] }) },
    );
    expect(r.error).toMatch(/only the owner can change a price/i);
    expect(r.needsApproval).toBeUndefined();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a delegated dashboard admin", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(DELEGATED_ADMIN as any);
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(r.error).toMatch(/only the owner can change a price/i);
  });

  it("lets the owner reprice a line", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].subtotal).toBe(50);
    expect(dbHolder.current.calls.values[1][0].price).toBe(50);
  });

  // The merchant's own on/off switch still comes first — it is a store policy,
  // not a permission, so it stops the owner too.
  it("respects pos.allowPriceOverride being off, even for the owner", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...SETTINGS,
      "pos.allowPriceOverride": false,
    } as any);
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(r.error).toMatch(/turned off/i);
  });

  it("falls back to the manager-PIN flow when staff may discount", async () => {
    vi.mocked(getStoreSettings).mockResolvedValue(STAFF_MAY_DISCOUNT);
    const asCashier = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(asCashier.needsApproval).toBe(true);

    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "manager",
    } as any);
    seedHappyPath();
    const asManager = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(asManager.success).toBe(true);
  });
});

// The pre-existing cap machinery, which now applies only to a merchant who has
// deliberately handed discounting to their staff.
describe("placePosSale — the cap, when staff may discount", () => {
  beforeEach(() => {
    vi.mocked(getStoreSettings).mockResolvedValue(STAFF_MAY_DISCOUNT);
  });

  it("blocks a cashier discounting past the cap", async () => {
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50, // 50% of a ₹100 sale, cap is 10%
    });
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  // ★ A DELIBERATE 0 MUST SURVIVE. The cap was read as `Number(...) || 10`, so
  // a merchant who set it to 0 — "a cashier needs approval for ANY discount",
  // and `min: 0` in the registry says that is a legal setting — silently got
  // the 10% default instead, handing cashiers exactly the authority they had
  // withheld. 5% of a ₹100 sale passed under the swallowed default and must
  // now stop.
  it("treats a 0% cap as approval-for-any-discount, not the 10% default", async () => {
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...STAFF_MAY_DISCOUNT,
      "pos.maxDiscountPercent": 0,
    } as any);
    const r = await placePosSale([line], [{ method: "cash", amount: 200 }], {
      orderDiscount: 5,
    });
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  // The other half of the same rule: 0 must not become "refuse everything"
  // either — a sale with no discount at all is untouched by the cap.
  it("still rings a sale with no discount under a 0% cap", async () => {
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...STAFF_MAY_DISCOUNT,
      "pos.maxDiscountPercent": 0,
    } as any);
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 118, tendered: 118 }],
    );
    expect(r.success).toBe(true);
  });

  it("allows a cashier under the cap with no approval", async () => {
    // ₹100 − ₹10 = ₹90 taxable, +18% = ₹106.20. Tender ₹110.
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 110, tendered: 110 }],
      { orderDiscount: 10 }, // exactly the 10% cap
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].discount).toBe(10);
  });

  it("allows it once a manager PIN has approved", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      {
        orderDiscount: 50,
        approvalToken: approvalFor({ lines: [line], orderDiscount: 50 }),
      },
    );
    expect(r.error).toBeUndefined();
    const order = dbHolder.current.calls.values[0];
    expect(order.discount).toBe(50);
    expect(order.total).toBe(59);
  });

  // ── The approval must be a GRANT, not a claim ────────────────────────────
  // These are the regression tests for the bypass this replaced: the action
  // took `managerApproved: true` straight from the client, so a cashier with
  // devtools could ring any discount without a manager ever being present.

  it("★ refuses a claimed approval with no token at all", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50, approvalToken: "true" },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses a token signed with the wrong key", async () => {
    const saved = process.env.POS_SESSION_SECRET;
    process.env.POS_SESSION_SECRET = "an-attacker's-key";
    const forged = approvalFor({ lines: [line], orderDiscount: 50 });
    process.env.POS_SESSION_SECRET = saved;

    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50, approvalToken: forged },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses an approval given for a SMALLER discount", async () => {
    // The manager looked at ₹10 off and said yes. Replaying that on ₹50 off is
    // the bypass the fingerprint exists to stop.
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      {
        orderDiscount: 50,
        approvalToken: approvalFor({ lines: [line], orderDiscount: 10 }),
      },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses an approval given for a different cart", async () => {
    // Approved: ₹100 off one unit. Submitted: ₹100 off FIVE — still over the
    // cap, but not the sale anybody agreed to.
    const r = await placePosSale(
      [{ ...line, quantity: 5 }],
      [{ method: "cash", amount: 472, tendered: 472 }],
      {
        orderDiscount: 100,
        approvalToken: approvalFor({ lines: [line], orderDiscount: 100 }),
      },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses an approval minted at another till", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      {
        orderDiscount: 50,
        approvalToken: approvalFor(
          { lines: [line], orderDiscount: 50 },
          { ...CASHIER, locationId: "loc-2" },
        ),
      },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("survives the cart being re-ordered between approval and sale", async () => {
    // The fingerprint sorts its lines: an approval a manager really did give
    // must not evaporate because the UI rebuilt the cart in another order.
    const other = { productId: "p0", variantId: null, quantity: 1 };
    dbHolder.current = makeDbMock({
      selectQueue: [
        [PRODUCT, { ...PRODUCT, id: "p0", selling_price: 0 }],
        [BILLING],
        [TAX_CLASS],
        [{ state_code: "07" }],
        [{ prefix: "DEL" }],
      ],
      executeQueue: [[{ seq: 42 }], [{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "o1", order_ref: "ORD100110006" }],
    });

    const r = await placePosSale(
      [line, other],
      [{ method: "cash", amount: 59, tendered: 59 }],
      {
        orderDiscount: 50,
        approvalToken: approvalFor({
          lines: [other, line],
          orderDiscount: 50,
        }),
      },
    );
    expect(r.needsApproval).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("lets a manager discount freely", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "manager",
    } as any);
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50 },
    );
    expect(r.needsApproval).toBeUndefined();
    expect(r.success).toBe(true);
  });
});

describe("placePosSale — stock", () => {
  it("reserves at the register's location", async () => {
    await placePosSale([line], cash);
    const reserveCall = dbHolder.current.calls.execute.find((c: any) =>
      sqlText(c).includes("reserve_stock_at"),
    );
    expect(reserveCall).toBeTruthy();
    expect(sqlText(reserveCall)).toContain("p_location");
  });

  // REGRESSION (POS merge). A register sale wrote an orders row and nothing
  // else: no activity_events entry, no "new order" alert for the team, and no
  // low-stock warning even when it emptied the shelf. The one sales channel
  // physically in front of the merchant was the one they couldn't see.
  it("records the sale as an order.placed event", async () => {
    await placePosSale([line], cash);

    const call = vi
      .mocked(emitEvent)
      .mock.calls.find(([input]) => input?.type === "order.placed");
    expect(call, "a POS sale must emit order.placed").toBeTruthy();
    expect(call![0]).toMatchObject({
      storeId: "store-1",
      payload: { channel: "In-store" },
    });
  });

  it("reports the stock it took, so a shelf it empties still warns", async () => {
    await placePosSale([line], cash);

    expect(reportStockChanges).toHaveBeenCalledWith(
      "store-1",
      // Signed NEGATIVE — stockAlertFor compares before/after, so a sale that
      // crosses the threshold has to look like a decrease.
      expect.arrayContaining([expect.objectContaining({ delta: -1 })]),
    );
  });

  // Overselling must fail the whole sale, not silently sell air.
  it("rolls the order back when stock is short", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [PRODUCT],
        [BILLING],
        [TAX_CLASS],
        [{ state_code: "07" }],
        [{ prefix: "DEL" }],
      ],
      executeQueue: [[{ seq: 43 }], [{ reserved: false }]],
      returning: [{ id: "o1", order_ref: "ORD1" }],
    });

    const r = await placePosSale([line], cash);
    expect(r.error).toMatch(/not enough stock/i);
    // The order row that was created first is deleted again.
    expect(dbHolder.current.calls.delete).toHaveLength(1);
  });
});

describe("getCatalogSnapshot", () => {
  // Two reads per page: the page of product ids, then their sellable SKUs.
  const page = (ids: string[], rows: any[]) => [
    ids.map((id) => ({ id })),
    rows,
  ];
  const row = (over: any = {}) => ({
    product_id: "p1",
    variant_id: null,
    name: "Cold Brew",
    variant_name: null,
    p_sku: "SKU1",
    v_sku: null,
    p_barcode: "890123",
    v_barcode: null,
    p_price: 100,
    v_price: null,
    v_special: null,
    p_image: "https://img/x.webp",
    v_image: null,
    p_track: true,
    v_track: null,
    p_backorder: false,
    v_backorder: null,
    p_stock: 999,
    v_stock: null,
    loc_stock: 4,
    ...over,
  });

  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    const r = await getCatalogSnapshot();
    expect(r.error).toMatch(/signed in/i);
    expect(r.items).toEqual([]);
  });

  it("refuses a role that can't sell", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "nobody",
    } as any);
    expect((await getCatalogSnapshot()).error).toMatch(/not allowed/i);
  });

  // The whole point of the cache: it must carry stock for THIS register's
  // location, not the cross-location aggregate in products.stock.
  it("reports stock at the operator's location, not the aggregate", async () => {
    dbHolder.current = makeDbMock({ selectQueue: page(["p1"], [row()]) });
    const r = await getCatalogSnapshot();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      productId: "p1",
      barcode: "890123",
      price: 100,
      image: "https://img/x.webp",
      stock: 4,
    });
  });

  it("prefers a variant's special price and falls back to the product image", () => {
    dbHolder.current = makeDbMock({
      selectQueue: page(
        ["p1"],
        [
          row({
            variant_id: "v1",
            variant_name: "Large",
            v_price: 150,
            v_special: 120,
            v_image: null,
            v_track: true,
            loc_stock: 2,
          }),
        ],
      ),
    });
    return getCatalogSnapshot().then((r) => {
      expect(r.items[0]).toMatchObject({
        variantId: "v1",
        price: 120,
        image: "https://img/x.webp",
        stock: 2,
      });
    });
  });

  it("ends paging with a null cursor on a short page", async () => {
    dbHolder.current = makeDbMock({ selectQueue: page(["p1"], [row()]) });
    expect((await getCatalogSnapshot()).nextCursor).toBeNull();
  });

  it("returns an empty page (not an error) once the catalog is drained", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const r = await getCatalogSnapshot("p-last");
    expect(r).toMatchObject({ items: [], nextCursor: null });
    expect(r.error).toBeUndefined();
  });

  // Keyset paging, not OFFSET — pages stay stable while the catalog is edited.
  it("pages forward from the cursor", async () => {
    dbHolder.current = makeDbMock({ selectQueue: page(["p2"], [row()]) });
    await getCatalogSnapshot("p1");
    expect(sqlText(dbHolder.current.calls.where[0])).toMatch(/>/);
  });

  // An empty catalog and an unreachable database look identical to the
  // register otherwise — and one of them must not silently blank the grid.
  it("surfaces a DB failure instead of reporting an empty catalog", async () => {
    vi.mocked(withService).mockRejectedValueOnce(new Error("connection reset"));
    const r = await getCatalogSnapshot();
    expect(r.error).toBeTruthy();
    expect(r.items).toEqual([]);
  });
});

describe("placePosSale — customer attach", () => {
  // With a customerId the ownership lookup runs FIRST, ahead of the pricing
  // reads, so the queue gains a leading row.
  const seedWithCustomer = (owner: any[]) =>
    (dbHolder.current = makeDbMock({
      selectQueue: [
        owner, // 0 users (ownership check)
        [PRODUCT],
        [BILLING],
        [TAX_CLASS],
        [{ state_code: "07" }],
        [{ prefix: "DEL" }],
      ],
      executeQueue: [[{ seq: 42 }], [{ reserved: true }]],
      returning: [{ id: "o1", order_ref: "ORD100110006" }],
    }));

  it("attaches a customer who belongs to this store", async () => {
    seedWithCustomer([{ id: "cust-1" }]);
    const r = await placePosSale([line], cash, { customerId: "cust-1" });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerId).toBe("cust-1");
  });

  // THE tenant-isolation guarantee. Without the ownership check the sale would
  // be filed against another store's customer, who holds RLS SELECT on their
  // own orders and would then see a foreign order in their history.
  it("refuses a customer id belonging to another store", async () => {
    seedWithCustomer([]); // no row matches (id AND store_id)
    const r = await placePosSale([line], cash, { customerId: "other-store" });
    expect(r.error).toMatch(/isn't in this store/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("treats a blank customer id as a walk-in", async () => {
    const r = await placePosSale([line], cash, { customerId: "   " });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerId).toBeNull();
  });
});

describe("placePosSale — GSTIN", () => {
  it("normalises a valid GSTIN to upper case", async () => {
    const r = await placePosSale([line], cash, {
      customerGstin: " 22aaaaa0000a1z5 ",
    });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerGstin).toBe(
      "22AAAAA0000A1Z5",
    );
  });

  // It prints on the customer's invoice, so a malformed one is rejected at the
  // boundary rather than immortalised on a document.
  it("rejects a malformed GSTIN before writing anything", async () => {
    const r = await placePosSale([line], cash, {
      customerGstin: "NOT-A-GSTIN",
    });
    expect(r.error).toMatch(/gstin/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("treats a blank GSTIN as absent", async () => {
    const r = await placePosSale([line], cash, { customerGstin: "  " });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerGstin).toBeNull();
  });
});

describe("placePosSale — line discounts", () => {
  const twoOf = { productId: "p1", variantId: null, quantity: 2 };

  // The arithmetic is what's under test here, so these run as the owner — the
  // only actor allowed to mark a line down by default. Who MAY is covered in
  // "only the owner may discount" above.
  beforeEach(() => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
  });

  it("reduces the line amount and the order total", async () => {
    // 2 x ₹100 = ₹200, less ₹30 = ₹170, +18% = ₹200.60 -> 201
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: 30 }],
      [{ method: "cash", amount: 201, tendered: 201 }],
    );
    expect(r.success).toBe(true);
    const order = dbHolder.current.calls.values[0];
    expect(order.subtotal).toBe(200);
    expect(order.discount).toBe(30);
    const items = dbHolder.current.calls.values[1];
    expect(items[0].lineDiscount).toBe(30);
    expect(items[0].total).toBe(170);
  });

  // A markdown larger than the line would otherwise make the line negative and
  // quietly discount the rest of the sale.
  it("caps a line discount at the line's own value", async () => {
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: 9999 }],
      [{ method: "cash", amount: 1, tendered: 1 }],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].discount).toBe(200);
    expect(dbHolder.current.calls.values[1][0].total).toBe(0);
  });

  // The cap is on TOTAL generosity — line and order discounts together — so a
  // cashier can't stay under it by splitting the giveaway across both. Only
  // reachable once a merchant has let staff discount at all.
  it("counts line discounts toward the manager-approval cap", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    vi.mocked(getStoreSettings).mockResolvedValue(STAFF_MAY_DISCOUNT);
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: 50 }], // 25% of ₹200; cap is 10%
      [{ method: "cash", amount: 1 }],
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  // Rejected before it becomes a discount at all — so it must not trip the
  // owner-only gate either. Run as a CASHIER precisely to prove that.
  it("ignores a negative or non-numeric line discount", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: -50 }],
      [{ method: "cash", amount: 236, tendered: 236 }],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].discount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Emailing a receipt to a walk-in (roadmap Step 4).
// ---------------------------------------------------------------------------
describe("placePosSale — receipt email", () => {
  it("sends one to a walk-in who asked for it", async () => {
    const r = await placePosSale([line], cash, {
      receiptEmail: "asha@example.com",
    });
    expect(r.success).toBe(true);
    expect(sendPosReceipt).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sendPosReceipt).mock.calls[0][0];
    expect(sent.to).toBe("asha@example.com");
    expect(sent.storeId).toBe("store-1");
    // The SAME figures the thermal receipt prints, so paper and inbox agree.
    expect(sent.summary.total).toBe(118);
    expect(sent.summary.items?.[0]?.name).toBeTruthy();
  });

  it("sends nothing when nobody asked", async () => {
    await placePosSale([line], cash);
    expect(sendPosReceipt).not.toHaveBeenCalled();
  });

  // ★ A typo in an OPTIONAL field must never fail a sale that has already taken
  // money and moved stock (invariant 6).
  it("drops an unusable address instead of refusing the sale", async () => {
    const r = await placePosSale([line], cash, {
      receiptEmail: "not-an-email",
    });
    expect(r.success).toBe(true);
    expect(sendPosReceipt).not.toHaveBeenCalled();
  });

  it("normalises the address it sends to", async () => {
    await placePosSale([line], cash, {
      receiptEmail: "  ASHA@Example.COM  ",
    });
    expect(vi.mocked(sendPosReceipt).mock.calls[0][0].to).toBe(
      "asha@example.com",
    );
  });

  // The ownership check reads the customer FIRST, so its row goes at the head
  // of the happy-path queue. ⚠ Getting this wrong makes the sale fail, and a
  // failed sale sends no receipt — so a "does not send" assertion would pass
  // for entirely the wrong reason. Both cases assert success as well.
  function seedWithCustomer(email: string | null) {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "cust-1", email }], // 0 customer ownership + address
        [PRODUCT], // 1 products
        [BILLING], // 2 billing
        [TAX_CLASS], // 3 tax classes
        [{ state_code: "07" }], // 4 location state
        [{ prefix: "DEL" }], // 5 receipt prefix
      ],
      executeQueue: [[{ seq: 42 }], [{ reserved: true }]],
      returning: [{ id: "o1", order_ref: "ORD100110006" }],
    });
  }

  // ★ ONE RECEIPT, NEVER TWO. An attached customer with an address already gets
  // the order.placed fan-out's confirmation.
  it("does NOT send when the attached customer will get the fan-out's copy", async () => {
    seedWithCustomer("cust@example.com");
    const r = await placePosSale([line], cash, {
      customerId: "cust-1",
      receiptEmail: "asha@example.com",
    });
    expect(r.success).toBe(true); // or the assertion below is vacuous
    expect(sendPosReceipt).not.toHaveBeenCalled();
  });

  it("DOES send for an attached customer with no address on file", async () => {
    seedWithCustomer(null);
    const r = await placePosSale([line], cash, {
      customerId: "cust-1",
      receiptEmail: "asha@example.com",
    });
    expect(r.success).toBe(true);
    expect(sendPosReceipt).toHaveBeenCalledTimes(1);
  });
});

describe("createPosCustomer", () => {
  beforeEach(() => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
  });

  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect(
      (await createPosCustomer({ name: "A", phone: "9876543210" })).error,
    ).toMatch(/signed in/i);
  });

  // ★ `sell`, not a manager grant: recording who bought something is part of
  // ringing up a sale, and gating it above the counter means it never happens.
  it("is open to a cashier", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_abc" }] });
    const r = await createPosCustomer({ name: "Asha", phone: "9876543210" });
    expect(r.error).toBeUndefined();
    expect(r.customer?.id).toBe("pos_abc");
  });

  it("validates before it writes", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_abc" }] });
    const r = await createPosCustomer({ name: "Asha", phone: "12345" });
    expect(r.error).toMatch(/mobile/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  // ★ The id shape IS the claim mechanism and IS what keeps the row unreadable
  // by every session (customer RLS matches auth.uid() against users.id).
  it("writes a pos_ id, scoped to the operator's store", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_abc" }] });
    await createPosCustomer({ name: "Asha Rao", phone: "+91 98765 43210" });
    const row = dbHolder.current.calls.values[0];
    expect(row.id).toMatch(/^pos_/);
    expect(row.storeId).toBe(CASHIER.storeId);
    // Normalised, so a later signup typing "9876543210" still matches.
    expect(row.phone).toBe("9876543210");
    expect(row.firstName).toBe("Asha");
    expect(row.lastName).toBe("Rao");
  });

  it("never lets the caller choose the store", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_abc" }] });
    await createPosCustomer({
      name: "Asha",
      phone: "9876543210",
      // @ts-expect-error — not in the input type; the point is it is ignored.
      storeId: "00000000-0000-4000-8000-000000000009",
    });
    expect(dbHolder.current.calls.values[0].storeId).toBe(CASHIER.storeId);
  });

  // ★ A cashier who mistyped a search and typed the number by hand meant
  // "this person" — answering "already exists" leaves them re-searching with a
  // queue behind them. It leaks nothing: the search would have found this row.
  it("attaches the existing customer when the phone is already on file", async () => {
    dbHolder.current = makeDbMock({
      returning: [],
      selectQueue: [
        [
          {
            id: "existing-uid",
            phone: "9876543210",
            email: "a@x.com",
            first_name: "Asha",
            last_name: "Rao",
          },
        ],
      ],
    });
    const r = await createPosCustomer({ name: "Asha", phone: "9876543210" });
    expect(r.error).toBeUndefined();
    expect(r.customer).toEqual({
      id: "existing-uid",
      name: "Asha Rao",
      phone: "9876543210",
      email: "a@x.com",
    });
  });

  it("reports an error when the conflict lookup finds nothing", async () => {
    dbHolder.current = makeDbMock({ returning: [], selectQueue: [[]] });
    expect(
      (await createPosCustomer({ name: "A", phone: "9876543210" })).error,
    ).toBeTruthy();
  });
});

describe("searchPosCustomers", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await searchPosCustomers("ravi")).error).toMatch(/signed in/i);
  });

  // A one-character search would stream a large slice of the customer list to
  // a shared till for no benefit.
  it("returns nothing below the 2-character floor without querying", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "c1" }]] });
    const r = await searchPosCustomers("r");
    expect(r.customers).toEqual([]);
    expect(dbHolder.current.calls.where).toHaveLength(0);
  });

  // sqlText renders operators without column names, so this asserts the
  // SHAPE: an equality (the store scope) AND-ed ahead of the name/phone/email
  // OR group. Drop the store scope and the leading `=` disappears.
  it("scopes the search to the operator's store", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await searchPosCustomers("ravi");
    expect(sqlText(dbHolder.current.calls.where[0])).toMatch(
      /^\( = {2}and \( ilike( {2}or {2}ilike)+ \)\)$/,
    );
  });

  it("builds a display name and falls back to the phone", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "c1",
            phone: "9876543210",
            email: "r@x.com",
            first_name: "Ravi",
            last_name: "Kumar",
          },
          {
            id: "c2",
            phone: "9000000000",
            email: null,
            first_name: "",
            last_name: null,
          },
        ],
      ],
    });
    const r = await searchPosCustomers("ravi");
    expect(r.customers[0]).toMatchObject({ name: "Ravi Kumar", id: "c1" });
    expect(r.customers[1].name).toBe("9000000000");
  });
});

describe("placePosSale — shift attribution", () => {
  it("stamps the sale onto the open drawer", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValue("shift-1");
    const r = await placePosSale([line], cash);
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].shiftId).toBe("shift-1");
  });

  // Reconciliation surfaces an unattributed sale; a failed drawer lookup must
  // never refuse a paying customer.
  it("still sells when no shift is open", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValue(null);
    const r = await placePosSale([line], cash);
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].shiftId).toBeNull();
  });

  it("refuses when the store requires an open shift and there is none", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValue(null);
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...SETTINGS,
      "pos.requireOpenShift": true,
    } as any);
    const r = await placePosSale([line], cash);
    expect(r.error).toMatch(/open a shift/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("sells under that setting once a shift is open", async () => {
    vi.mocked(currentShiftIdFor).mockResolvedValue("shift-1");
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...SETTINGS,
      "pos.requireOpenShift": true,
    } as any);
    expect((await placePosSale([line], cash)).success).toBe(true);
  });
});

describe("listPosSales", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await listPosSales()).error).toMatch(/signed in/i);
  });

  // The commonest reason to look a sale up is a customer at the counter asking
  // for their bill again. Making that a manager's job stops the queue.
  it("a cashier may look up sales", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect((await listPosSales()).error).toBeUndefined();
  });

  // sqlText renders operators without column names, so this asserts the SHAPE:
  // store =, location =, and `is not null` (the receipt-no filter) AND-ed.
  it("★ scopes to the operator's own shop and to TILL sales only", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await listPosSales();
    const where = sqlText(dbHolder.current.calls.where[0]);
    expect(where).toMatch(/=/);
    expect(where).toMatch(/is not null/);
  });

  // ★ The count is a separate grouped query, not a correlated subquery in the
  // select: interpolating columns into sql`` drops their table qualification,
  // so `where "order_id" = "id"` resolved both names inside order_items and
  // silently returned 0 for every sale.
  it("counts the items on each sale", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o1",
            receipt_no: "POS-000007",
            order_ref: "ORD10011027",
            total: "240.50",
            created_at: "2026-07-30T10:00:00Z",
            cashier_name: "Priya",
            shipping_address: { firstName: "Ravi", lastName: "Kumar" },
            payment_method: "cash",
            status: "cancelled",
          },
        ],
        // Second query: the grouped item counts.
        [{ order_id: "o1", n: 3 }],
      ],
    });
    const { sales } = await listPosSales();
    expect(sales[0]).toMatchObject({
      receiptNo: "POS-000007",
      total: 240.5,
      customerName: "Ravi Kumar",
      itemCount: 3,
      refunded: true,
    });
  });

  it("leaves a walk-in's name null rather than inventing one", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o2",
            receipt_no: "POS-000008",
            order_ref: "ORD10011028",
            total: "99",
            created_at: "2026-07-30T10:00:00Z",
            cashier_name: null,
            shipping_address: null,
            payment_method: "cash",
            status: "completed",
          },
        ],
        [{ order_id: "o2", n: 1 }],
      ],
    });
    const { sales } = await listPosSales();
    expect(sales[0].customerName).toBeNull();
    expect(sales[0].refunded).toBe(false);
  });
});
