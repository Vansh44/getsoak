/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

const STORE = "store-1";

vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => STORE),
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  assertCanActivateOffer: vi.fn(),
  storeAllowsPlanFeature: vi.fn(async () => true),
  PlanEntitlementError: class PlanEntitlementError extends Error {},
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_id: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
}));

import {
  createOffer,
  updateOffer,
  setOfferStatus,
  deleteOffer,
  type OfferFormData,
} from "./offer-actions";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import {
  assertCanActivateOffer,
  storeAllowsPlanFeature,
  PlanEntitlementError,
} from "@/lib/plans/entitlements";
import { makeDbMock } from "./_test-helpers";
import { offers } from "@/drizzle/schema";

const form = (over: Partial<OfferFormData> = {}): OfferFormData => ({
  name: "Launch week",
  description: "",
  status: "disabled",
  delivery: "automatic",
  code: "",
  priority: 0,
  triggerType: "always",
  minSubtotal: 0,
  rewardType: "percent_off",
  percent: 10,
  amount: 0,
  unitPrice: 0,
  buyQuantity: 1,
  getQuantity: 1,
  getPercent: 100,
  maxSets: 1,
  tierMode: "percent",
  tiers: [],
  breaks: [],
  conditions: [],
  giftProductId: "",
  giftVariantId: null,
  giftQuantity: 1,
  bundleQuantity: 3,
  bundlePrice: 999,
  creditAmount: 100,
  channels: [],
  validFrom: "",
  validUntil: "",
  maxRedemptions: 0,
  maxPerCustomer: 0,
  budget: 0,
  locationIds: [],
  groupIds: [],
  productIds: [],
  variantIds: [],
  categoryIds: [],
  ...over,
});

/** The values written to `offers` by the last insert/update. */
const written = () => dbHolder.current.calls.values[0];

describe("offer actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ returning: [{ id: "offer-1" }] });
    vi.mocked(getManagerIdentity).mockResolvedValue({
      uid: "admin-1",
      email: "a@b.c",
    } as any);
    vi.mocked(storeAllowsPlanFeature).mockResolvedValue(true);
    vi.mocked(assertCanActivateOffer).mockResolvedValue(undefined);
  });

  describe("the gate", () => {
    it("refuses every write without the promotions grant", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      for (const res of [
        await createOffer(form()),
        await updateOffer("o1", form()),
        await setOfferStatus("o1", "active"),
        await deleteOffer("o1"),
      ]) {
        expect(res.error).toBe("Not authenticated");
      }
    });

    it("★ gates on `promotions`, the key roles actually store", async () => {
      await createOffer(form());
      // Renaming this to "offers" would silently revoke the grant on every
      // saved role — the `navigation` precedent.
      expect(getManagerIdentity).toHaveBeenCalledWith("promotions");
    });
  });

  describe("validation", () => {
    it("requires a name", async () => {
      expect((await createOffer(form({ name: "  " }))).error).toMatch(/name/i);
    });

    it("requires a percentage above zero and at most 100", async () => {
      expect((await createOffer(form({ percent: 0 }))).error).toMatch(
        /above zero/i,
      );
      expect((await createOffer(form({ percent: 150 }))).error).toMatch(
        /exceed 100/i,
      );
    });

    it("requires an amount for an amount-off offer", async () => {
      const res = await createOffer(
        form({ rewardType: "amount_off", amount: 0 }),
      );
      expect(res.error).toMatch(/above zero/i);
    });

    it("requires a code when one is the delivery method", async () => {
      expect(
        (await createOffer(form({ delivery: "code", code: "" }))).error,
      ).toMatch(/enter a discount code/i);
    });

    it("refuses a code on an automatic offer rather than ignoring it", async () => {
      const res = await createOffer(form({ delivery: "automatic", code: "X" }));
      expect(res.error).toMatch(/applies without a code/i);
    });

    it("★ holds NEW codes to 3 characters while the column accepts 1", async () => {
      // The column has to accept one- and two-character codes, because
      // `coupons.code` never had a length rule and live ones exist. A friendlier
      // minimum for new offers belongs here, where it can change freely.
      expect(
        (await createOffer(form({ delivery: "code", code: "AB" }))).error,
      ).toMatch(/at least 3/i);
    });

    it("refuses an end date before the start", async () => {
      const res = await createOffer(
        form({ validFrom: "2026-10-01", validUntil: "2026-09-01" }),
      );
      expect(res.error).toMatch(/after the start/i);
    });

    it("refuses a negative limit", async () => {
      expect((await createOffer(form({ budget: -5 }))).error).toMatch(
        /valid budget/i,
      );
    });
  });

  describe("what gets stored", () => {
    it("★ 0 means UNLIMITED and must store as NULL, never a cap of zero", async () => {
      await createOffer(
        form({ maxRedemptions: 0, maxPerCustomer: 0, budget: 0 }),
      );
      const row = written();
      // A cap of zero reads as "nobody may use this" — the exact trap
      // `coupons.max_uses = 0` sets for the migration.
      expect(row.maxRedemptions).toBeNull();
      expect(row.maxPerCustomer).toBeNull();
      expect(row.budgetPaise).toBeNull();
    });

    it("stores a real limit, and the budget in PAISE", async () => {
      await createOffer(form({ maxRedemptions: 25, budget: 5000 }));
      const row = written();
      expect(row.maxRedemptions).toBe(25);
      expect(row.budgetPaise).toBe(500000);
    });

    it("normalizes a code to uppercase with no spaces", async () => {
      await createOffer(form({ delivery: "code", code: " la unch10 " }));
      expect(written().code).toBe("LAUNCH10");
    });

    it("stores no code at all for an automatic offer", async () => {
      await createOffer(form());
      expect(written().code).toBeNull();
    });

    it("puts the trigger and reward in their own configs", async () => {
      await createOffer(
        form({ triggerType: "min_subtotal", minSubtotal: 1000, percent: 20 }),
      );
      const row = written();
      expect(row.triggerType).toBe("min_subtotal");
      expect(row.triggerConfig).toEqual({ minSubtotal: 1000 });
      expect(row.rewardConfig).toEqual({ percent: 20 });
    });

    it("carries an empty trigger config for an unconditional offer", async () => {
      await createOffer(form({ triggerType: "always" }));
      expect(written().triggerConfig).toEqual({});
    });

    it("clamps priority to the column's range", async () => {
      await createOffer(form({ priority: 99999 }));
      expect(written().priority).toBe(1000);
    });

    it("always stores the acting store, never one from the form", async () => {
      await createOffer(form());
      expect(written().storeId).toBe(STORE);
    });
  });

  describe("plan gates", () => {
    it("★ checks the offer cap INSIDE the write, only when activating", async () => {
      await createOffer(form({ status: "disabled" }));
      expect(assertCanActivateOffer).not.toHaveBeenCalled();

      await createOffer(form({ status: "active" }));
      expect(assertCanActivateOffer).toHaveBeenCalledWith(
        expect.anything(),
        STORE,
      );
    });

    it("excludes the offer being edited from its own cap check", async () => {
      await updateOffer("offer-9", form({ status: "active" }));
      expect(assertCanActivateOffer).toHaveBeenCalledWith(
        expect.anything(),
        STORE,
        "offer-9",
      );
    });

    it("reports a plan refusal in the merchant's words", async () => {
      vi.mocked(assertCanActivateOffer).mockRejectedValue(
        new PlanEntitlementError("Free includes up to 3 active offers."),
      );
      const res = await createOffer(form({ status: "active" }));
      expect(res.error).toMatch(/3 active offers/);
    });

    it("refuses group targeting below Basic", async () => {
      vi.mocked(storeAllowsPlanFeature).mockResolvedValue(false);
      const res = await createOffer(form({ groupIds: ["g1"] }));
      expect(res.error).toMatch(/Basic and Pro/);
    });

    it("does not consult the group gate when no group is targeted", async () => {
      await createOffer(form({ groupIds: [] }));
      expect(storeAllowsPlanFeature).not.toHaveBeenCalled();
    });
  });

  describe("pausing and deleting", () => {
    it("pauses without re-validating the form", async () => {
      // Pausing a runaway offer is done in a hurry; it must not be able to fail
      // because an unrelated field is now invalid.
      const res = await setOfferStatus("offer-1", "disabled");
      expect(res.success).toBe(true);
      expect(assertCanActivateOffer).not.toHaveBeenCalled();
    });

    it("checks the cap when activating from the list", async () => {
      await setOfferStatus("offer-1", "active");
      expect(assertCanActivateOffer).toHaveBeenCalledWith(
        expect.anything(),
        STORE,
        "offer-1",
      );
    });

    it("reports a missing offer rather than a silent success", async () => {
      dbHolder.current = makeDbMock({ returning: [] });
      expect((await setOfferStatus("nope", "active")).error).toMatch(
        /not found/i,
      );
      dbHolder.current = makeDbMock({ returning: [] });
      expect((await deleteOffer("nope")).error).toMatch(/not found/i);
      dbHolder.current = makeDbMock({ returning: [] });
      expect((await updateOffer("nope", form())).error).toMatch(/not found/i);
    });

    it("surfaces a duplicate code as a message, not a raw db error", async () => {
      dbHolder.current = makeDbMock({ failInsertFor: [offers] });
      const res = await createOffer(form({ delivery: "code", code: "DUPE" }));
      expect(res.error).toBeTruthy();
      expect(res.error).not.toMatch(/violates|constraint/i);
    });
  });

  describe("extra conditions (Phase E)", () => {
    it("stores the conditions it understands", async () => {
      await createOffer(
        form({
          channels: ["storefront"],
          conditions: [
            { type: "first_order" },
            { type: "payment_method", methods: ["razorpay"] },
          ],
        }),
      );
      expect(written().conditions).toEqual([
        { type: "first_order" },
        { type: "payment_method", methods: ["razorpay"] },
      ]);
    });

    it("defaults to no conditions", async () => {
      await createOffer(form());
      expect(written().conditions).toEqual([]);
    });

    it("★ REFUSES a website-only condition on an offer that reaches the register", async () => {
      // Not saved-and-silently-ignored: §23's rule that a control which always
      // fails is worse than no control. The till quotes the total before
      // payment is staged, so a tender-dependent discount cannot work there.
      const res = await createOffer(
        form({
          channels: ["pos"],
          conditions: [{ type: "payment_method", methods: ["razorpay"] }],
        }),
      );
      expect(res.error).toMatch(/only works on your website/i);
    });

    it("★ REFUSES it when NO channel is set, because that means every channel", async () => {
      const res = await createOffer(
        form({
          channels: [],
          conditions: [{ type: "fulfilment_type", fulfilment: ["pickup"] }],
        }),
      );
      expect(res.error).toMatch(/only works on your website/i);
    });

    it("allows first-order and time conditions on a register offer", async () => {
      const res = await createOffer(
        form({
          channels: ["pos"],
          conditions: [
            { type: "first_order" },
            {
              type: "time_window",
              days: [1, 2],
              startMinute: 600,
              endMinute: 720,
            },
          ],
        }),
      );
      expect(res.error).toBeUndefined();
    });

    it("refuses the same condition twice", async () => {
      const res = await createOffer(
        form({
          channels: ["storefront"],
          conditions: [{ type: "first_order" }, { type: "first_order" }],
        }),
      );
      expect(res.error).toMatch(/once/i);
    });

    it("★ reports the CONDITION problem before an unrelated reward one", async () => {
      // A form that reports the wrong problem first sends people to fix the
      // wrong field.
      const res = await createOffer(
        form({
          channels: ["pos"],
          conditions: [{ type: "payment_method", methods: ["razorpay"] }],
          rewardType: "percent_off",
          percent: 0,
        }),
      );
      expect(res.error).toMatch(/only works on your website/i);
    });
  });

  describe("buy X get Y (Phase C)", () => {
    const bxgy = (over: Partial<OfferFormData> = {}) =>
      form({
        rewardType: "buy_x_get_y",
        categoryIds: ["cat-1"],
        buyQuantity: 1,
        getQuantity: 1,
        getPercent: 100,
        maxSets: 1,
        ...over,
      });

    it("stores the quantities and the discount on the free units", async () => {
      await createOffer(
        bxgy({ buyQuantity: 2, getQuantity: 1, getPercent: 50 }),
      );
      expect(written().rewardConfig).toEqual({
        buyQuantity: 2,
        getQuantity: 1,
        getPercent: 50,
        maxSets: 1,
      });
    });

    it("★ maxSets of 0 means NO LIMIT and is stored absent, not as zero", async () => {
      await createOffer(bxgy({ maxSets: 0 }));
      const cfg = written().rewardConfig as Record<string, unknown>;
      expect("maxSets" in cfg).toBe(false);
    });

    it("defaults the free units to 100% off when left blank", async () => {
      await createOffer(bxgy({ getPercent: 0 }));
      expect(
        (written().rewardConfig as { getPercent: number }).getPercent,
      ).toBe(100);
    });

    it("refuses a quantity below one", async () => {
      expect((await createOffer(bxgy({ buyQuantity: 0 }))).error).toMatch(
        /how many to buy/i,
      );
    });

    it("refuses a discount above 100%", async () => {
      expect((await createOffer(bxgy({ getPercent: 150 }))).error).toMatch(
        /between 1% and 100%/i,
      );
    });

    it("★ refuses one with no products chosen — it would cover the catalogue", async () => {
      const res = await createOffer(bxgy({ categoryIds: [] }));
      expect(res.error).toMatch(/Choose the products or categories/i);
    });
  });

  describe("product scoping (Phase B)", () => {
    it("stores one row per target", async () => {
      await createOffer(
        form({
          rewardType: "percent_off_items",
          productIds: ["p1", "p2"],
          categoryIds: ["c1"],
        }),
      );
      // offers insert first, then the scope rows.
      const scopeInsert = dbHolder.current.calls.values[1];
      expect(
        Array.isArray(scopeInsert) ? scopeInsert : [scopeInsert],
      ).toHaveLength(3);
    });

    it("★ refuses a line-level reward with no scope", async () => {
      const res = await createOffer(form({ rewardType: "percent_off_items" }));
      expect(res.error).toMatch(/Choose the products or categories/i);
    });

    it("refuses a basket condition with no scope", async () => {
      const res = await createOffer(form({ triggerType: "contains_category" }));
      expect(res.error).toMatch(/products or categories/i);
    });

    it("an order-level reward still needs no scope", async () => {
      expect((await createOffer(form())).success).toBe(true);
    });

    it("stores a fixed price per unit", async () => {
      await createOffer(
        form({
          rewardType: "fixed_price",
          unitPrice: 499,
          categoryIds: ["c1"],
        }),
      );
      expect(written().rewardConfig).toEqual({ unitPrice: 499 });
    });

    it("refuses a fixed price of zero — a free item needs stock reserved", async () => {
      const res = await createOffer(
        form({ rewardType: "fixed_price", unitPrice: 0, categoryIds: ["c1"] }),
      );
      expect(res.error).toMatch(/above zero/i);
    });
  });
});

describe("★★ the reward types that could not be saved at all", () => {
  /**
   * `validateForm` assembled a SECOND reward object to hand `validateOfferRule`
   * and never listed the gift, bundle or cashback fields. They arrived as
   * `undefined`, so the validator's own checks fired every time: a merchant who
   * had correctly picked a gift product was told "Choose the free gift", and
   * Phase G plus half of Phase H could not be created or edited at all.
   *
   * Validation now runs over `decodeReward(type, rewardConfigFor(form))` — the
   * literal jsonb the row will carry — so the two cannot disagree again.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ returning: [{ id: "offer-1" }] });
    vi.mocked(getManagerIdentity).mockResolvedValue({
      uid: "admin-1",
      email: "a@b.c",
    } as any);
    vi.mocked(storeAllowsPlanFeature).mockResolvedValue(true);
    vi.mocked(assertCanActivateOffer).mockResolvedValue(undefined);
  });

  const GIFT = "11111111-2222-4333-8444-555555555555";

  it("saves a free-gift offer, and stores the gift it was given", async () => {
    const res = await createOffer(
      form({
        rewardType: "free_item",
        giftProductId: GIFT,
        giftQuantity: 2,
        productIds: [GIFT],
      }),
    );
    expect(res.error).toBeUndefined();
    expect(written().rewardConfig).toEqual({
      giftProductId: GIFT,
      giftQuantity: 2,
    });
  });

  it("saves a bundle price", async () => {
    const res = await createOffer(
      form({
        rewardType: "bundle_price",
        bundleQuantity: 3,
        bundlePrice: 999,
        maxSets: 0,
        categoryIds: ["c1"],
      }),
    );
    expect(res.error).toBeUndefined();
    expect(written().rewardConfig).toMatchObject({
      bundleQuantity: 3,
      bundlePrice: 999,
    });
  });

  it("saves cashback", async () => {
    const res = await createOffer(
      form({ rewardType: "credit_back", creditAmount: 100 }),
    );
    expect(res.error).toBeUndefined();
    expect(written().rewardConfig).toEqual({ creditAmount: 100 });
  });

  it("★ still refuses a gift offer with no gift chosen", async () => {
    // The fix must not be "stop validating" — an empty product is still the
    // one thing this reward cannot be saved without.
    const res = await createOffer(
      form({ rewardType: "free_item", giftProductId: "", productIds: ["p1"] }),
    );
    expect(res.error).toBe("Choose the free gift.");
  });

  it("★ still refuses a bundle of one", async () => {
    const res = await createOffer(
      form({
        rewardType: "bundle_price",
        bundleQuantity: 1,
        categoryIds: ["c"],
      }),
    );
    expect(res.error).toBe("A bundle is between two and twenty items.");
  });

  it("★ still refuses cashback of zero", async () => {
    const res = await createOffer(
      form({ rewardType: "credit_back", creditAmount: 0 }),
    );
    expect(res.error).toBe("Enter how much store credit to give.");
  });

  it("★ validates the trigger the row will actually carry", async () => {
    // A contents trigger with nothing scoped is refused, and the reason names
    // the scope rather than some unrelated field.
    const res = await createOffer(
      form({
        rewardType: "amount_off",
        amount: 100,
        triggerType: "contains_product",
      }),
    );
    expect(res.error).toBeTruthy();
    expect(written()).toBeUndefined();
  });
});
