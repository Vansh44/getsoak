import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TenderPanel } from "./tender-panel";

// The pad is where a cashier decides what physically happened to the money, so
// these assert the WORDS and the ROUTE through it, not just that it renders.
// The store owner tapped "UPI" expecting a gateway QR and completed a ₹99 sale
// as two unverified records, then asked for a "split payment option" days after
// unknowingly performing one — so naming and discoverability ARE the feature.
function setup(over: Partial<Parameters<typeof TenderPanel>[0]> = {}) {
  const onComplete = vi.fn(async () => ({}));
  render(
    <TenderPanel
      total={500}
      onCancel={() => {}}
      onComplete={onComplete}
      storeCredit={0}
      onTakeOnline={async () => ({ reference: "pay_demo" })}
      {...over}
    />,
  );
  return { onComplete };
}
const tile = (name: RegExp) => screen.getByRole("button", { name });

describe("tender pad — the options screen", () => {
  it("opens on a choice, not an amount box", () => {
    setup();
    expect(tile(/split payment/i)).toBeVisible();
    // Nothing to type into until a method has been chosen.
    expect(screen.queryByPlaceholderText(/amount/i)).toBeNull();
  });

  it("names the merchant's own devices, not the payment rail", () => {
    setup();
    expect(tile(/card machine/i)).toBeVisible();
    expect(tile(/upi app/i)).toBeVisible();
    expect(screen.getAllByText(/can't verify this/i).length).toBe(2);
  });

  it("gives the gateway method a verb and a verified badge", () => {
    setup();
    expect(tile(/charge online/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /^online$/i })).toBeNull();
    expect(screen.getByText(/verified with razorpay/i)).toBeVisible();
  });

  it("shows the gateway tile DISABLED, with a reason, when none is connected", () => {
    setup({ onTakeOnline: undefined });
    // Hidden entirely, a merchant never learns from the till that it exists.
    expect(screen.queryByRole("button", { name: /charge online/i })).toBeNull();
    expect(screen.getByText(/charge online/i)).toBeVisible();
    expect(screen.getByText(/connect a payment gateway/i)).toBeVisible();
  });
});

describe("tender pad — paying in one method", () => {
  it("fills the amount in — the cashier already said it pays the whole sale", () => {
    setup();
    fireEvent.click(tile(/card machine/i));
    // Not a placeholder: a real value, so one tap finishes the sale.
    expect(screen.getByPlaceholderText(/amount/i)).toHaveValue("500");
    // And the button says what it will do, with the figure on it.
    expect(tile(/add ₹500/i)).toBeVisible();
  });

  it("takes the whole balance in one tap", () => {
    setup();
    fireEvent.click(tile(/card machine/i));
    fireEvent.click(tile(/add ₹500/i));
    expect(screen.getByText("Paid in full")).toBeVisible();
    expect(screen.getByText("Card machine")).toBeVisible();
  });

  it("puts the amount on the gateway button too", () => {
    setup();
    fireEvent.click(tile(/charge online/i));
    expect(tile(/charge ₹500/i)).toBeVisible();
  });

  it("can be backed out of without losing the sale", () => {
    setup();
    fireEvent.click(tile(/upi app/i));
    fireEvent.click(tile(/change/i));
    expect(tile(/split payment/i)).toBeVisible();
  });
});

describe("tender pad — splitting", () => {
  it("will not settle the whole sale from a blank box", () => {
    setup();
    fireEvent.click(tile(/split payment/i));
    // Blank means "I haven't said how much yet", never "all of it" — so the
    // box is NOT prefilled here, and the button carries no figure.
    expect(screen.getByPlaceholderText(/amount/i)).toHaveValue("");
    expect(tile(/^add$/i)).toBeDisabled();
    expect(screen.getByText(/enter the part being paid/i)).toBeVisible();
  });

  it("previews the remainder before the cashier commits", () => {
    setup();
    fireEvent.click(tile(/split payment/i));
    fireEvent.change(screen.getByPlaceholderText(/amount/i), {
      target: { value: "300" },
    });
    expect(screen.getByText(/part payment/i)).toBeVisible();
    expect(screen.getByText(/200 still to pay/i)).toBeVisible();
  });

  it("returns to the options grid for whatever is still owed", () => {
    setup();
    fireEvent.click(tile(/split payment/i));
    fireEvent.change(screen.getByPlaceholderText(/amount/i), {
      target: { value: "300" },
    });
    fireEvent.click(tile(/add ₹300/i));
    // ₹300 cash + ₹200 online — the case the owner described.
    expect(screen.getByText("Remaining")).toBeVisible();
    expect(screen.getByText("₹200")).toBeVisible();
    expect(tile(/charge online/i)).toBeVisible();
  });

  it("names a staged tender the way its tile is named", () => {
    setup();
    fireEvent.click(tile(/upi app/i));
    fireEvent.change(screen.getByPlaceholderText(/amount/i), {
      target: { value: "300" },
    });
    fireEvent.click(tile(/add ₹300/i));
    // Was a raw `capitalize` of the enum, so the row said "Upi" while the
    // control it came from said something else. Two matches IS the assertion:
    // back on the options grid, the tile and the staged row use one name.
    expect(screen.getAllByText("UPI app")).toHaveLength(2);
    expect(screen.queryByText("Upi")).toBeNull();
  });
});
