import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TenderPanel } from "./tender-panel";
import type { PosCustomer, PosTender } from "@/app/actions/pos-sale-actions";

function setup(over: Partial<Parameters<typeof TenderPanel>[0]> = {}) {
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

const button = (name: RegExp) => screen.getByRole("button", { name });

describe("checkout customer details", () => {
  it("does not resolve while typing and submits one exact 10-digit mobile", async () => {
    const onCustomer = vi.fn();
    const onResolveCustomer = vi.fn(async () => ({
      created: true,
      customer: {
        id: "pos_1",
        name: "9876543210",
        phone: "9876543210",
        email: null,
        storeCredit: 0,
      },
    }));
    setup({
      customer: null,
      onCustomer,
      onResolveCustomer,
      receiptEmail: "",
      onReceiptEmail: vi.fn(),
    });

    expect(screen.getByRole("heading", { name: "Checkout" })).toBeVisible();
    const mobile = screen.getByLabelText(/customer mobile number/i);
    fireEvent.change(mobile, { target: { value: "9876543210123" } });
    expect(mobile).toHaveValue("9876543210");
    expect(onResolveCustomer).not.toHaveBeenCalled();
    fireEvent.click(button(/^ok$/i));

    await waitFor(() =>
      expect(onResolveCustomer).toHaveBeenCalledWith("9876543210"),
    );
    expect(onResolveCustomer).toHaveBeenCalledTimes(1);
    expect(onCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pos_1" }),
    );
    expect(screen.getByText("Choose a payment method")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /continue to payment/i }),
    ).toBeNull();
  });

  it("accepts only ten digits and never shows payment before resolution", () => {
    const onResolveCustomer = vi.fn();
    setup({
      customer: null,
      onCustomer: vi.fn(),
      onResolveCustomer,
      receiptEmail: "",
      onReceiptEmail: vi.fn(),
    });

    const mobile = screen.getByLabelText(/customer mobile number/i);
    fireEvent.change(mobile, { target: { value: "98a76-54" } });
    expect(mobile).toHaveValue("987654");
    expect(button(/^ok$/i)).toBeDisabled();
    expect(onResolveCustomer).not.toHaveBeenCalled();
    expect(screen.queryByText("Choose a payment method")).toBeNull();
  });

  it("shows an already resolved customer's contact on payment", () => {
    const customer: PosCustomer = {
      id: "c1",
      name: "Asha Rao",
      phone: "9876543210",
      email: "asha@example.com",
      storeCredit: 0,
    };
    setup({
      customer,
      onCustomer: vi.fn(),
      onResolveCustomer: vi.fn(),
    });

    expect(screen.getByText("Asha Rao")).toBeVisible();
    expect(screen.getByText(/9876543210.*asha@example.com/)).toBeVisible();
    expect(screen.getByText("Choose a payment method")).toBeVisible();
  });

  it("keeps optional receipt and GST fields out of the common path", () => {
    setup({
      customer: {
        id: "c1",
        name: "Asha",
        phone: "9876543210",
        email: null,
        storeCredit: 0,
      },
      onCustomer: vi.fn(),
      onResolveCustomer: vi.fn(),
      receiptEmail: "",
      onReceiptEmail: vi.fn(),
      gstEnabled: true,
      gstin: "",
      onGstin: vi.fn(),
    });

    expect(screen.queryByPlaceholderText("name@example.com")).toBeNull();
    fireEvent.click(button(/add receipt email or gstin/i));
    expect(screen.getByPlaceholderText("name@example.com")).toBeVisible();
    expect(screen.getByPlaceholderText("22AAAAA0000A1Z5")).toBeVisible();
  });
});

describe("payment method selection", () => {
  it("shows a short, plain-language list and keeps split secondary", () => {
    setup();
    expect(button(/^cash/i)).toBeVisible();
    expect(button(/^card terminal/i)).toBeVisible();
    expect(button(/^upi \/ qr/i)).toBeVisible();
    expect(button(/^razorpay/i)).toBeVisible();
    expect(screen.getByText(/after your terminal approves/i)).toBeVisible();
    expect(button(/^split payment/i)).toBeVisible();
    expect(screen.queryByText(/record a payment already taken/i)).toBeNull();
  });

  it("omits Razorpay when no gateway is connected", () => {
    setup({ onTakeOnline: undefined });
    expect(screen.queryByRole("button", { name: /^razorpay/i })).toBeNull();
    expect(screen.queryByText(/connect a payment gateway/i)).toBeNull();
  });
});

describe("one-method payments", () => {
  it("asks for an explicit terminal confirmation without an amount field", async () => {
    const { onComplete } = setup();
    fireEvent.click(button(/^card terminal/i));

    expect(screen.queryByPlaceholderText(/up to/i)).toBeNull();
    expect(screen.getByText(/confirm the terminal approved/i)).toBeVisible();
    fireEvent.click(button(/^complete sale$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0]).toEqual([
      { method: "card", amount: 500 },
    ]);
  });

  it("collects cash received and previews change before completing", async () => {
    const { onComplete } = setup();
    fireEvent.click(button(/^cash/i));
    const amount = screen.getByLabelText(/cash received/i);
    expect(amount).toHaveValue("500");
    fireEvent.change(amount, { target: { value: "600" } });
    expect(screen.getByText("Give ₹100 change")).toBeVisible();
    fireEvent.click(button(/^complete sale$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0]).toEqual([
      { method: "cash", amount: 600, tendered: 600 },
    ]);
  });

  it("charges and verifies a Razorpay payment before completing", async () => {
    const onTakeOnline = vi.fn(async () => ({ reference: "pay_verified" }));
    const { onComplete } = setup({ onTakeOnline });
    fireEvent.click(button(/^razorpay/i));
    expect(screen.queryByPlaceholderText(/up to/i)).toBeNull();
    fireEvent.click(button(/^charge ₹500$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onTakeOnline).toHaveBeenCalledWith(500);
    expect(onComplete.mock.calls[0][0]).toEqual([
      { method: "razorpay", amount: 500, reference: "pay_verified" },
    ]);
  });

  it("keeps a recorded tender while manager approval is collected", async () => {
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

    fireEvent.click(button(/^card terminal/i));
    fireEvent.click(button(/^complete sale$/i));
    const pin = await screen.findByPlaceholderText(/manager's 8-digit pin/i);
    fireEvent.change(pin, { target: { value: "12345678" } });
    fireEvent.click(button(/^approve$/i));

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

    fireEvent.click(button(/^razorpay/i));
    fireEvent.click(button(/^charge ₹500$/i));

    expect(
      await screen.findByText(/couldn't complete the sale/i),
    ).toBeVisible();
    expect(screen.getByText("Razorpay")).toBeVisible();
    fireEvent.click(button(/^complete sale$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(onComplete.mock.calls[1][0]).toEqual([
      { method: "razorpay", amount: 500, reference: "pay_captured" },
    ]);
    expect(onTakeOnline).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: /remove razorpay payment/i }),
    ).toBeNull();
    expect(screen.getByText("Verified")).toBeVisible();
  });
});

describe("split payments", () => {
  it("uses a method → amount → next method loop", () => {
    setup();
    fireEvent.click(button(/^split payment/i));
    expect(
      screen.getByRole("heading", { name: "Split payment" }),
    ).toBeVisible();
    expect(screen.getByText(/choose how to collect ₹500/i)).toBeVisible();
    expect(screen.queryByPlaceholderText(/up to/i)).toBeNull();

    fireEvent.click(button(/^cash/i));
    const amount = screen.getByLabelText(/cash received/i);
    expect(amount).toHaveValue("");
    expect(button(/^enter amount$/i)).toBeDisabled();
    fireEvent.change(amount, { target: { value: "300" } });
    fireEvent.click(button(/^add ₹300$/i));

    expect(screen.getByText("₹200")).toBeVisible();
    expect(screen.getByText(/choose how to collect ₹200/i)).toBeVisible();
    expect(screen.getAllByText("Cash")).toHaveLength(2);
  });

  it("finishes only after the cashier reviews all payment legs", async () => {
    const { onComplete } = setup();
    fireEvent.click(button(/^split payment/i));
    fireEvent.click(button(/^cash/i));
    fireEvent.change(screen.getByLabelText(/cash received/i), {
      target: { value: "300" },
    });
    fireEvent.click(button(/^add ₹300$/i));

    fireEvent.click(button(/^upi \/ qr/i));
    fireEvent.change(screen.getByLabelText(/^amount$/i), {
      target: { value: "200" },
    });
    fireEvent.click(button(/^add ₹200$/i));

    expect(screen.getByText("Payment complete")).toBeVisible();
    expect(screen.getAllByText("UPI / QR").length).toBeGreaterThan(0);
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(button(/^complete sale$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0]).toEqual([
      { method: "cash", amount: 300, tendered: 300 },
      { method: "upi", amount: 200 },
    ]);
  });

  it("turns a short store-credit balance into a clear split", () => {
    setup({ storeCredit: 120 });
    fireEvent.click(button(/^store credit/i));
    expect(screen.getByText(/₹380 will still be due/i)).toBeVisible();
    fireEvent.click(button(/^add ₹120$/i));
    expect(
      screen.getByRole("heading", { name: "Split payment" }),
    ).toBeVisible();
    expect(screen.getByText(/choose how to collect ₹380/i)).toBeVisible();
  });
});
