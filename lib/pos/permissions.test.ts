import { describe, it, expect } from "vitest";
import { posCan, isPosRole } from "./permissions";

describe("pos permissions", () => {
  it("owner can do everything", () => {
    expect(posCan("owner", "sell")).toBe(true);
    expect(posCan("owner", "refund")).toBe(true);
    expect(posCan("owner", "manage_staff")).toBe(true);
    expect(posCan("owner", "adjust_inventory")).toBe(true);
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

  it("isPosRole narrows correctly", () => {
    expect(isPosRole("cashier")).toBe(true);
    expect(isPosRole("manager")).toBe(true);
    expect(isPosRole("owner")).toBe(false);
    expect(isPosRole("superadmin")).toBe(false);
    expect(isPosRole(null)).toBe(false);
    expect(isPosRole(42)).toBe(false);
  });
});
