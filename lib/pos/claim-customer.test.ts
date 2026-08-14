import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
const withService = vi.fn();

vi.mock("@/lib/db/client", () => ({
  withService: (fn: (db: unknown) => unknown) => withService(fn),
}));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { claimPosCustomer } from "./claim-customer";

/** The SQL the last call actually sent, flattened for assertion. */
function lastSql(): string {
  const arg = execute.mock.calls.at(-1)?.[0] as
    | { queryChunks?: unknown[] }
    | undefined;
  return JSON.stringify(arg ?? {});
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS — restore both explicitly
  // every time (AGENTS.md convention #8), or a rejection set in one test leaks.
  execute.mockResolvedValue({ rowCount: 0, rows: [] });
  withService.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ execute }),
  );
});

const INPUT = {
  uid: "firebaseUid123",
  storeId: "a0000000-0000-4000-8000-000000000001",
  verifiedPhone: "+91 98765 43210",
};

describe("claimPosCustomer", () => {
  it("claims when the statement matched a row", async () => {
    execute.mockResolvedValue({ rowCount: 1, rows: [{ id: INPUT.uid }] });
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: true });
  });

  it("reports no claim when nothing matched", async () => {
    execute.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
  });

  // The driver returns a Result; several mocks return a bare array. The
  // exactly-once guarantee is read from this number, so both must agree.
  it("reads a row count from a bare array too", async () => {
    execute.mockResolvedValue([{ id: INPUT.uid }]);
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: true });
    execute.mockResolvedValue([]);
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
  });

  it("does not query at all without a verified phone", async () => {
    await expect(
      claimPosCustomer({ ...INPUT, verifiedPhone: null }),
    ).resolves.toEqual({ claimed: false });
    expect(execute).not.toHaveBeenCalled();
  });

  // ★ An unusable phone can never match a signup, so asking is wasted work —
  // and storing one would have been the real bug upstream.
  it("does not query on an unparseable phone", async () => {
    await expect(
      claimPosCustomer({ ...INPUT, verifiedPhone: "12345" }),
    ).resolves.toEqual({ claimed: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not query without a uid or a store", async () => {
    await claimPosCustomer({ ...INPUT, uid: "" });
    await claimPosCustomer({ ...INPUT, storeId: "" });
    expect(execute).not.toHaveBeenCalled();
  });

  // ★ NEVER THROWS. A failed claim costs a link to in-store history; a thrown
  // one would cost the shopper their signup.
  it("swallows a database failure rather than failing the signup", async () => {
    execute.mockRejectedValue(new Error("connection reset"));
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
  });

  it("swallows a failure to even open the transaction", async () => {
    withService.mockRejectedValue(new Error("pool exhausted"));
    await expect(claimPosCustomer(INPUT)).resolves.toEqual({ claimed: false });
  });

  describe("the four guards are all in the statement", () => {
    beforeEach(async () => {
      await claimPosCustomer(INPUT);
    });

    it("scopes to the store", () => {
      expect(lastSql()).toContain("store_id");
    });

    it("matches on the normalised phone, not the raw input", () => {
      const sent = lastSql();
      expect(sent).toContain("9876543210");
      expect(sent).not.toContain("+91 98765 43210");
    });

    // ★ Without this a signup could take over another signup's row.
    it("requires a pos_ id", () => {
      expect(lastSql()).toContain("pos\\\\_%");
    });

    // ★ Without this one customer's history goes to whoever typed their number.
    it("requires claimed_at to be null", () => {
      expect(lastSql()).toContain("claimed_at is null");
    });

    // ★ Without this a returning shopper hits a raw primary-key violation on a
    // profile save instead of a clean no-op.
    it("requires the uid to have no row of its own yet", () => {
      expect(lastSql()).toContain("not exists");
    });

    it("stamps claimed_at so the row can never be adopted twice", () => {
      expect(lastSql()).toContain("claimed_at = now()");
    });
  });
});
