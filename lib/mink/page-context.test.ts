import { describe, expect, it } from "vitest";
import { normalizeMinkPageContext } from "./page-context";

const ID = "10000000-0000-4000-8000-000000000001";

describe("normalizeMinkPageContext", () => {
  it("keeps bounded dashboard context and a supported selected record", () => {
    expect(
      normalizeMinkPageContext({
        currentPath: "/dashboard/products/one?tab=inventory",
        selectedResource: { type: "product", id: ID },
      }),
    ).toEqual({
      currentPath: "/dashboard/products/one?tab=inventory",
      selectedResource: { type: "product", id: ID },
    });
  });

  it("drops foreign paths, malformed ids, and unsupported resource types", () => {
    expect(
      normalizeMinkPageContext({
        currentPath: "https://attacker.example/dashboard",
        selectedResource: { type: "customer", id: "not-an-id" },
      }),
    ).toEqual({ currentPath: null, selectedResource: null });
    expect(
      normalizeMinkPageContext({ currentPath: "/dashboard-attacker" }),
    ).toEqual({ currentPath: null, selectedResource: null });
  });
});
