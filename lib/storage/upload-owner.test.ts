/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

const state = vi.hoisted(() => ({
  host: "echos.storemink.com",
  db: null as any,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: state.host })),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(state.db))),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: vi.fn(async () => ({ id: "store-1" })),
}));

import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { resolveUploadOwner } from "./upload-owner";

describe("resolveUploadOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.host = "echos.storemink.com";
    state.db = makeDbMock().db;
    vi.mocked(getCurrentStoreOrNull).mockResolvedValue({
      id: "store-1",
    } as never);
  });

  it("authorizes a member and binds the immutable store id", async () => {
    state.db = makeDbMock({
      // admin, customer, POS staff, platform operator
      selectQueue: [[{ id: "user-1" }], [], [], []],
    }).db;

    await expect(
      resolveUploadOwner({ id: "user-1", email: "owner@example.com" }),
    ).resolves.toEqual({ kind: "store", storeId: "store-1" });
  });

  it("rejects a signed-in user with no relationship to the host store", async () => {
    state.db = makeDbMock({ selectQueue: [[], [], [], []] }).db;

    await expect(
      resolveUploadOwner({ id: "outsider", email: "other@example.com" }),
    ).resolves.toBeNull();
  });

  it("allows platform uploads only for an allowlisted operator", async () => {
    state.host = "storemink.com";
    state.db = makeDbMock({ selectQueue: [[{ id: "operator-1" }]] }).db;
    await expect(
      resolveUploadOwner({ id: "user-1", email: "op@storemink.com" }),
    ).resolves.toEqual({ kind: "platform" });
    expect(getCurrentStoreOrNull).not.toHaveBeenCalled();

    state.db = makeDbMock({ selectQueue: [[]] }).db;
    await expect(
      resolveUploadOwner({ id: "user-2", email: "shopper@example.com" }),
    ).resolves.toBeNull();
  });
});
