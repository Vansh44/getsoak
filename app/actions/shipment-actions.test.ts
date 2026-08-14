/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "store-1"),
  getManagerIdentity: vi.fn(),
}));
vi.mock("@/lib/logistics/fulfilment", () => ({
  ensureFulfilmentOrder: vi.fn(async () => "fulfilment-1"),
  markFulfilmentInProgress: vi.fn(async () => {}),
}));
vi.mock("@/lib/logistics/connection", () => ({
  getShiprocketSessionForStore: vi.fn(),
}));
vi.mock("@/lib/logistics/shiprocket", () => ({
  actOnShiprocketNdr: vi.fn(async () => {}),
  assignShiprocketAwb: vi.fn(),
  cancelShiprocketAwb: vi.fn(async () => {}),
  createShiprocketOrder: vi.fn(),
  generateShiprocketLabel: vi.fn(),
  generateShiprocketManifest: vi.fn(),
  scheduleShiprocketPickup: vi.fn(async () => {}),
  trackShiprocketAwb: vi.fn(),
}));
vi.mock("@/lib/logistics/tracking", () => ({
  parseShiprocketTracking: vi.fn(),
  recordShipmentTrackingUpdate: vi.fn(async () => {}),
}));

import { revalidatePath } from "next/cache";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import {
  ensureFulfilmentOrder,
  markFulfilmentInProgress,
} from "@/lib/logistics/fulfilment";
import { getShiprocketSessionForStore } from "@/lib/logistics/connection";
import {
  actOnShiprocketNdr,
  assignShiprocketAwb,
  cancelShiprocketAwb,
  createShiprocketOrder,
  generateShiprocketLabel,
  generateShiprocketManifest,
  scheduleShiprocketPickup as scheduleProviderPickup,
  trackShiprocketAwb,
} from "@/lib/logistics/shiprocket";
import {
  parseShiprocketTracking,
  recordShipmentTrackingUpdate,
} from "@/lib/logistics/tracking";
import {
  fulfilmentOrders,
  orders,
  shipmentItems,
  shipments,
} from "@/drizzle/schema";
import {
  bookShiprocketShipment,
  cancelShipment,
  createManualShipment,
  getOrderLogisticsView,
  refreshShipmentTracking,
  retryShiprocketShipment,
  scheduleShipmentPickup,
  submitShipmentNdrAction,
} from "./shipment-actions";

const SESSION = {
  id: "connection-1",
  token: "shiprocket-token",
  email: "warehouse@acme.test",
};

const ORDER = {
  id: "order-1",
  orderRef: "ORD1001",
  createdAt: "2026-08-14T08:00:00.000Z",
  status: "confirmed",
  fulfilmentType: "delivery",
  locationId: "location-1",
  paymentMethod: "cash_on_delivery",
  shippingAddress: {
    firstName: "Priya",
    lastName: "Shah",
    addressLine1: "12 Radial Road",
    addressLine2: "Near Metro",
    city: "New Delhi",
    state: "Delhi",
    postalCode: "110001",
    country: "India",
    email: "priya@example.com",
    phone: "+91 98765 43210",
  },
  shippingOption: {
    courierId: "11",
    courierName: "FastEx",
    carrierCost: 65,
    estimatedDeliveryAt: "2026-08-18T00:00:00.000Z",
  },
  subtotal: 800,
  shipping: 80,
  discount: 40,
  total: 840,
  storeCreditUsed: 100,
};

const LINE = {
  id: "item-1",
  name: "Milk",
  sku: "MILK-1",
  hsn: "0401",
  quantity: 2,
  price: 400,
  total: 800,
  taxRate: 5,
  requiresShipping: true,
  weightGrams: 250,
  lengthCm: 8,
  widthCm: 7,
  heightCm: 4,
};

const SHIPMENT: any = {
  id: "shipment-1",
  storeId: "store-1",
  orderId: "order-1",
  fulfilmentOrderId: "fulfilment-1",
  locationId: "location-1",
  connectionId: "connection-1",
  provider: "shiprocket",
  status: "booking",
  idempotencyKey: "order-1:fulfilment-1:shiprocket:1",
  externalOrderId: null,
  externalShipmentId: null,
  awb: null,
  courierId: "11",
  courierName: "FastEx",
  trackingUrl: null,
  labelUrl: null,
  manifestUrl: null,
  lastError: null,
  ndrReason: null,
  weightGrams: 500,
  lengthCm: 10,
  widthCm: 10,
  heightCm: 8,
  createdAt: "2026-08-14T08:10:00.000Z",
  operationToken: null,
  operationLeaseUntil: null,
};

const EVENT = {
  id: "event-1",
  status: "ready_to_ship",
  description: "Shipment booked",
  location: null,
  occurredAt: "2026-08-14T08:12:00.000Z",
};

const PARCEL = {
  weightGrams: 500,
  lengthCm: 10,
  widthCm: 10,
  heightCm: 8,
};

function viewQueues(shipment: any = SHIPMENT, events: any[] = [EVENT]) {
  return [[shipment], events];
}

function bookQueues(
  shipment: any = SHIPMENT,
  order: any = ORDER,
  lines: any[] = [LINE],
) {
  return [
    [order],
    lines,
    [{ locationId: "location-1", pickupCode: "ACME_WAREHOUSE" }],
    [shipment],
    ...viewQueues({
      ...shipment,
      status: "ready_to_ship",
      externalOrderId: shipment.externalOrderId ?? "sr-order-1",
      externalShipmentId: shipment.externalShipmentId ?? "sr-shipment-1",
      awb: shipment.awb ?? "AWB123",
      labelUrl: shipment.labelUrl ?? "https://label.test/1.pdf",
    }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbHolder.current = makeDbMock();
  vi.mocked(getManagerIdentity).mockResolvedValue({
    uid: "admin-1",
    email: "owner@acme.test",
  });
  vi.mocked(getShiprocketSessionForStore).mockResolvedValue(SESSION as any);
  vi.mocked(createShiprocketOrder).mockResolvedValue({
    orderId: "sr-order-1",
    shipmentId: "sr-shipment-1",
    raw: {},
  });
  vi.mocked(assignShiprocketAwb).mockResolvedValue({
    awb: "AWB123",
    courierId: "11",
    courierName: "FastEx",
    raw: {},
  });
  vi.mocked(generateShiprocketLabel).mockResolvedValue(
    "https://label.test/1.pdf",
  );
  vi.mocked(generateShiprocketManifest).mockResolvedValue(
    "https://manifest.test/1.pdf",
  );
  vi.mocked(trackShiprocketAwb).mockResolvedValue({ tracking_data: {} });
  vi.mocked(parseShiprocketTracking).mockReturnValue([]);
});

describe("getOrderLogisticsView", () => {
  it("requires orders access before reading an order", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null);
    expect(await getOrderLogisticsView("order-1")).toEqual({
      error: "Not authenticated.",
    });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("does not leak a missing or foreign order", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[], []] });
    expect(await getOrderLogisticsView("order-1")).toEqual({
      error: "Order not found.",
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["order-1", "store-1"]),
    );
  });

  it("returns connection, mapping, parcel defaults and shipment history", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [ORDER],
        [LINE],
        [{ id: "connection-1", enabled: true }],
        [
          {
            locationId: "location-1",
            locationName: "Connaught Place",
            pickupCode: "ACME_WAREHOUSE",
          },
        ],
        [{ id: "shipment-1" }],
        [SHIPMENT],
        [EVENT],
      ],
    });

    const result = await getOrderLogisticsView("order-1");

    expect(result.data).toMatchObject({
      connected: true,
      mapped: true,
      locationName: "Connaught Place",
      defaults: {
        weightGrams: 500,
        lengthCm: 10,
        widthCm: 10,
        heightCm: 8,
      },
    });
    expect(result.data?.shipments[0]).toMatchObject({
      id: "shipment-1",
      status: "booking",
      statusLabel: "Booking courier",
      events: [EVENT],
    });
    expect(ensureFulfilmentOrder).toHaveBeenCalledWith({
      storeId: "store-1",
      orderId: "order-1",
      locationId: "location-1",
    });
  });

  it("does not create fulfilment work for pickup orders", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...ORDER, fulfilmentType: "pickup" }], [LINE], [], []],
    });

    const result = await getOrderLogisticsView("order-1");

    expect(ensureFulfilmentOrder).not.toHaveBeenCalled();
    expect(result.data?.mapped).toBe(false);
    expect(result.data?.locationName).toBeNull();
  });
});

describe("bookShiprocketShipment input and state gates", () => {
  it("requires orders access", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null);
    expect(await bookShiprocketShipment("order-1", PARCEL)).toEqual({
      error: "Not authenticated.",
    });
  });

  it.each([
    [{ ...PARCEL, weightGrams: 0 }, /weight must be greater than zero/i],
    [{ ...PARCEL, lengthCm: Number.NaN }, /length must be greater than zero/i],
    [{ ...PARCEL, widthCm: -1 }, /width must be greater than zero/i],
    [{ ...PARCEL, heightCm: 0 }, /height must be greater than zero/i],
  ])("rejects unsafe parcel dimensions %#", async (parcel, message) => {
    expect((await bookShiprocketShipment("order-1", parcel)).error).toMatch(
      message,
    );
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("rejects pickup, terminal and digital-only orders", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...ORDER, fulfilmentType: "pickup" }], [LINE]],
    });
    expect((await bookShiprocketShipment("order-1", PARCEL)).error).toMatch(
      /pickup orders are not shipped/i,
    );

    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...ORDER, status: "delivered" }], [LINE]],
    });
    expect((await bookShiprocketShipment("order-1", PARCEL)).error).toMatch(
      /delivered order cannot be shipped/i,
    );

    dbHolder.current = makeDbMock({
      selectQueue: [[ORDER], [{ ...LINE, requiresShipping: false }]],
    });
    expect((await bookShiprocketShipment("order-1", PARCEL)).error).toMatch(
      /no physical items/i,
    );
  });

  it("requires a complete address and normalized Indian mobile", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            ...ORDER,
            shippingAddress: { ...ORDER.shippingAddress, city: "" },
          },
        ],
        [LINE],
      ],
    });
    expect((await bookShiprocketShipment("order-1", PARCEL)).error).toMatch(
      /complete the customer's delivery address/i,
    );

    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            ...ORDER,
            shippingAddress: {
              ...ORDER.shippingAddress,
              phone: "1111111111",
            },
          },
        ],
        [LINE],
      ],
    });
    expect((await bookShiprocketShipment("order-1", PARCEL)).error).toMatch(
      /valid 10-digit indian delivery phone/i,
    );
  });

  it("requires the selected fulfilment location to be mapped", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [ORDER],
        [LINE],
        [{ locationId: "location-1", pickupCode: null }],
      ],
    });
    expect((await bookShiprocketShipment("order-1", PARCEL)).error).toMatch(
      /sync this fulfilment location/i,
    );
    expect(getShiprocketSessionForStore).not.toHaveBeenCalled();
  });

  it("never revives a cancelled work item", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [ORDER],
        [LINE],
        [{ locationId: "location-1", pickupCode: "ACME" }],
        [{ ...SHIPMENT, status: "cancelled" }],
      ],
    });
    expect((await bookShiprocketShipment("order-1", PARCEL)).error).toMatch(
      /cancelled and cannot be revived/i,
    );
    expect(createShiprocketOrder).not.toHaveBeenCalled();
  });

  it("returns an already-ready shipment without a second provider call", async () => {
    const ready = {
      ...SHIPMENT,
      status: "ready_to_ship",
      externalShipmentId: "sr-shipment-1",
      awb: "AWB123",
    };
    dbHolder.current = makeDbMock({
      selectQueue: [
        [ORDER],
        [LINE],
        [{ locationId: "location-1", pickupCode: "ACME" }],
        [ready],
        ...viewQueues(ready),
      ],
    });

    const result = await bookShiprocketShipment("order-1", PARCEL);

    expect(result.success).toBe(true);
    expect(createShiprocketOrder).not.toHaveBeenCalled();
    expect(assignShiprocketAwb).not.toHaveBeenCalled();
  });

  it("does not race another request holding the booking lease", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [ORDER],
        [LINE],
        [{ locationId: "location-1", pickupCode: "ACME" }],
        [SHIPMENT],
        ...viewQueues(SHIPMENT),
      ],
      returning: [],
    });

    const result = await bookShiprocketShipment("order-1", PARCEL);

    expect(result.error).toMatch(/already being booked/i);
    expect(createShiprocketOrder).not.toHaveBeenCalled();
  });
});

describe("bookShiprocketShipment staged provider workflow", () => {
  it("persists local work before calling Shiprocket and completes every stage", async () => {
    dbHolder.current = makeDbMock({ selectQueue: bookQueues() });

    const result = await bookShiprocketShipment("order-1", PARCEL);

    expect(result.success).toBe(true);
    expect(dbHolder.current.calls.update[0]).toBe(shipments);
    expect(dbHolder.current.calls.insert[0]).toBe(shipmentItems);
    expect(createShiprocketOrder).toHaveBeenCalledWith(
      "shiprocket-token",
      expect.objectContaining({
        pickup_location: "ACME_WAREHOUSE",
        billing_phone: "9876543210",
        payment_method: "COD",
        weight: 0.5,
      }),
    );
    expect(assignShiprocketAwb).toHaveBeenCalledWith(
      "shiprocket-token",
      "sr-shipment-1",
      "11",
    );
    expect(generateShiprocketLabel).toHaveBeenCalledWith(
      "shiprocket-token",
      "sr-shipment-1",
    );
    expect(markFulfilmentInProgress).toHaveBeenCalledWith("fulfilment-1");
    expect(recordShipmentTrackingUpdate).toHaveBeenCalledWith(
      "shipment-1",
      expect.objectContaining({
        status: "ready_to_ship",
        awb: "AWB123",
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/orders");
  });

  it("creates one idempotent local row with quoted commercial metadata", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [ORDER],
        [LINE],
        [{ locationId: "location-1", pickupCode: "ACME_WAREHOUSE" }],
        [],
        [SHIPMENT],
        ...viewQueues({ ...SHIPMENT, status: "ready_to_ship", awb: "AWB123" }),
      ],
    });

    await bookShiprocketShipment("order-1", PARCEL);

    const row = dbHolder.current.calls.values[0];
    expect(dbHolder.current.calls.insert[0]).toBe(shipments);
    expect(row).toMatchObject({
      storeId: "store-1",
      orderId: "order-1",
      provider: "shiprocket",
      status: "booking",
      idempotencyKey: "order-1:fulfilment-1:shiprocket:1",
      courierId: "11",
      courierName: "FastEx",
      shippingCost: 65,
      codAmount: 740,
    });
    expect(row.operationToken).toEqual(expect.any(String));
    expect(dbHolder.current.calls.onConflict[0]).toBeUndefined();
  });

  it("resumes at AWB when the provider order was already persisted", async () => {
    const staged = {
      ...SHIPMENT,
      externalOrderId: "sr-order-1",
      externalShipmentId: "sr-shipment-1",
    };
    dbHolder.current = makeDbMock({ selectQueue: bookQueues(staged) });

    await bookShiprocketShipment("order-1", PARCEL);

    expect(createShiprocketOrder).not.toHaveBeenCalled();
    expect(assignShiprocketAwb).toHaveBeenCalled();
  });

  it("resumes at label when AWB was already persisted", async () => {
    const staged = {
      ...SHIPMENT,
      externalOrderId: "sr-order-1",
      externalShipmentId: "sr-shipment-1",
      awb: "AWB123",
    };
    dbHolder.current = makeDbMock({ selectQueue: bookQueues(staged) });

    await bookShiprocketShipment("order-1", PARCEL);

    expect(createShiprocketOrder).not.toHaveBeenCalled();
    expect(assignShiprocketAwb).not.toHaveBeenCalled();
    expect(generateShiprocketLabel).toHaveBeenCalled();
  });

  it("reuses a persisted label and does not generate another", async () => {
    const staged = {
      ...SHIPMENT,
      externalOrderId: "sr-order-1",
      externalShipmentId: "sr-shipment-1",
      awb: "AWB123",
      labelUrl: "https://label.test/existing.pdf",
    };
    dbHolder.current = makeDbMock({ selectQueue: bookQueues(staged) });

    await bookShiprocketShipment("order-1", PARCEL);

    expect(generateShiprocketLabel).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.set).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "ready_to_ship",
          labelUrl: "https://label.test/existing.pdf",
        }),
      ]),
    );
  });

  it("records provider failure on the local row and clears its lease", async () => {
    vi.mocked(createShiprocketOrder).mockRejectedValue(
      new Error("Shiprocket timeout"),
    );
    dbHolder.current = makeDbMock({
      selectQueue: [
        [ORDER],
        [LINE],
        [{ locationId: "location-1", pickupCode: "ACME" }],
        [SHIPMENT],
        ...viewQueues({
          ...SHIPMENT,
          status: "error",
          lastError: "Shiprocket timeout",
        }),
      ],
    });

    const result = await bookShiprocketShipment("order-1", PARCEL);

    expect(result.error).toBe("Shiprocket timeout");
    expect(dbHolder.current.calls.set).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "error",
          lastError: "Shiprocket timeout",
          operationToken: null,
          operationLeaseUntil: null,
        }),
      ]),
    );
    expect(assignShiprocketAwb).not.toHaveBeenCalled();
  });
});

describe("pickup scheduling and tracking", () => {
  it("requires a Shiprocket provider shipment before scheduling pickup", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...SHIPMENT, provider: "manual" }]],
    });
    expect(await scheduleShipmentPickup("shipment-1")).toEqual({
      error: "This Shiprocket shipment is not ready for pickup.",
    });
    expect(scheduleProviderPickup).not.toHaveBeenCalled();
  });

  it("treats manifest generation as optional after pickup succeeds", async () => {
    vi.mocked(generateShiprocketManifest).mockRejectedValue(
      new Error("manifest pending"),
    );
    const ready = {
      ...SHIPMENT,
      status: "ready_to_ship",
      externalShipmentId: "sr-shipment-1",
      awb: "AWB123",
    };
    dbHolder.current = makeDbMock({
      selectQueue: [
        [ready],
        ...viewQueues({ ...ready, status: "pickup_scheduled" }),
      ],
    });

    const result = await scheduleShipmentPickup("shipment-1");

    expect(result.success).toBe(true);
    expect(scheduleProviderPickup).toHaveBeenCalledWith(
      "shiprocket-token",
      "sr-shipment-1",
    );
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status: "pickup_scheduled",
      manifestUrl: null,
    });
    expect(recordShipmentTrackingUpdate).toHaveBeenCalledWith(
      "shipment-1",
      expect.objectContaining({ status: "pickup_scheduled" }),
    );
  });

  it("refreshes every parsed tracking scan in provider order", async () => {
    const tracked = { ...SHIPMENT, awb: "AWB123" };
    const updates = [
      { status: "picked_up", occurredAt: "2026-08-14T09:00:00Z" },
      { status: "in_transit", occurredAt: "2026-08-14T10:00:00Z" },
    ] as any;
    vi.mocked(parseShiprocketTracking).mockReturnValue(updates);
    dbHolder.current = makeDbMock({
      selectQueue: [
        [tracked],
        ...viewQueues({ ...tracked, status: "in_transit" }),
      ],
    });

    const result = await refreshShipmentTracking("shipment-1");

    expect(result.success).toBe(true);
    expect(getShiprocketSessionForStore).toHaveBeenCalledWith("store-1", false);
    expect(trackShiprocketAwb).toHaveBeenCalledWith(
      "shiprocket-token",
      "AWB123",
    );
    expect(recordShipmentTrackingUpdate).toHaveBeenNthCalledWith(
      1,
      "shipment-1",
      updates[0],
    );
    expect(recordShipmentTrackingUpdate).toHaveBeenNthCalledWith(
      2,
      "shipment-1",
      updates[1],
    );
  });

  it("does not track a foreign, manual or AWB-less shipment", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect(await refreshShipmentTracking("shipment-1")).toEqual({
      error: "No Shiprocket AWB to track.",
    });
    expect(trackShiprocketAwb).not.toHaveBeenCalled();
  });
});

describe("NDR and cancellation", () => {
  it("accepts NDR actions only for an actionable Shiprocket NDR", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...SHIPMENT, status: "in_transit" }]],
    });
    expect(
      await submitShipmentNdrAction("shipment-1", "return", "Customer refused"),
    ).toEqual({ error: "This shipment does not have an actionable NDR." });
    expect(actOnShiprocketNdr).not.toHaveBeenCalled();
  });

  it.each([
    ["re-attempt", "in_transit"],
    ["return", "rto_initiated"],
  ] as const)("maps the %s NDR action to %s", async (action, status) => {
    const ndr = { ...SHIPMENT, status: "ndr", awb: "AWB123" };
    dbHolder.current = makeDbMock({
      selectQueue: [[ndr], ...viewQueues({ ...ndr, status })],
    });
    const longComment = `  ${"x".repeat(600)}  `;

    const result = await submitShipmentNdrAction(
      "shipment-1",
      action,
      longComment,
    );

    expect(result.success).toBe(true);
    expect(actOnShiprocketNdr).toHaveBeenCalledWith(
      "shiprocket-token",
      "AWB123",
      action,
      "x".repeat(500),
    );
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status,
      ndrReason: "x".repeat(500),
    });
  });

  it("blocks cancellation once the parcel has been collected", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...SHIPMENT, status: "in_transit" }]],
    });
    expect((await cancelShipment("shipment-1")).error).toMatch(
      /collected parcel/i,
    );
    expect(cancelShiprocketAwb).not.toHaveBeenCalled();
  });

  it("cancels the provider AWB before marking the local shipment cancelled", async () => {
    const ready = { ...SHIPMENT, status: "ready_to_ship", awb: "AWB123" };
    dbHolder.current = makeDbMock({
      selectQueue: [[ready], ...viewQueues({ ...ready, status: "cancelled" })],
    });

    const result = await cancelShipment("shipment-1");

    expect(result.success).toBe(true);
    expect(cancelShiprocketAwb).toHaveBeenCalledWith(
      "shiprocket-token",
      "AWB123",
    );
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status: "cancelled",
    });
  });

  it("cancels a manual shipment locally without calling Shiprocket", async () => {
    const manual = { ...SHIPMENT, provider: "manual", status: "ready_to_ship" };
    dbHolder.current = makeDbMock({
      selectQueue: [
        [manual],
        ...viewQueues({ ...manual, status: "cancelled" }),
      ],
    });
    expect((await cancelShipment("shipment-1")).success).toBe(true);
    expect(cancelShiprocketAwb).not.toHaveBeenCalled();
  });
});

describe("retryShiprocketShipment", () => {
  it("only retries Shiprocket rows in booking or error", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...SHIPMENT, provider: "manual" }]],
    });
    expect(await retryShiprocketShipment("shipment-1")).toEqual({
      error: "Shiprocket shipment not found.",
    });

    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...SHIPMENT, status: "ready_to_ship" }]],
    });
    expect(await retryShiprocketShipment("shipment-1")).toEqual({
      error: "This shipment does not need a booking retry.",
    });
  });

  it("re-enters the staged booking flow using the persisted parcel", async () => {
    const failed = { ...SHIPMENT, status: "error" };
    dbHolder.current = makeDbMock({
      selectQueue: [[failed], ...bookQueues(failed)],
    });

    const result = await retryShiprocketShipment("shipment-1");

    expect(result.success).toBe(true);
    expect(createShiprocketOrder).toHaveBeenCalled();
  });
});

describe("createManualShipment", () => {
  const INPUT = {
    ...PARCEL,
    courierName: " Local Courier ",
    awb: " TRACK-123 ",
    trackingUrl: " https://courier.test/TRACK-123 ",
  };

  it("requires orders access and courier evidence", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null);
    expect(await createManualShipment("order-1", INPUT)).toEqual({
      error: "Not authenticated.",
    });

    vi.mocked(getManagerIdentity).mockResolvedValue({ uid: "admin-1" } as any);
    expect(
      (
        await createManualShipment("order-1", {
          ...INPUT,
          courierName: "",
        })
      ).error,
    ).toMatch(/courier and tracking number/i);
  });

  it("rejects pickup and digital-only orders", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...ORDER, fulfilmentType: "pickup" }], [LINE]],
    });
    expect((await createManualShipment("order-1", INPUT)).error).toMatch(
      /delivery order not found/i,
    );

    dbHolder.current = makeDbMock({
      selectQueue: [[ORDER], [{ ...LINE, requiresShipping: false }]],
    });
    expect((await createManualShipment("order-1", INPUT)).error).toMatch(
      /no physical items/i,
    );
  });

  it("records one idempotent picked-up shipment and its physical items", async () => {
    const manual = {
      ...SHIPMENT,
      provider: "manual",
      status: "picked_up",
      awb: "TRACK-123",
      courierName: "Local Courier",
      trackingUrl: "https://courier.test/TRACK-123",
    };
    dbHolder.current = makeDbMock({
      selectQueue: [[ORDER], [LINE], ...viewQueues(manual)],
      returning: [{ id: "shipment-1" }],
    });

    const result = await createManualShipment("order-1", INPUT);

    expect(result.success).toBe(true);
    expect(dbHolder.current.calls.insert[0]).toBe(shipments);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      orderId: "order-1",
      fulfilmentOrderId: "fulfilment-1",
      provider: "manual",
      status: "picked_up",
      idempotencyKey: "order-1:fulfilment-1:manual:1",
      awb: "TRACK-123",
      courierName: "Local Courier",
      trackingUrl: "https://courier.test/TRACK-123",
    });
    expect(dbHolder.current.calls.insert[1]).toBe(shipmentItems);
    expect(recordShipmentTrackingUpdate).toHaveBeenCalledWith(
      "shipment-1",
      expect.objectContaining({
        status: "picked_up",
        externalCode: "manual",
      }),
    );
  });

  it("recovers the existing id after an idempotent insert conflict", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [ORDER],
        [LINE],
        [{ id: "shipment-existing" }],
        ...viewQueues({
          ...SHIPMENT,
          id: "shipment-existing",
          provider: "manual",
        }),
      ],
      returning: [],
    });

    const result = await createManualShipment("order-1", INPUT);

    expect(result.success).toBe(true);
    expect(recordShipmentTrackingUpdate).toHaveBeenCalledWith(
      "shipment-existing",
      expect.anything(),
    );
  });

  it("validates parcel dimensions before writing", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[ORDER], [LINE]] });
    const result = await createManualShipment("order-1", {
      ...INPUT,
      weightGrams: 0,
    });
    expect(result.error).toMatch(/weight must be greater than zero/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });
});

describe("store scope remains explicit on shipment lookups", () => {
  it("filters a shipment id by the acting store before every state change", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await cancelShipment("shipment-foreign");
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["shipment-foreign", "store-1"]),
    );
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(orders).toBeTruthy();
    expect(fulfilmentOrders).toBeTruthy();
  });
});
