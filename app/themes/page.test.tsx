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
});
