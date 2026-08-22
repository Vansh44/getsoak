import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ThemesPage from "./page";
import {
  THEME_META,
  canPreviewTheme,
  isThemeSelectable,
} from "@/lib/themes/meta";

// Derived from THEME_META rather than hardcoded: these assertions are about the
// catalog's RULES (only a healthy demo is linked; the showcase leads with the
// public themes), not about which themes happen to exist today. Publishing a
// theme used to break both of these with no rule having changed.
const selectable = THEME_META.filter(isThemeSelectable);
const showcaseOrder = [
  ...selectable.filter((t) => t.catalog.visibility === "public"),
  ...selectable.filter((t) => t.catalog.visibility !== "public"),
];

describe("public theme catalog", () => {
  it("renders catalog metadata and never links an unhealthy demo", async () => {
    render(await ThemesPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("heading", {
        name: /make your store impossible to scroll past/i,
      }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Basket" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Studio" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ritual" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Vitrine" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Home & Decor" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Beauty" })).toBeVisible();
    expect(screen.getByText("Live preview being restored")).toBeVisible();
    // Exactly the themes with a healthy demo get a live link — no more, no
    // fewer — and each points at that theme's own demo host.
    expect(
      screen
        .getAllByRole("link", { name: /view live store/i })
        .map((link) => link.getAttribute("href"))
        .sort(),
    ).toEqual(
      selectable
        .filter(canPreviewTheme)
        .map((t) => `https://${t.demo.slug}.storemink.com`)
        .sort(),
    );
    expect(selectable.some((t) => !canPreviewTheme(t))).toBe(true);
    expect(
      screen.getByRole("link", { name: /start with basket/i }),
    ).toHaveAttribute("href", "https://storemink.com/signup");
  });

  it("supports server-rendered industry filters", async () => {
    render(
      await ThemesPage({
        searchParams: Promise.resolve({ industry: "food-and-drink" }),
      }),
    );

    expect(
      screen.getByRole("link", { name: "Food & Beverages" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Basket" })).toBeVisible();
  });

  it("automatically rotates catalog-driven showcases and keeps manual controls", async () => {
    vi.useFakeTimers();

    try {
      render(await ThemesPage({ searchParams: Promise.resolve({}) }));

      const [first, second] = showcaseOrder;
      expect(
        screen.getByRole("button", { name: `Show ${first.name} theme` }),
      ).toHaveAttribute("aria-pressed", "true");

      act(() => vi.advanceTimersByTime(5_200));

      expect(
        screen.getByRole("button", { name: `Show ${second.name} theme` }),
      ).toHaveAttribute("aria-pressed", "true");

      // The hero dots and the closing gallery are independent rotators, so
      // picking a dot must not move the gallery.
      const last = showcaseOrder[showcaseOrder.length - 1];
      fireEvent.click(
        screen.getByRole("button", { name: `Show ${last.name} theme` }),
      );
      expect(
        screen.getByRole("button", { name: `Show ${last.name} theme` }),
      ).toHaveAttribute("aria-pressed", "true");

      // The gallery is still on the second theme; advancing it lands on the
      // third, regardless of how many themes the catalog holds.
      const third = showcaseOrder[2];
      fireEvent.click(
        screen.getByRole("button", {
          name: `Showing ${second.name}. Show next theme`,
        }),
      );
      expect(
        screen.getByRole("button", {
          name: `Showing ${third.name}. Show next theme`,
        }),
      ).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });
});
