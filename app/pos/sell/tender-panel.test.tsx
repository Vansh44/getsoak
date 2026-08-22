import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TenderPanel } from "./tender-panel";
import type { PosTender } from "@/app/actions/pos-sale-actions";

// The pad is where a cashier decides what physically happened to the money, so
// these assert the WORDS and the ROUTE through it, not just that it renders.
// The store owner tapped "UPI" expecting a gateway QR and completed a ₹99 sale
// as two unverified records, then asked for a "split payment option" days after
// unknowingly performing one — so naming and discoverability ARE the feature.
function setup(over: Partial<Parameters<typeof TenderPanel>[0]> = {}) {
  // Typed, so the call assertions below can read the tenders it was given.
  const onComplete = vi.fn<
    (
      tenders: PosTender[],
      approvalToken?: string,
    ) => Promise<{ error?: string; needsApproval?: boolean }>
  >(async () => ({}));
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
  it("★ offers NO amount box — the figure is not in question", () => {
    setup();
    fireEvent.click(tile(/card machine/i));
    // An editable amount here is how a full payment silently becomes a part
    // one: a single keystroke turned a ₹599 charge into ₹59 on a real till,
    // with a part-payment banner as the only warning.
    expect(screen.queryByPlaceholderText(/amount/i)).toBeNull();
    // The action carries the figure AND says the sale ends here.
    expect(tile(/complete sale · ₹500/i)).toBeVisible();
  });

  it("★ shows ONE action, not a charge plus a dead confirm", async () => {
    const { onComplete } = setup();
    fireEvent.click(tile(/card machine/i));
    // Previously: "Add ₹500" plus a disabled "Complete sale" underneath — two
    // buttons for a sale with one remaining action.
    expect(
      screen.queryByRole("button", { name: /^complete sale$/i }),
    ).toBeNull();
    fireEvent.click(tile(/complete sale · ₹500/i));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    // Staged AND submitted from the single tap.
    expect(onComplete.mock.calls[0][0]).toEqual([
      { method: "card", amount: 500 },
    ]);
  });

  it("locks the gateway amount too, and charges it in one tap", () => {
    setup();
    fireEvent.click(tile(/charge online/i));
    expect(screen.queryByPlaceholderText(/amount/i)).toBeNull();
    expect(tile(/charge ₹500/i)).toBeVisible();
  });

  it("keeps a one-tap tender through manager approval", async () => {
    const onComplete = vi
      .fn()
      .mockResolvedValueOnce({
        needsApproval: true,
        error: "Manager approval needed.",
      })
      .mockResolvedValueOnce({});
    const onVerifyManager = vi.fn(async () => ({
      approved: true,
      token: "manager-token",
    }));
    setup({ onComplete, onVerifyManager });

    fireEvent.click(tile(/card machine/i));
    fireEvent.click(tile(/complete sale · ₹500/i));
    const pin = await screen.findByPlaceholderText(/manager's 8-digit pin/i);
    fireEvent.change(pin, { target: { value: "12345678" } });
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(onComplete.mock.calls[1]).toEqual([
      [{ method: "card", amount: 500 }],
      "manager-token",
    ]);
  });

  it("keeps a captured gateway tender when completion must be retried", async () => {
    const onComplete = vi
      .fn()
      .mockResolvedValueOnce({ error: "Couldn't complete the sale." })
      .mockResolvedValueOnce({});
    const onTakeOnline = vi.fn(async () => ({ reference: "pay_captured" }));
    setup({ onComplete, onTakeOnline });

    fireEvent.click(tile(/charge online/i));
    fireEvent.click(tile(/charge ₹500/i));

    expect(
      await screen.findByText(/couldn't complete the sale/i),
    ).toBeVisible();
    expect(screen.getByText("Charged online")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^complete sale$/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(onComplete.mock.calls[1][0]).toEqual([
      { method: "razorpay", amount: 500, reference: "pay_captured" },
    ]);
    expect(onTakeOnline).toHaveBeenCalledTimes(1);
  });

  it("keeps the amount editable for CASH, which can be over-handed", () => {
    setup();
    fireEvent.click(tile(/^cash/i));
    // ₹600 for a ₹500 sale is ordinary, and change has to come from somewhere.
    expect(screen.getByPlaceholderText(/amount/i)).toBeVisible();
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
    // A PART payment goes through Split — a method tile pays the whole sale
    // and offers no amount box at all.
    fireEvent.click(tile(/split payment/i));
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
