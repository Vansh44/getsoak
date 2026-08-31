import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("renders permission-safe inventory choices as one-click follow-ups", () => {
    const onPrompt = vi.fn();
    const artifact: MinkArtifact = {
      type: "clarification",
      title: "Choose inventory scope",
      question: "Stock can differ by location. Which scope should I use?",
      choices: [
        {
          label: "Compare locations",
          description: "See location counts side by side.",
          prompt: "Compare inventory by location",
        },
        { label: "Shop", prompt: "Show Shop inventory" },
      ],
    };

    render(<MinkArtifacts artifacts={[artifact]} onPrompt={onPrompt} />);
    fireEvent.click(screen.getByRole("button", { name: /shop/i }));
    expect(onPrompt).toHaveBeenCalledWith("Show Shop inventory");
  });

  it("does not present an untracked zero as an in-stock quantity", () => {
    const artifact: MinkArtifact = {
      type: "catalog",
      title: "Catalogue & inventory",
      counts: {
        total: 1,
        published: 1,
        unpublished: 0,
        draft: 0,
        archived: 0,
        inventoryItems: 1,
        lowStock: 0,
        outOfStock: 0,
      },
      items: [
        {
          id: "product-1",
          title: "Carrots",
          sku: "SKU-CARROTS",
          publicationStatus: "published",
          publicationTags: ["published"],
          inventoryStatus: "untracked",
          stock: 0,
          threshold: 5,
        },
      ],
      filters: [{ label: "Inventory", value: "Shop" }],
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    expect(screen.getByText("Not tracked")).toBeVisible();
    expect(screen.queryByText("in stock")).toBeNull();
  });

  it("renders location comparisons without an empty product-list fallback", () => {
    const artifact: MinkArtifact = {
      type: "catalog",
      title: "Catalogue & inventory",
      counts: {
        total: 14,
        published: 14,
        unpublished: 0,
        draft: 0,
        archived: 0,
        inventoryItems: 16,
        lowStock: null,
        outOfStock: null,
      },
      items: [],
      locations: [
        {
          id: "shop-1",
          name: "Shop",
          type: "shop",
          inventoryItems: 16,
          trackedItems: 9,
          lowStock: 1,
          outOfStock: 2,
          dashboardPath: "/dashboard/inventory?location=shop-1",
          prompt: "Show Shop inventory",
        },
      ],
      filters: [{ label: "Inventory", value: "Each accessible location" }],
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    expect(screen.getByText("Inventory by location")).toBeVisible();
    expect(
      screen.getByText(
        (_content, element) => element?.textContent === "shop · 9 tracked SKUs",
      ),
    ).toBeVisible();
    expect(screen.queryByText("No matching products or variants.")).toBeNull();
  });
});
