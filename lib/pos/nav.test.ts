import { describe, expect, it } from "vitest";
import { POS_NAV, activePosNavKey, posNavFor } from "./nav";
import { posCan, type PosActorRole } from "./permissions";

const ROLES: PosActorRole[] = ["cashier", "manager", "owner", "superadmin"];

describe("POS navigation registry", () => {
  it("gives every destination a unique key and href", () => {
    expect(new Set(POS_NAV.map((i) => i.key)).size).toBe(POS_NAV.length);
    expect(new Set(POS_NAV.map((i) => i.href)).size).toBe(POS_NAV.length);
  });

  it("points every destination at a /pos route", () => {
    for (const item of POS_NAV) expect(item.href).toMatch(/^\/pos\//);
  });

  it("never shows a door the role would be turned away at", () => {
    // The whole point of the registry: the rail is derived from the same
    // posCan() the page's own redirect uses, so the two cannot drift.
    for (const role of ROLES) {
      for (const item of posNavFor(role)) {
        expect(posCan(role, item.cap)).toBe(true);
      }
    }
  });

  describe("what each role sees", () => {
    it("gives a cashier the counter, and not the stockroom", () => {
      const keys = posNavFor("cashier").map((i) => i.key);
      // Sell, hand over a collection, reprint a receipt, see whether the drawer
      // is open. NOT stock — a cashier sells stock but does not get to declare
      // how much of it exists (app/pos/inventory/page.tsx redirects them).
      expect(keys).toEqual(["sell", "orders", "sales", "shift"]);
    });

    it("gives a manager everything", () => {
      expect(posNavFor("manager").map((i) => i.key)).toEqual(
        POS_NAV.map((i) => i.key),
      );
    });

    it("gives an owner and a superadmin everything", () => {
      // A delegated admin is barred only from the money-losing capabilities
      // (SUPERADMIN_ONLY), none of which opens a screen — so their rail is full.
      expect(posNavFor("owner").map((i) => i.key)).toEqual(
        POS_NAV.map((i) => i.key),
      );
      expect(posNavFor("superadmin").map((i) => i.key)).toEqual(
        POS_NAV.map((i) => i.key),
      );
    });

    it("shows a cashier Orders — they are the ones who hand collections over", () => {
      // Regression: gating this door on `refund` (the strongest thing on the
      // screen) would hide the collection queue from exactly the person who
      // works it, with the customer standing at the counter.
      expect(posNavFor("cashier").map((i) => i.key)).toContain("orders");
      expect(posCan("cashier", "refund")).toBe(false);
    });
  });

  describe("activePosNavKey", () => {
    it("matches each destination's own route", () => {
      for (const item of POS_NAV) {
        expect(activePosNavKey(item.href)).toBe(item.key);
      }
    });

    it("keeps Orders lit on the return detail screen", () => {
      // /pos/returns/<id> is reached FROM Orders; without this the rail goes
      // blank the moment you open the return you just searched for.
      expect(activePosNavKey("/pos/returns/abc-123")).toBe("orders");
      expect(activePosNavKey("/pos/returns")).toBe("orders");
      expect(activePosNavKey("/pos/pickups")).toBe("orders");
    });

    it("has no active destination on the signed-out screens", () => {
      // There is no rail there — no operator to draw one for.
      expect(activePosNavKey("/pos/login")).toBeNull();
      expect(activePosNavKey("/pos/register")).toBeNull();
      expect(activePosNavKey("/pos/reset")).toBeNull();
      expect(activePosNavKey("/pos")).toBeNull();
    });

    it("does not let one route's prefix light up another", () => {
      // "/pos/sales" must not match "/pos/sale…"-shaped guesses, and a deeper
      // path only counts on a segment boundary.
      expect(activePosNavKey("/pos/sell")).toBe("sell");
      expect(activePosNavKey("/pos/sales")).toBe("sales");
      expect(activePosNavKey("/pos/selling-guide")).toBeNull();
    });
  });
});
