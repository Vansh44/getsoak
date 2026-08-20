import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MerchantTracking } from "./merchant-tracking";

vi.mock("next/navigation", () => ({ usePathname: () => "/products" }));
vi.mock("next/script", () => ({
  default: ({ id }: { id: string }) => <script data-testid={id} />,
}));

describe("MerchantTracking consent gate", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("does not render either provider before consent", async () => {
    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId="G-ABC12345"
        metaPixelId="1234567890"
      />,
    );

    expect(
      await screen.findByRole("dialog", { name: /privacy choices/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /privacy policy/i }),
    ).toHaveAttribute("href", "/privacy-policy");
    expect(screen.queryByTestId(/sm-ga4/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(/sm-meta/)).not.toBeInTheDocument();
  });

  it("loads only after opt-in and lets the visitor revoke it", async () => {
    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId="G-ABC12345"
        metaPixelId="1234567890"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Accept all" }));
    expect(await screen.findByTestId(/sm-ga4-init/)).toBeInTheDocument();
    expect(screen.getByTestId(/sm-meta-pixel/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Privacy choices" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject optional" }));

    await waitFor(() => {
      expect(screen.queryByTestId(/sm-ga4/)).not.toBeInTheDocument();
      expect(screen.queryByTestId(/sm-meta/)).not.toBeInTheDocument();
    });
  });

  it("keeps analytics and marketing consent independent", async () => {
    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId="G-ABC12345"
        metaPixelId="1234567890"
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Manage choices" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Analytics/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save choices" }));

    expect(await screen.findByTestId(/sm-ga4-init/)).toBeInTheDocument();
    expect(screen.queryByTestId(/sm-meta/)).not.toBeInTheDocument();
  });

  it("restores a saved browser choice", async () => {
    localStorage.setItem(
      "sm.storefront-tracking-consent.v1",
      JSON.stringify({
        version: 1,
        analytics: false,
        marketing: true,
        decidedAt: "2026-08-20T12:00:00.000Z",
      }),
    );

    render(
      <MerchantTracking
        storeName="Echoes"
        ga4MeasurementId="G-ABC12345"
        metaPixelId="1234567890"
      />,
    );

    expect(await screen.findByTestId(/sm-meta-pixel/)).toBeInTheDocument();
    expect(screen.queryByTestId(/sm-ga4/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
