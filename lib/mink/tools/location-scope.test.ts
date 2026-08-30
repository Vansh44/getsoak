import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkActorContext } from "../types";

const holder = vi.hoisted(() => ({ withUser: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withUser: holder.withUser }));

import { resolveMinkLocation } from "./location-scope";

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "member",
  permissions: {},
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: ["location-1"],
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  holder.withUser.mockResolvedValue([
    { id: "location-1", name: "Main Store", type: "shop" },
  ]);
});

describe("resolveMinkLocation", () => {
  it("resolves an exact accessible name to the trusted server ID", async () => {
    await expect(resolveMinkLocation(ACTOR, " main store ")).resolves.toEqual({
      locationIds: ["location-1"],
      selectedId: "location-1",
      label: "Main Store",
      includeUnassigned: false,
    });
  });

  it("resolves an accessible name paired with its displayed location type", async () => {
    holder.withUser.mockResolvedValue([
      { id: "location-1", name: "Delhi", type: "warehouse" },
    ]);

    await expect(
      resolveMinkLocation(ACTOR, " Delhi   warehouse "),
    ).resolves.toEqual({
      locationIds: ["location-1"],
      selectedId: "location-1",
      label: "Delhi",
      includeUnassigned: false,
    });
    await expect(
      resolveMinkLocation(ACTOR, "warehouse Delhi"),
    ).resolves.toMatchObject({
      selectedId: "location-1",
      label: "Delhi",
    });
  });

  it("does not treat the wrong location type as an alias", async () => {
    holder.withUser.mockResolvedValue([
      { id: "location-1", name: "Delhi", type: "warehouse" },
    ]);

    await expect(
      resolveMinkLocation(ACTOR, "Delhi shop"),
    ).rejects.toMatchObject({
      name: "MinkToolInputError",
    });
  });

  it("rejects a name-and-type alias that is not unique", async () => {
    holder.withUser.mockResolvedValue([
      { id: "location-1", name: "Delhi", type: "warehouse" },
      { id: "location-2", name: "Delhi", type: "warehouse" },
    ]);

    await expect(
      resolveMinkLocation(ACTOR, "Delhi warehouse"),
    ).rejects.toMatchObject({
      name: "MinkToolInputError",
    });
  });

  it("keeps a bound actor in their aggregate assigned scope", async () => {
    await expect(resolveMinkLocation(ACTOR, undefined)).resolves.toEqual({
      locationIds: ["location-1"],
      selectedId: null,
      label: "1 assigned location",
      includeUnassigned: true,
    });
  });

  it("rejects a named inaccessible location instead of falling back", async () => {
    await expect(
      resolveMinkLocation(ACTOR, "Rival Shop"),
    ).rejects.toMatchObject({ name: "MinkToolInputError" });
  });

  it("never queries locations for an actor explicitly assigned none", async () => {
    await expect(
      resolveMinkLocation({ ...ACTOR, locationIds: [] }, undefined),
    ).resolves.toMatchObject({
      locationIds: [],
      label: "No assigned active locations",
    });
    expect(holder.withUser).not.toHaveBeenCalled();
  });
});
