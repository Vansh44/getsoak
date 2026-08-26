/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "store-1"),
  getManagerIdentity: vi.fn(),
  getViewerContext: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/permissions", () => ({
  can: vi.fn(() => true),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  getStorePlanContext: vi.fn(async () => ({
    plan: "basic",
    limits: { shippingIntegration: true },
  })),
  storeAllowsPlanFeature: vi.fn(async () => true),
}));
vi.mock("@/lib/payments/crypto", () => ({
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
}));
vi.mock("@/lib/logistics/connection", () => ({
  getShiprocketSessionForStore: vi.fn(),
  hashWebhookSecret: vi.fn((value: string) => `hash:${value}`),
  newWebhookSecret: vi.fn(() => "plain-webhook-secret"),
  shiprocketWebhookUrl: vi.fn(
    (id: string) =>
      `https://staging.storemink.com/api/webhooks/logistics/${id}`,
  ),
}));
vi.mock("@/lib/logistics/shiprocket", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logistics/shiprocket")>();
  return {
    ...actual,
    addShiprocketPickup: vi.fn(),
    shiprocketLogin: vi.fn(),
  };
});

import {
  getManagerIdentity,
  getViewerContext,
} from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { encryptSecret } from "@/lib/payments/crypto";
import {
  getShiprocketSessionForStore,
  hashWebhookSecret,
  newWebhookSecret,
  shiprocketWebhookUrl,
} from "@/lib/logistics/connection";
import {
  addShiprocketPickup,
  ShiprocketError,
  shiprocketLogin,
} from "@/lib/logistics/shiprocket";
import {
  locationLogisticsMappings,
  storeLogisticsProviders,
} from "@/drizzle/schema";
import {
  disconnectShiprocket,
  getShiprocketChannelState,
  rotateShiprocketWebhookSecret,
  saveShiprocketCredentials,
  setShiprocketEnabled,
  syncShiprocketPickupLocations,
} from "./logistics-provider-actions";

const SESSION = {
  id: "connection-1",
  token: "token-1",
  email: "api@acme.test",
  expiresAt: new Date("2026-08-15T00:00:00.000Z"),
};

const CAPABILITIES = {
  pos: false,
  online_fulfil: true,
  pickup: false,
  returns: false,
  receive_stock: true,
  transfer_stock: true,
};

const LOCATION = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Main Warehouse",
  type: "warehouse",
  capabilities: CAPABILITIES,
  address: {
    line1: "Connaught Place",
    line2: "Flat 12, Radial Road",
    city: "New Delhi",
    state: "Delhi",
    postalCode: "110001",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbHolder.current = makeDbMock();
  vi.mocked(getViewerContext).mockResolvedValue({
    profile: { id: "admin-1" },
    permissions: {},
    isSuperadmin: true,
  } as any);
  vi.mocked(getManagerIdentity).mockResolvedValue({
    uid: "admin-1",
    email: "owner@acme.test",
  });
  vi.mocked(can).mockReturnValue(true);
  vi.mocked(shiprocketLogin).mockResolvedValue(SESSION);
  vi.mocked(getShiprocketSessionForStore).mockResolvedValue(SESSION as any);
  vi.mocked(addShiprocketPickup).mockResolvedValue({ pickup_id: 42 } as any);
});

describe("getShiprocketChannelState", () => {
  it("returns no channel metadata without channels.view", async () => {
    vi.mocked(getViewerContext).mockResolvedValue(null);
    expect(await getShiprocketChannelState()).toEqual({
      connected: false,
      enabled: false,
      accountEmail: null,
      connectionId: null,
      webhookUrl: null,
      mappedLocations: 0,
      eligibleLocations: 0,
      availableOnPlan: false,
    });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("enforces the permission map for a signed-in profile", async () => {
    vi.mocked(can).mockReturnValue(false);
    await getShiprocketChannelState();
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("returns only safe account state and counts eligible warehouses", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "connection-1",
            email: "api@acme.test",
            enabled: true,
          },
        ],
        [
          { type: "warehouse", capabilities: CAPABILITIES },
          {
            type: "shop",
            capabilities: { ...CAPABILITIES, online_fulfil: false },
          },
          { type: "unknown", capabilities: CAPABILITIES },
        ],
        [{ id: "mapping-1" }, { id: "mapping-2" }],
      ],
    });

    expect(await getShiprocketChannelState()).toEqual({
      connected: true,
      enabled: true,
      accountEmail: "api@acme.test",
      connectionId: "connection-1",
      webhookUrl:
        "https://staging.storemink.com/api/webhooks/logistics/connection-1",
      mappedLocations: 2,
      eligibleLocations: 1,
      availableOnPlan: true,
    });
    for (const condition of dbHolder.current.calls.where) {
      expect(sqlParamValues(condition)).toContain("store-1");
    }
  });

  it("fails closed when channel state cannot be read", async () => {
    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const result = await getShiprocketChannelState();
    expect(result.connected).toBe(false);
    expect(result.accountEmail).toBeNull();
  });
});

describe("saveShiprocketCredentials", () => {
  it("requires channels.manage before authenticating with the provider", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null);
    expect(
      await saveShiprocketCredentials("api@acme.test", "password"),
    ).toEqual({ error: "You don't have permission to do this." });
    expect(shiprocketLogin).not.toHaveBeenCalled();
  });

  it.each([
    ["bad-address", "password", /enter the email/i],
    ["api@acme.test", "short", /api user password/i],
    ["api@acme.test", "x".repeat(501), /api user password/i],
  ])("validates credentials locally (%s)", async (email, password, message) => {
    expect((await saveShiprocketCredentials(email, password)).error).toMatch(
      message,
    );
    expect(shiprocketLogin).not.toHaveBeenCalled();
  });

  it("does not store credentials the provider rejects", async () => {
    vi.mocked(shiprocketLogin).mockRejectedValue(new Error("Invalid login"));
    expect(
      (await saveShiprocketCredentials(" API@Acme.Test ", " good-password "))
        .error,
    ).toBe("Shiprocket rejected these credentials: Invalid login");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("encrypts password and token, hashes the webhook secret, and upserts one row", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "connection-1" }] });

    const result = await saveShiprocketCredentials(
      " API@Acme.Test ",
      " good-password ",
    );

    expect(result).toEqual({
      success: true,
      webhookSecret: "plain-webhook-secret",
      webhookUrl:
        "https://staging.storemink.com/api/webhooks/logistics/connection-1",
    });
    expect(shiprocketLogin).toHaveBeenCalledWith(
      "api@acme.test",
      "good-password",
    );
    expect(encryptSecret).toHaveBeenCalledWith("good-password");
    expect(encryptSecret).toHaveBeenCalledWith("token-1");
    expect(hashWebhookSecret).toHaveBeenCalledWith("plain-webhook-secret");
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      provider: "shiprocket",
      accountEmail: "api@acme.test",
      credentialSecretEnc: "encrypted:good-password",
      tokenEnc: "encrypted:token-1",
      webhookSecretHash: "hash:plain-webhook-secret",
      enabled: true,
    });
    expect(dbHolder.current.calls.onConflict).toHaveLength(1);
  });

  it("never writes a connection if the upsert fails", async () => {
    dbHolder.current.db.insert = vi.fn(() => {
      throw new Error("write failed");
    });
    expect(
      (await saveShiprocketCredentials("api@acme.test", "good-password")).error,
    ).toMatch(/could not save/i);
  });
});

describe("connection lifecycle", () => {
  it("enables and pauses only the acting store's Shiprocket row", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "connection-1" }] });
    expect(await setShiprocketEnabled(false)).toEqual({ success: true });
    expect(dbHolder.current.calls.update[0]).toBe(storeLogisticsProviders);
    expect(dbHolder.current.calls.set[0]).toMatchObject({ enabled: false });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["store-1", "shiprocket"]),
    );
  });

  it("does not pretend a missing connection was enabled", async () => {
    dbHolder.current = makeDbMock({ returning: [] });
    expect(await setShiprocketEnabled(true)).toEqual({
      error: "Connect Shiprocket first.",
    });
  });

  it("rotates a write-only webhook secret for the acting store", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "connection-1" }] });
    expect(await rotateShiprocketWebhookSecret()).toEqual({
      success: true,
      webhookSecret: "plain-webhook-secret",
      webhookUrl:
        "https://staging.storemink.com/api/webhooks/logistics/connection-1",
    });
    expect(newWebhookSecret).toHaveBeenCalled();
    expect(dbHolder.current.calls.set[0].webhookSecretHash).toBe(
      "hash:plain-webhook-secret",
    );
  });

  it("deletes mappings before the credential row while preserving shipment evidence", async () => {
    expect(await disconnectShiprocket()).toEqual({ success: true });
    expect(dbHolder.current.calls.delete).toEqual([
      locationLogisticsMappings,
      storeLogisticsProviders,
    ]);
    expect(dbHolder.current.calls.where).toHaveLength(2);
    expect(
      dbHolder.current.calls.where.every((condition: unknown) =>
        sqlParamValues(condition).includes("store-1"),
      ),
    ).toBe(true);
  });

  it("contains disconnect failures", async () => {
    dbHolder.current.db.delete = vi.fn(() => {
      throw new Error("database unavailable");
    });
    expect(await disconnectShiprocket()).toEqual({
      error: "Could not disconnect Shiprocket.",
    });
  });
});

describe("syncShiprocketPickupLocations", () => {
  it("requires channels.manage and an enabled provider session", async () => {
    vi.mocked(getManagerIdentity).mockResolvedValue(null);
    expect(await syncShiprocketPickupLocations()).toEqual({
      error: "You don't have permission to do this.",
    });

    vi.mocked(getManagerIdentity).mockResolvedValue({ uid: "admin-1" } as any);
    vi.mocked(getShiprocketSessionForStore).mockRejectedValue(
      new Error("Shiprocket is paused."),
    );
    expect(await syncShiprocketPickupLocations()).toEqual({
      error: "Shiprocket is paused.",
    });
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("requires a business or manager phone before sending warehouse data", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [LOCATION],
        [{ email: "billing@acme.test", phone: "" }],
        [{ email: "owner@acme.test", phone: "" }],
      ],
    });
    expect((await syncShiprocketPickupLocations()).error).toMatch(
      /add a business contact phone/i,
    );
    expect(addShiprocketPickup).not.toHaveBeenCalled();
  });

  it("returns an honest empty result when no location can fulfil online", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            ...LOCATION,
            capabilities: { ...CAPABILITIES, online_fulfil: false },
          },
        ],
        [{ email: "billing@acme.test", phone: "+91 98765 43210" }],
        [],
      ],
    });
    expect(await syncShiprocketPickupLocations()).toEqual({
      success: false,
      synced: 0,
      skipped: [],
      error: "No active location is enabled for online fulfilment.",
    });
  });

  it("names an incomplete warehouse and never substitutes another address", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ ...LOCATION, address: { ...LOCATION.address, postalCode: "bad" } }],
        [{ email: "billing@acme.test", phone: "+91 98765 43210" }],
        [],
      ],
    });
    const result = await syncShiprocketPickupLocations();
    expect(result).toMatchObject({
      success: false,
      synced: 0,
      skipped: [
        {
          location: "Main Warehouse",
          reason: expect.stringMatching(/complete house\/flat/i),
        },
      ],
    });
    expect(addShiprocketPickup).not.toHaveBeenCalled();
  });

  it("uses billing contact first, promotes the detailed address, and upserts a stable mapping", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [LOCATION],
        [{ email: "billing@acme.test", phone: "+91 98765 43210" }],
        [{ email: "owner@acme.test", phone: "9999999999" }],
      ],
    });

    const result = await syncShiprocketPickupLocations();

    expect(result).toEqual({ success: true, synced: 1, skipped: [] });
    expect(addShiprocketPickup).toHaveBeenCalledWith(
      "token-1",
      expect.objectContaining({
        pickup_location: "SM1111111111114111811111111111",
        email: "billing@acme.test",
        phone: "+919876543210",
        address: "Flat 12, Radial Road",
        address_2: "Connaught Place",
        pin_code: "110001",
      }),
    );
    expect(dbHolder.current.calls.insert[0]).toBe(locationLogisticsMappings);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "store-1",
      locationId: LOCATION.id,
      provider: "shiprocket",
      externalPickupCode: "SM1111111111114111811111111111",
      externalLocationId: "42",
    });
    expect(dbHolder.current.calls.onConflict).toHaveLength(1);
  });

  it("treats a provider duplicate as a successful re-sync of the stable code", async () => {
    vi.mocked(addShiprocketPickup).mockRejectedValue(
      new ShiprocketError("Pickup location already exists", 422),
    );
    dbHolder.current = makeDbMock({
      selectQueue: [
        [LOCATION],
        [{ email: "billing@acme.test", phone: "9876543210" }],
        [],
      ],
    });

    const result = await syncShiprocketPickupLocations();

    expect(result).toMatchObject({ success: true, synced: 1, skipped: [] });
    expect(dbHolder.current.calls.values[0].externalLocationId).toBeNull();
  });

  it("skips one provider failure but continues syncing the next warehouse", async () => {
    vi.mocked(addShiprocketPickup)
      .mockRejectedValueOnce(new ShiprocketError("PIN not serviceable", 422))
      .mockResolvedValueOnce({ pickup_id: 99 } as any);
    const second = {
      ...LOCATION,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Backup Warehouse",
    };
    dbHolder.current = makeDbMock({
      selectQueue: [
        [LOCATION, second],
        [{ email: "billing@acme.test", phone: "9876543210" }],
        [],
      ],
    });

    const result = await syncShiprocketPickupLocations();

    expect(result).toMatchObject({
      success: true,
      synced: 1,
      skipped: [{ location: "Main Warehouse", reason: "PIN not serviceable" }],
    });
    expect(dbHolder.current.calls.values).toHaveLength(1);
    expect(dbHolder.current.calls.values[0].locationId).toBe(second.id);
  });
});

describe("secret handling", () => {
  it("never exposes an encrypted credential or provider token in channel state", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "connection-1", email: "api@acme.test", enabled: true }],
        [],
        [],
      ],
    });
    const state = await getShiprocketChannelState();
    expect(state).not.toHaveProperty("credentialSecretEnc");
    expect(state).not.toHaveProperty("tokenEnc");
    expect(state).not.toHaveProperty("webhookSecret");
    expect(shiprocketWebhookUrl).toHaveBeenCalledWith("connection-1");
  });
});
