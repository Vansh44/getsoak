import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  withService: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withService: holder.withService,
}));

import {
  getMinkStoreAccess,
  isMinkStoreInvited,
  requireMinkStoreInvite,
} from "./access";

beforeEach(() => {
  vi.clearAllMocks();
  holder.withService.mockResolvedValue([
    { enabled: true, draftingEnabled: true },
  ]);
});

describe("Mink invited-store access", () => {
  it("allows only an explicitly enabled store row", async () => {
    await expect(isMinkStoreInvited("store-1")).resolves.toBe(true);

    holder.withService.mockResolvedValueOnce([{ enabled: false }]);
    await expect(isMinkStoreInvited("store-2")).resolves.toBe(false);

    holder.withService.mockResolvedValueOnce([]);
    await expect(isMinkStoreInvited("store-3")).resolves.toBe(false);
  });

  it("requires both gates before exposing drafting", async () => {
    await expect(getMinkStoreAccess("store-1")).resolves.toEqual({
      enabled: true,
      draftingEnabled: true,
    });
    holder.withService.mockResolvedValueOnce([
      { enabled: false, draftingEnabled: true },
    ]);
    await expect(getMinkStoreAccess("store-2")).resolves.toEqual({
      enabled: false,
      draftingEnabled: false,
    });
  });

  it("fails closed when the invitation table cannot be read", async () => {
    holder.withService.mockRejectedValue(new Error("database unavailable"));

    await expect(isMinkStoreInvited("store-1")).resolves.toBe(false);
    await expect(requireMinkStoreInvite("store-1", true)).rejects.toMatchObject(
      {
        code: "mink_beta_not_invited",
        status: 403,
      },
    );
  });

  it("bypasses only invitation eligibility while preserving drafting opt-in", async () => {
    await expect(requireMinkStoreInvite("store-1", false)).resolves.toEqual({
      enabled: true,
      draftingEnabled: true,
    });
    expect(holder.withService).toHaveBeenCalledOnce();

    holder.withService.mockResolvedValueOnce([]);
    await expect(requireMinkStoreInvite("store-2", false)).resolves.toEqual({
      enabled: true,
      draftingEnabled: false,
    });
  });
});
