import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkArtifacts } from "./mink-artifacts";

describe("Mink catalogue artifact", () => {
  it("renders product and SKU counts with inspectable publication and stock tags", () => {
    const artifact: MinkArtifact = {
      type: "catalog",
      title: "Catalogue & inventory",
      counts: {
        total: 8,
        published: 6,
        unpublished: 2,
        draft: 2,
        archived: 0,
        inventoryItems: 12,
        lowStock: 1,
        outOfStock: 4,
      },
      items: [
        {
          id: "variant-1",
          title: "Cobalt Lounge Chair",
          variant: "Bone",
          sku: "SKU10080001V026",
          publicationStatus: "published",
          publicationTags: ["published"],
          inventoryStatus: "out",
          stock: 0,
          threshold: 5,
          dashboardPath: "/dashboard/products/product-1",
        },
      ],
      filters: [
        { label: "Publication", value: "Current store" },
        { label: "Inventory", value: "Shop" },
      ],
      dashboardPath: "/dashboard/products",
      inventoryDashboardPath: "/dashboard/inventory?location=shop-1",
    };

    render(<MinkArtifacts artifacts={[artifact]} />);

    expect(screen.getByText("Unpublished")).toBeVisible();
    expect(screen.getByText("Low-stock SKUs")).toBeVisible();
    expect(screen.getByText("Out-of-stock SKUs")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Cobalt Lounge Chair" }),
    ).toHaveAttribute("href", "/dashboard/products/product-1");
    expect(screen.getByText("Published")).toBeVisible();
    expect(screen.getByText("published")).toBeVisible();
    expect(screen.getByText("Out of stock")).toBeVisible();
    expect(screen.getByText("Shop")).toBeVisible();
  });
});
