import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ThemesPage from "./page";

describe("public theme catalog", () => {
  it("renders catalog metadata and never links an unhealthy demo", async () => {
    render(await ThemesPage({ searchParams: Promise.resolve({}) }));

    expect(
      screen.getByRole("heading", {
        name: /make your store feel like your brand/i,
      }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Basket" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Studio" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Ritual" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Home & Decor" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Beauty" })).toBeNull();
    expect(screen.getByText("Live preview being restored")).toBeVisible();
    expect(screen.queryByRole("link", { name: /view live store/i })).toBeNull();
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
});
