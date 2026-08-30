import { describe, expect, it } from "vitest";
import { minkCustomerLabel } from "./order-tools";

describe("minkCustomerLabel", () => {
  it("hides identity when the actor cannot view customers", () => {
    expect(
      minkCustomerLabel(
        { permissions: { orders: ["view"] }, isSuperadmin: false },
        { firstName: "Asha", lastName: "Singh" },
      ),
    ).toBe("Customer details hidden");
  });

  it("minimizes identity even when the actor may view customers", () => {
    expect(
      minkCustomerLabel(
        { permissions: { users: ["view"] }, isSuperadmin: false },
        { firstName: "Asha", lastName: "Singh" },
      ),
    ).toBe("Asha S.");
  });
});
