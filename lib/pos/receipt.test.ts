import { describe, it, expect } from "vitest";
import { buildReceiptModel, type ReceiptSource } from "./receipt";

const base: ReceiptSource = {
  store: { name: "Echos", legalName: "Echos Retail Pvt Ltd", phone: "+911234" },
  location: {
    name: "Delhi — CP",
    address: { line1: "12 Block A", city: "New Delhi", postalCode: "110001" },
    gstin: "07AABCU9603R1ZM",
  },
  order: {
    receipt_no: "DEL-000042",
    order_ref: "ORD100110006",
    created_at: "2026-07-25T10:00:00Z",
    cashier_name: "Priya",
    subtotal: 200,
    discount: 0,
    tax: 36,
    tax_inclusive: false,
    total: 236,
    customer_gstin: null,
    supplier_state: "07",
    place_of_supply_state: "07",
  },
  items: [
    {
      name: "Cold Brew",
      variant_name: "500ml",
      hsn_code: "2202",
      quantity: 2,
      price: 100,
      total: 200,
      tax_rate: 18,
      tax_class_name: "GST 18%",
      tax_amount: 36,
      tax_cgst: 18,
      tax_sgst: 18,
      tax_igst: 0,
    },
  ],
  payments: [
    {
      method: "cash",
      amount: 300,
      tendered: 300,
      change_due: 64,
      reference: null,
    },
  ],
  gstEnabled: true,
};

describe("buildReceiptModel", () => {
  it("maps store, location and sale identity", () => {
    const m = buildReceiptModel(base);
    expect(m).toMatchObject({
      storeName: "Echos",
      legalName: "Echos Retail Pvt Ltd",
      locationName: "Delhi — CP",
      gstin: "07AABCU9603R1ZM",
      receiptNo: "DEL-000042",
      orderRef: "ORD100110006",
      cashierName: "Priya",
      total: 236,
    });
    expect(m.address).toBe("12 Block A, New Delhi, 110001");
  });

  it("falls back to the order ref when there's no receipt number", () => {
    const m = buildReceiptModel({
      ...base,
      order: { ...base.order, receipt_no: null },
    });
    expect(m.receiptNo).toBe("ORD100110006");
  });

  it("builds the per-rate GST breakdown and detects intra-state", () => {
    const m = buildReceiptModel(base);
    expect(m.intraState).toBe(true);
    expect(m.gst).toHaveLength(1);
    expect(m.gst[0]).toMatchObject({
      rate: 18,
      taxableValue: 200,
      cgst: 18,
      sgst: 18,
      igst: 0,
    });
  });

  it("reports IGST as inter-state", () => {
    const m = buildReceiptModel({
      ...base,
      items: [{ ...base.items[0], tax_cgst: 0, tax_sgst: 0, tax_igst: 36 }],
    });
    expect(m.intraState).toBe(false);
    expect(m.gst[0]).toMatchObject({ igst: 36, cgst: 0, sgst: 0 });
  });

  // Inclusive pricing: the taxable value must EXCLUDE the tax already inside
  // the listed price, or the receipt's GST block won't add up.
  it("carves tax out of the taxable value when prices include tax", () => {
    const m = buildReceiptModel({
      ...base,
      order: { ...base.order, tax_inclusive: true, total: 200 },
    });
    expect(m.taxInclusive).toBe(true);
    expect(m.gst[0].taxableValue).toBe(164); // 200 − 36
  });

  it("sums change across tenders", () => {
    const m = buildReceiptModel(base);
    expect(m.changeDue).toBe(64);
    expect(m.tenders[0]).toMatchObject({ method: "cash", tendered: 300 });
  });

  it("tolerates a missing location and address", () => {
    const m = buildReceiptModel({ ...base, location: null });
    expect(m.locationName).toBeNull();
    expect(m.address).toBeNull();
    expect(m.gstin).toBeNull();
  });
});
