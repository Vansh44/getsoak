import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/location-actions", () => ({
  enablePos: vi.fn(),
  disablePos: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { PosOverviewClient } from "./pos-overview-client";

describe("POS overview upgrade banner", () => {
  it("shows the feature story and links to the POS product site", () => {
    render(
      <PosOverviewClient
        state={{
          plan: "basic",
          posAvailable: false,
          posEnabled: false,
          locationsIncluded: 0,
        }}
        locationCount={0}
        canManage
      />,
    );

    expect(
      screen.getByRole("heading", { name: /a faster checkout/i }),
    ).toBeVisible();
    expect(screen.getByText("Barcode-fast checkout")).toBeVisible();
    expect(screen.getByText("Live inventory sync")).toBeVisible();

    expect(
      screen.getByRole("link", { name: "Upgrade to Pro" }),
    ).toHaveAttribute("href", "/dashboard/plans");
    const productLink = screen.getByRole("link", {
      name: "Explore all POS features",
    });
    expect(productLink).toHaveAttribute("href", "https://pos.storemink.com");
    expect(productLink).toHaveAttribute("target", "_blank");
    expect(productLink).toHaveAttribute("rel", "noopener noreferrer");
  });
});
