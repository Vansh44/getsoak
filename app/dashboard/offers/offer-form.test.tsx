/* eslint-disable @typescript-eslint/no-explicit-any */

// The offer editor was ONE scroll of ten fieldsets — reward, trigger,
// delivery, channels, limits, dates, item scope, locations, groups, extra
// conditions — with no way to see its shape or skip a part. It is four named,
// collapsible sections now, so these pin the two properties that regrouping
// can break: nothing became unreachable, and a section the merchant has
// actually configured is not folded away from them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...p}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/offer-actions", () => ({
  createOffer: vi.fn(),
  updateOffer: vi.fn(),
}));

import { OfferForm } from "./offer-form";

const OFFER: any = {
  id: "off-1",
  name: "launch",
  description: null,
  status: "active",
  delivery: "automatic",
  code: null,
  priority: 0,
  triggerType: "always",
  minSubtotal: null,
  rewardType: "buy_x_get_y",
  percent: null,
  amount: null,
  unitPrice: null,
  buyQuantity: 1,
  getQuantity: 1,
  getPercent: 100,
  maxSets: 1,
  showOnStorefront: false,
  tierMode: "percent",
  tiers: [],
  breaks: [],
  giftProductId: null,
  giftVariantId: null,
  giftQuantity: null,
  bundleQuantity: null,
  bundlePrice: null,
  creditAmount: null,
  conditions: [],
  channels: [],
  validFrom: null,
  validUntil: null,
  maxRedemptions: null,
  maxPerCustomer: null,
  budget: null,
  redemptionCount: 0,
  spent: 0,
  createdAt: "2026-09-01T00:00:00.000Z",
};

function view(props: Record<string, unknown> = {}) {
  return render(
    <OfferForm
      offer={null}
      locations={[]}
      groups={[]}
      products={[{ id: "almond", name: "almond shake" }]}
      categories={[{ id: "bev", name: "Beverages" }]}
      initialLocationIds={[]}
      initialGroupIds={[]}
      initialProductIds={[]}
      initialVariantIds={[]}
      initialCategoryIds={[]}
      allowsGroups
      autoApplyOn
      {...(props as any)}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("OfferForm — four collapsible sections", () => {
  it("opens on the decision a merchant came to make", () => {
    view();
    expect(
      screen.getByRole("button", { name: /What the customer gets/i }),
    ).toBeInTheDocument();
    // Open, so its control is on screen without a click.
    expect(screen.getByText("Discount")).toBeInTheDocument();
  });

  it("folds the optional sections away at their defaults, and SAYS what they hold", () => {
    view();
    // ★ The summary is what makes folding safe: a closed section still reports
    // its value, so nothing is hidden — only folded.
    expect(screen.getByText("on any order")).toBeInTheDocument();
    expect(
      screen.getByText("No limits — runs until you pause it"),
    ).toBeInTheDocument();
    // Closed, so the field inside is not rendered.
    expect(screen.queryByText("Total budget (₹)")).toBeNull();
  });

  it("makes every folded field reachable in one click", async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: /Limits/i }));
    expect(screen.getByText("Total budget (₹)")).toBeInTheDocument();
  });

  // ★★ THE REGROUPING'S REAL RISK. Editing an offer that HAS a budget must not
  // bury it behind a click the merchant does not know to make — they came to
  // this page to change exactly that.
  it("starts a configured section open, so an edit is never buried", () => {
    view({ offer: { ...OFFER, budget: 5000 } });
    expect(screen.getByText("Total budget (₹)")).toBeInTheDocument();
  });

  it("starts the trigger section open when the offer has a real condition", () => {
    view({
      offer: { ...OFFER, triggerType: "min_subtotal", minSubtotal: 500 },
    });
    expect(screen.getByText("Minimum order (₹)")).toBeInTheDocument();
  });

  it("summarises the reward in the same words as the offers list", () => {
    view({ offer: OFFER });
    // The header summary and the live sentence both come from describeReward,
    // so they cannot describe the same offer differently.
    expect(
      screen.getAllByText(/Buy 1, get 1 free/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  // ★★ IT DEFAULTED TO ONE SET, in a field whose placeholder reads "No limit".
  // So "Buy 1, get 1 free" on a basket of four gave ONE free item, not two —
  // the offer stopped meaning what its own name says, with nothing on screen
  // to explain it. Blank is the honest default; the budget is the guard rail.

  /** The Max-sets input, once the reward type actually renders it. */
  const maxSetsField = () =>
    screen
      .getByText("Max sets per order")
      .parentElement!.querySelector("input")!;

  /** The hint sentence, whose text is split across several JSX expressions. */
  const hintText = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("span"))
      .map((el) => el.textContent ?? "")
      .find((t) => t.includes("A set is")) ?? "";

  it("starts a NEW buy-X-get-Y offer with no set limit", async () => {
    const user = userEvent.setup();
    view();
    // The Discount select is the first combobox on the form; it has no
    // accessible name of its own (the label above it is a plain span).
    await user.selectOptions(screen.getAllByRole("combobox")[0], "buy_x_get_y");
    expect(maxSetsField()).toHaveValue("");
    expect(maxSetsField()).toHaveAttribute("placeholder", "No limit");
  });

  it("tells the merchant what a basket costs, not just the mechanism", () => {
    const { container } = view({ offer: { ...OFFER, maxSets: null } });
    // "A set is 1 + 1 = 2 items" is how it is stored; "a basket of 4 means
    // they pay for 2" is the thing a merchant came to check.
    const hint = hintText(container);
    expect(hint).toMatch(/a basket of 4 means the customer pays for 2/i);
    expect(hint).toMatch(/2 come free/i);
    expect(hint).toMatch(/It repeats for as long as the basket allows/i);
    expect(hint).toMatch(/total budget/i);
  });

  it("says plainly what a set limit costs, when one is set", () => {
    const { container } = view({ offer: { ...OFFER, maxSets: 1 } });
    const hint = hintText(container);
    expect(hint).toMatch(/Your limit of 1 set caps that/i);
    expect(hint).toMatch(/only 1 can ever be free/i);
  });

  it("keeps an existing limit rather than clearing it on edit", () => {
    view({ offer: { ...OFFER, maxSets: 3 } });
    expect(maxSetsField()).toHaveValue("3");
  });

  // ★★ "COUPON" IS ONE DROPDOWN ENTRY NOW, not two. A percentage off the order
  // and a rupee amount off the order are the same thing to a merchant, and
  // splitting them made them read as two unrelated features while every other
  // entry described a mechanic.
  describe("the coupon family", () => {
    const discountSelect = () => screen.getAllByRole("combobox")[0];

    it("offers one Coupon entry rather than two order-level rewards", () => {
      view();
      const options = Array.from(
        discountSelect().querySelectorAll("option"),
      ).map((o) => (o as HTMLOptionElement).value);
      expect(options).toContain("coupon");
      expect(options).not.toContain("percent_off");
      expect(options).not.toContain("amount_off");
    });

    it("keeps the stored reward types — the schema is not regrouped", async () => {
      const user = userEvent.setup();
      view();
      // The family select lands on percentage; the type control switches it.
      expect(screen.getByText("Coupon type")).toBeInTheDocument();
      expect(screen.getByText("Percentage")).toBeInTheDocument();
      await user.selectOptions(
        screen.getByText("Coupon type").parentElement!.querySelector("select")!,
        "amount_off",
      );
      expect(screen.getByText("Amount (₹)")).toBeInTheDocument();
    });

    it("resolves an existing amount-off offer back to the Coupon family", () => {
      view({ offer: { ...OFFER, rewardType: "amount_off", amount: 200 } });
      expect(discountSelect()).toHaveValue("coupon");
      expect(screen.getByText("Amount (₹)")).toBeInTheDocument();
    });
  });

  // ★★ THE CHECKBOX EXISTS ONLY WHERE THE CART CAN PRICE THE CODE. A
  // buy-X-get-Y on a code can only be priced by the engine, so publishing it
  // would advertise a code the cart then refuses — §23's rule.
  describe("show on storefront", () => {
    const box = () =>
      screen.queryByRole("checkbox", {
        name: /Show this coupon on my storefront/i,
      });

    it("is offered for a coupon on a code", () => {
      view({
        offer: {
          ...OFFER,
          rewardType: "percent_off",
          percent: 10,
          delivery: "code",
          code: "SAVE10",
        },
      });
      expect(box()).toBeInTheDocument();
      expect(box()).not.toBeChecked();
    });

    it("is absent for an automatic offer — there is no code to publish", () => {
      view({ offer: { ...OFFER, rewardType: "percent_off", percent: 10 } });
      expect(box()).toBeNull();
    });

    it("is absent for a reward the cart cannot preview", () => {
      // buy_x_get_y on a code: works at checkout, cannot be shown as a saving.
      view({ offer: { ...OFFER, delivery: "code", code: "B1G1" } });
      expect(box()).toBeNull();
    });

    it("reflects what was saved", () => {
      view({
        offer: {
          ...OFFER,
          rewardType: "percent_off",
          percent: 10,
          delivery: "code",
          code: "SAVE10",
          showOnStorefront: true,
        },
      });
      expect(box()).toBeChecked();
    });
  });

  it("warns on the delivery control when automatic offers are switched off", () => {
    view({ autoApplyOn: false });
    expect(
      screen.getByText(/automatic offers switched off/i),
    ).toBeInTheDocument();
  });

  it("says nothing when they are switched on", () => {
    view({ autoApplyOn: true });
    expect(screen.queryByText(/automatic offers switched off/i)).toBeNull();
  });
});
