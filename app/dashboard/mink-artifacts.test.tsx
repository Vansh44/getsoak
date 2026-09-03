import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinkArtifact } from "@/lib/mink/types";
import { MinkArtifacts } from "./mink-artifacts";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("polls and renders a completed durable workflow with safe dashboard links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          workflow: {
            id: "11111111-1111-4111-8111-111111111111",
            template: "weekly_trading_report",
            status: "completed",
            currentStep: 3,
            totalSteps: 3,
            attemptCount: 3,
            errorCode: null,
            errorDetail: null,
            cancelRequested: false,
            result: {
              rangeLabel: "Last 7 days",
              comparisonLabel: "Previous 7 days",
              fromInclusive: "2026-08-25T00:00:00.000Z",
              toExclusive: "2026-09-01T00:00:00.000Z",
              timeZone: "Asia/Kolkata",
              currency: "INR",
              locationLabel: "Shop",
              netSales: 12500,
              netSalesTrendPercent: 12.5,
              orders: 20,
              ordersTrendPercent: 10,
              averageOrderValue: 625,
              averageOrderValueTrendPercent: 2,
              unitsSold: 31,
              unitsSoldTrendPercent: 8,
              topProducts: [
                {
                  id: "product-1",
                  name: "Basmati Rice",
                  units: 12,
                  amount: 4800,
                  dashboardPath: "https://attacker.example/product",
                },
              ],
              channels: [],
              dataAsOf: "2026-09-01T00:01:00.000Z",
              highlights: ["Net sales grew 12.5% versus the previous period."],
              analyticsPath: "/dashboard/analytics?range=7d&compare=previous",
            },
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:01:00.000Z",
            completedAt: "2026-09-01T00:01:00.000Z",
          },
        }),
      }),
    );
    const artifact: MinkArtifact = {
      type: "workflow",
      runId: "11111111-1111-4111-8111-111111111111",
      template: "weekly_trading_report",
      title: "Weekly trading report",
      description: "A durable report.",
      status: "queued",
      currentStep: 0,
      totalSteps: 3,
    };

    render(<MinkArtifacts artifacts={[artifact]} />);
    expect(screen.getByText(/Queued for background processing/i)).toBeVisible();
    await waitFor(() => expect(screen.getByText("₹12,500.00")).toBeVisible());
    expect(screen.getByRole("link", { name: /Basmati Rice/i })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(
      screen.getByRole("link", { name: /Open Analytics/i }),
    ).toHaveAttribute("href", "/dashboard/analytics?range=7d&compare=previous");
  });
});
