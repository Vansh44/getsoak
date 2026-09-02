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
  channels: [],
  validFrom: "",
  validUntil: "",
  maxRedemptions: 0,
  maxPerCustomer: 0,
  budget: 0,
  locationIds: [],
  groupIds: [],
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
});
