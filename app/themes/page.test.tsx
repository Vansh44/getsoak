import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ThemesPage from "./page";

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
    expect(screen.getByRole("link", { name: "Home & Decor" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Beauty" })).toBeVisible();
    expect(screen.getByText("Live preview being restored")).toBeVisible();
    expect(
      screen
        .getAllByRole("link", { name: /view live store/i })
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "https://demo-studio.storemink.com",
      "https://demo-ritual.storemink.com",
    ]);
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

      expect(
        screen.getByRole("button", { name: "Show Studio theme" }),
      ).toHaveAttribute("aria-pressed", "true");

      act(() => vi.advanceTimersByTime(5_200));

      expect(
        screen.getByRole("button", { name: "Show Ritual theme" }),
      ).toHaveAttribute("aria-pressed", "true");

      fireEvent.click(
        screen.getByRole("button", { name: "Show Basket theme" }),
      );
      expect(
        screen.getByRole("button", { name: "Show Basket theme" }),
      ).toHaveAttribute("aria-pressed", "true");

      fireEvent.click(
        screen.getByRole("button", {
          name: "Showing Ritual. Show next theme",
        }),
      );
      expect(
        screen.getByRole("button", {
          name: "Showing Basket. Show next theme",
        }),
      ).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });
});
