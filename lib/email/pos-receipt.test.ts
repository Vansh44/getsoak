import { describe, it, expect, vi, beforeEach } from "vitest";

const sendEmail = vi.fn();
vi.mock("./send", () => ({ sendEmail: (i: unknown) => sendEmail(i) }));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrandById: vi.fn(async () => ({
    name: "Corner Store",
    logoUrl: null,
    primaryColor: "#2f6f4e",
    tagline: null,
    blurb: null,
    legalName: null,
    creditLine: null,
    email: null,
    phone: null,
    hours: null,
    social: {},
    badges: [],
    domain: "cornerstore.example",
  })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import { sendPosReceipt, shouldSendDirectReceipt } from "./pos-receipt";
import { getStoreBrandById } from "@/lib/store/brand";

const SUMMARY = {
  currency: "INR",
  items: [{ name: "Amul Taaza Toned Milk", quantity: 2, total: 118 }],
  subtotal: 118,
  total: 124,
};

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS.
  sendEmail.mockResolvedValue({ sent: true });
  vi.mocked(getStoreBrandById).mockResolvedValue({
    name: "Corner Store",
    primaryColor: "#2f6f4e",
    domain: "cornerstore.example",
    social: {},
    badges: [],
  } as never);
});

// ---------------------------------------------------------------------------
// ★ ONE RECEIPT, NEVER TWO. An attached customer with an address already gets
// an order confirmation from the order.placed fan-out; a second copy sent
// directly is the two-emails-for-one-action pattern §24 warns about.
// ---------------------------------------------------------------------------
describe("shouldSendDirectReceipt", () => {
  it("sends for a walk-in with no customer attached", () => {
    expect(
      shouldSendDirectReceipt({
        receiptEmail: "a@x.com",
        customerId: null,
        customerEmail: null,
      }),
    ).toBe(true);
  });

  it("does NOT send when the attached customer will get the fan-out's copy", () => {
    expect(
      shouldSendDirectReceipt({
        receiptEmail: "a@x.com",
        customerId: "cust-1",
        customerEmail: "cust@x.com",
      }),
    ).toBe(false);
  });

  // The fan-out resolves the address from their users row; with none there, it
  // queues nothing, so this is still the only receipt they will get.
  it("DOES send for an attached customer with no address on file", () => {
    expect(
      shouldSendDirectReceipt({
        receiptEmail: "a@x.com",
        customerId: "cust-1",
        customerEmail: null,
      }),
    ).toBe(true);
  });

  it.each([[null], [undefined], [""]])(
    "sends nothing when no address was asked for (%s)",
    (value) => {
      expect(
        shouldSendDirectReceipt({
          receiptEmail: value,
          customerId: null,
          customerEmail: null,
        }),
      ).toBe(false);
    },
  );
});

describe("sendPosReceipt", () => {
  const INPUT = {
    storeId: "store-1",
    to: "asha@example.com",
    orderRef: "ORD100110006",
    summary: SUMMARY,
    tenderLabels: ["Cash"],
    changeDue: 76,
  };

  it("sends through sendEmail, so it lands in email_logs", async () => {
    await sendPosReceipt(INPUT);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0][0];
    expect(msg.to).toBe("asha@example.com");
    expect(msg.storeId).toBe("store-1");
    // The log's "what was this?" column.
    expect(msg.mailer).toBe("pos_receipt");
  });

  // ★ A merchant on their own sending domain would otherwise send from an
  // address Resend has no permission for, and every receipt would bounce.
  it("sends FROM the store's own domain, not a hardcoded one", async () => {
    await sendPosReceipt(INPUT);
    expect(sendEmail.mock.calls[0][0].from).toContain("cornerstore.example");
  });

  it("puts the order reference in the subject", async () => {
    await sendPosReceipt(INPUT);
    expect(sendEmail.mock.calls[0][0].subject).toContain("ORD100110006");
  });

  it("renders what they bought, what they paid with, and their change", async () => {
    await sendPosReceipt(INPUT);
    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).toContain("Amul Taaza Toned Milk");
    expect(html).toContain("Cash");
    expect(html).toMatch(/Change given/);
  });

  it("omits the change row when there is none", async () => {
    await sendPosReceipt({ ...INPUT, changeDue: 0 });
    expect(sendEmail.mock.calls[0][0].html).not.toMatch(/Change given/);
  });

  it("names the shop when one is given", async () => {
    await sendPosReceipt({ ...INPUT, locationName: "Indiranagar" });
    expect(sendEmail.mock.calls[0][0].html).toContain("Indiranagar");
  });

  // A customer named `<script>` must not become markup in someone's inbox.
  it("escapes what it renders", async () => {
    await sendPosReceipt({
      ...INPUT,
      locationName: "<script>alert(1)</script>",
    });
    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // ★ NEVER THROWS. The money is already taken and the stock already moved;
  // the customer is holding the printed copy either way.
  it("swallows a mailer failure rather than failing the sale", async () => {
    sendEmail.mockRejectedValue(new Error("resend down"));
    await expect(sendPosReceipt(INPUT)).resolves.toBeUndefined();
  });

  it("swallows a failure to load the brand", async () => {
    vi.mocked(getStoreBrandById).mockRejectedValue(new Error("db down"));
    await expect(sendPosReceipt(INPUT)).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
