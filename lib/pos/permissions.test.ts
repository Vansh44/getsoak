import { describe, it, expect } from "vitest";
import { posCan, isIdleLockExempt, isPosRole } from "./permissions";

describe("pos permissions", () => {
  it("superadmin can do everything", () => {
    expect(posCan("superadmin", "sell")).toBe(true);
    expect(posCan("superadmin", "refund")).toBe(true);
    expect(posCan("superadmin", "manage_staff")).toBe(true);
    expect(posCan("superadmin", "adjust_inventory")).toBe(true);
    expect(posCan("superadmin", "discount")).toBe(true);
    expect(posCan("superadmin", "price_override")).toBe(true);
    expect(posCan("superadmin", "authorize_device")).toBe(true);
  });

  it("a delegated dashboard admin runs the till but cannot give money away", () => {
    expect(posCan("owner", "sell")).toBe(true);
    expect(posCan("owner", "refund")).toBe(true);
    expect(posCan("owner", "manage_staff")).toBe(true);
    expect(posCan("owner", "adjust_inventory")).toBe(true);
    // ★ The narrowing: POS access can be delegated, giving money away cannot —
    // nor can handing a browser the ability to take money in the first place.
    expect(posCan("owner", "discount")).toBe(false);
    expect(posCan("owner", "price_override")).toBe(false);
    expect(posCan("owner", "authorize_device")).toBe(false);
  });

  it("cashier can only sell", () => {
    expect(posCan("cashier", "sell")).toBe(true);
    expect(posCan("cashier", "refund")).toBe(false);
    expect(posCan("cashier", "adjust_inventory")).toBe(false);
    expect(posCan("cashier", "discount_over_cap")).toBe(false);
    expect(posCan("cashier", "open_close_shift")).toBe(false);
  });

  it("manager can sell/refund/adjust/shift but not manage staff", () => {
    expect(posCan("manager", "sell")).toBe(true);
    expect(posCan("manager", "refund")).toBe(true);
    expect(posCan("manager", "adjust_inventory")).toBe(true);
    expect(posCan("manager", "open_close_shift")).toBe(true);
    expect(posCan("manager", "discount_over_cap")).toBe(true);
    expect(posCan("manager", "manage_staff")).toBe(false);
  });

  // ★ Discounting belongs to the superadmin, and it is granted by omission from
  // both staff roles — so a new role added to CAPS can't inherit it by
  // resembling a manager. `discount_over_cap` is a DIFFERENT question (may you
  // exceed the cap) and must not be mistaken for permission to discount at all.
  it("no staff role may discount, reprice, or authorize a device", () => {
    for (const role of ["cashier", "manager"] as const) {
      expect(posCan(role, "discount")).toBe(false);
      expect(posCan(role, "price_override")).toBe(false);
      expect(posCan(role, "authorize_device")).toBe(false);
    }
    // The manager keeps the cap exemption, which only matters once a merchant
    // has switched owner-only discounts off.
    expect(posCan("manager", "discount_over_cap")).toBe(true);
  });

  // ★ ONLY the superadmin's screen may be left unattended. A delegated admin at
  // a shared counter is the same walked-away-from-an-open-till risk as any
  // operator, and their session reaches further than a cashier's.
  it("only the superadmin is exempt from the idle lock", () => {
    expect(isIdleLockExempt("superadmin")).toBe(true);
    expect(isIdleLockExempt("owner")).toBe(false);
    expect(isIdleLockExempt("manager")).toBe(false);
    expect(isIdleLockExempt("cashier")).toBe(false);
  });

  it("isPosRole narrows correctly", () => {
    expect(isPosRole("cashier")).toBe(true);
    expect(isPosRole("manager")).toBe(true);
    expect(isPosRole("owner")).toBe(false);
    expect(isPosRole("superadmin")).toBe(false);
    expect(isPosRole(null)).toBe(false);
    expect(isPosRole(42)).toBe(false);
  });
});
