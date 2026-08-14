/* eslint-disable @typescript-eslint/no-explicit-any */
// The collection path.
//
// ── What matters here ──────────────────────────────────────────────────────
// This is the only place in billing where money actually moves, so the tests
// are about ORDER and about which failures are allowed to look like which
// answers:
//
//   • the attempt row is written BEFORE the gateway is called, or a killed
//     process loses a payment silently;
//   • an UNKNOWN outcome is never reported as a failure and never retried
//     (Rule 1, Rule 6) — that is what stops a merchant being charged twice;
//   • an amount that needs the merchant to authenticate is routed away from
//     automatic collection rather than attempted and failed, because a failed
//     attempt starts a grace clock and "can't be auto-collected" must not.
//
// ⚠ The one-in-flight guarantee itself is a partial UNIQUE index in Postgres,
// proved by supabase/billing_verify.sql. Here we only prove this layer reads a
// conflict as "already collecting" instead of as an error.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "@/app/actions/_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const receipts = vi.hoisted(() => ({ notifyInvoicePaid: vi.fn() }));
vi.mock("./receipts", () => receipts);

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

import {
  beginAttempt,
  collectInvoice,
  mapGatewayStatus,
  settleAttempt,
  type ChargeFn,
} from "./collect";
import { AFA_EXEMPT_LIMIT_PAISE } from "./cycle";

const INVOICE = "inv-1";
const STORE = "store-1";
const ATTEMPT = "att-1";

const MANDATE = {
  id: "man-1",
  status: "active" as const,
  maxAmountPaise: 27_000_00,
  providerTokenId: "tok_live_1",
};

function seed(opts: { selects?: any[][]; returning?: any[] } = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: opts.selects ?? [],
    returning: opts.returning ?? [{ id: ATTEMPT }],
  });
}

/** A charge fn that records how it was called. */
function chargeOk(status = "captured") {
  const fn = vi.fn(async () => ({
    ok: true as const,
    data: { providerPaymentId: "pay_1", status },
  }));
  return fn as unknown as ChargeFn & { mock: any };
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("mapGatewayStatus", () => {
  it.each([
    ["captured", "captured"],
    ["authorized", "authorized"],
    ["failed", "failed"],
    ["refunded", "refunded"],
    ["created", "processing"],
    ["pending", "processing"],
  ])("maps %s -> %s", (given, want) => {
    expect(mapGatewayStatus(given)).toBe(want);
  });

  it("★ maps anything UNRECOGNISED to unknown, never to failed", () => {
    // A status we do not understand is missing information. Calling it a
    // failure would start a grace clock and could trigger a second charge.
    for (const s of ["weird", "", "CAPTURED_LATER", "queued"]) {
      expect(mapGatewayStatus(s)).toBe("unknown");
    }
  });
});

describe("beginAttempt", () => {
  it("writes the row with OUR idempotency key before anything else", async () => {
    const begun = await beginAttempt({
      invoiceId: INVOICE,
      storeId: STORE,
      amountPaise: 17_700_00,
      mode: "automatic",
    });
    expect(begun?.attemptId).toBe(ATTEMPT);
    const values = dbHolder.current.calls.values[0];
    expect(values).toMatchObject({
      invoiceId: INVOICE,
      state: "created",
      amountPaise: 17_700_00,
      mode: "automatic",
    });
    expect(values.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(begun?.idempotencyKey).toBe(values.idempotencyKey);
  });

  it("★ reads a conflict as 'already collecting', not as an error", async () => {
    seed({ returning: [] });
    expect(
      await beginAttempt({
        invoiceId: INVOICE,
        storeId: STORE,
        amountPaise: 100,
        mode: "manual",
      }),
    ).toBeNull();
  });

  it("mints a DIFFERENT key per attempt", async () => {
    const a = await beginAttempt({
      invoiceId: INVOICE,
      storeId: STORE,
      amountPaise: 100,
      mode: "manual",
    });
    seed();
    const b = await beginAttempt({
      invoiceId: INVOICE,
      storeId: STORE,
      amountPaise: 100,
      mode: "manual",
    });
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
  });
});

describe("settleAttempt", () => {
  it("advances an in-flight attempt and claims on the PRIOR state", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }],
        [{ state: "captured" }], // syncInvoiceStatus reads attempts
      ],
      returning: [{ state: "captured" }],
    });
    expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
    expect(dbHolder.current.calls.set[0]).toMatchObject({ state: "captured" });
  });

  describe("★★ the receipt", () => {
    // ONE place an invoice becomes paid, so enrolment, manual payment, a plan
    // change, a location purchase and reconciliation each send exactly one — and
    // none of them has to remember to.

    it("sends when the invoice BECOMES paid", async () => {
      seed({
        selects: [
          [
            {
              id: ATTEMPT,
              state: "processing",
              invoiceId: INVOICE,
              storeId: "store-1",
            },
          ],
          [{ state: "captured" }],
        ],
        returning: [{ state: "captured" }, { id: INVOICE }],
      });
      await settleAttempt(ATTEMPT, "captured");
      expect(receipts.notifyInvoicePaid).toHaveBeenCalledWith(
        "store-1",
        INVOICE,
      );
    });

    it("★★ sends NOTHING when the paid claim found no row — it was already paid", async () => {
      // The invoice UPDATE excludes `paid` when moving TO paid, so a second
      // settle matches nothing. Without that claim every later attempt on the
      // same invoice would re-send the receipt.
      //
      // ⚠ The two UPDATEs have to be told apart: the ATTEMPT claim must succeed
      // (or settleAttempt returns early and this passes for the wrong reason —
      // which it did, until the mutation caught it) while the INVOICE claim must
      // find nothing. The shared `returning` option cannot express that, so the
      // update step is sequenced by hand.
      seed({
        selects: [
          [
            {
              id: ATTEMPT,
              state: "processing",
              invoiceId: INVOICE,
              storeId: "store-1",
            },
          ],
          [{ state: "captured" }],
        ],
      });
      const perCall = [[{ state: "captured" }], []];
      let n = 0;
      dbHolder.current.db.update = vi.fn(() => ({
        set: vi.fn(() => {
          const rows = perCall[n++] ?? [];
          const step: any = {
            where: vi.fn(() => step),
            returning: vi.fn(async () => rows),
            then: (r: any) => r({ rowCount: rows.length }),
          };
          return step;
        }),
      }));

      await settleAttempt(ATTEMPT, "captured");
      expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
    });

    it("★ sends nothing for a FAILED settle", async () => {
      seed({
        selects: [
          [
            {
              id: ATTEMPT,
              state: "processing",
              invoiceId: INVOICE,
              storeId: "store-1",
            },
          ],
          [{ state: "failed" }],
        ],
        returning: [{ state: "failed" }],
      });
      await settleAttempt(ATTEMPT, "failed");
      expect(receipts.notifyInvoicePaid).not.toHaveBeenCalled();
    });
  });

  it("★ sets resolved_at on a terminal state (the CHECK requires it)", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }],
        [{ state: "failed" }],
      ],
      returning: [{ state: "failed" }],
    });
    await settleAttempt(ATTEMPT, "failed", {
      now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(dbHolder.current.calls.set[0].resolvedAt).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("★ leaves resolved_at NULL for an in-flight state", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "unknown" }],
      ],
      returning: [{ state: "unknown" }],
    });
    await settleAttempt(ATTEMPT, "unknown");
    expect(dbHolder.current.calls.set[0].resolvedAt).toBeNull();
  });

  it("★★ a late `failed` after `captured` writes NOTHING", async () => {
    seed({
      selects: [[{ id: ATTEMPT, state: "captured", invoiceId: INVOICE }]],
    });
    expect(await settleAttempt(ATTEMPT, "failed")).toBe("captured");
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("treats a duplicate webhook as a no-op", async () => {
    seed({
      selects: [[{ id: ATTEMPT, state: "captured", invoiceId: INVOICE }]],
    });
    expect(await settleAttempt(ATTEMPT, "captured")).toBe("captured");
    expect(dbHolder.current.calls.set).toHaveLength(0);
  });

  it("returns null when a concurrent settle won the claim", async () => {
    seed({
      selects: [[{ id: ATTEMPT, state: "processing", invoiceId: INVOICE }]],
      returning: [], // zero rows: someone else moved it first
    });
    expect(await settleAttempt(ATTEMPT, "captured")).toBeNull();
  });

  it("returns null for an unknown attempt", async () => {
    seed({ selects: [[]] });
    expect(await settleAttempt(ATTEMPT, "captured")).toBeNull();
  });
});

describe("collectInvoice — eligibility is checked BEFORE anything is written", () => {
  const base = {
    invoiceId: INVOICE,
    storeId: STORE,
    description: "Basic yearly",
    mandate: MANDATE,
  };

  it("★ refuses over the AFA limit and NEVER calls the gateway", async () => {
    const charge = chargeOk();
    const res = await collectInvoice({
      ...base,
      amountDuePaise: AFA_EXEMPT_LIMIT_PAISE + 1,
      charge,
    });
    expect(res).toEqual({
      status: "not_collectable",
      reason: "over_afa_limit",
    });
    expect(charge).not.toHaveBeenCalled();
    // Nothing written either — a refusal is not a failed attempt, and a failed
    // attempt would start a grace clock.
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("refuses with no mandate, without charging", async () => {
    const charge = chargeOk();
    const res = await collectInvoice({
      ...base,
      mandate: null,
      amountDuePaise: 1_770_00,
      charge,
    });
    expect(res).toEqual({ status: "not_collectable", reason: "no_mandate" });
    expect(charge).not.toHaveBeenCalled();
  });

  it("refuses on a revoked mandate", async () => {
    const charge = chargeOk();
    const res = await collectInvoice({
      ...base,
      mandate: { ...MANDATE, status: "revoked" },
      amountDuePaise: 1_770_00,
      charge,
    });
    expect(res).toMatchObject({ status: "not_collectable" });
    expect(charge).not.toHaveBeenCalled();
  });

  it("refuses when nothing is due, without charging", async () => {
    const charge = chargeOk();
    const res = await collectInvoice({ ...base, amountDuePaise: 0, charge });
    expect(res).toEqual({ status: "not_collectable", reason: "nothing_due" });
    expect(charge).not.toHaveBeenCalled();
  });

  it("★ refuses when an attempt is already in flight", async () => {
    seed({ returning: [] });
    const charge = chargeOk();
    const res = await collectInvoice({
      ...base,
      amountDuePaise: 1_770_00,
      charge,
    });
    expect(res).toEqual({ status: "already_in_flight" });
    expect(charge).not.toHaveBeenCalled();
  });
});

describe("collectInvoice — ordering and outcomes", () => {
  const base = {
    invoiceId: INVOICE,
    storeId: STORE,
    description: "Basic yearly",
    mandate: MANDATE,
    amountDuePaise: 1_770_00,
  };

  it("★★ writes the attempt row BEFORE calling the gateway", async () => {
    let rowsAtChargeTime = -1;
    const charge = vi.fn(async () => {
      rowsAtChargeTime = dbHolder.current.calls.values.length;
      return {
        ok: true as const,
        data: { providerPaymentId: "p", status: "captured" },
      };
    }) as unknown as ChargeFn;

    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "captured" }],
      ],
      returning: [{ id: ATTEMPT }],
    });
    await collectInvoice({ ...base, charge });
    expect(rowsAtChargeTime).toBe(1);
  });

  it("★ passes OUR idempotency key to the gateway", async () => {
    const charge = chargeOk();
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "captured" }],
      ],
      returning: [{ id: ATTEMPT }],
    });
    await collectInvoice({ ...base, charge });
    const arg = (charge as any).mock.calls[0][0];
    expect(arg.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(arg.idempotencyKey).toBe(
      dbHolder.current.calls.values[0].idempotencyKey,
    );
    expect(arg.providerTokenId).toBe("tok_live_1");
  });

  it("reports paid on a capture", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "captured" }],
      ],
      returning: [{ id: ATTEMPT }],
    });
    const res = await collectInvoice({ ...base, charge: chargeOk("captured") });
    expect(res).toEqual({ status: "paid", attemptId: ATTEMPT });
  });

  it("★ a 4xx rejection IS a failure — the money definitively did not move", async () => {
    const charge = vi.fn(async () => ({
      ok: false as const,
      error: "card declined",
      outcome: "rejected" as const,
    })) as unknown as ChargeFn;
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "failed" }],
      ],
      returning: [{ id: ATTEMPT }],
    });
    const res = await collectInvoice({ ...base, charge });
    expect(res).toMatchObject({ status: "failed", code: "gateway_rejected" });
  });

  it("★★ an UNKNOWN outcome is NOT a failure — reconcile, never retry", async () => {
    const charge = vi.fn(async () => ({
      ok: false as const,
      error: "timeout",
      outcome: "unknown" as const,
    })) as unknown as ChargeFn;
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "unknown" }],
      ],
      returning: [{ id: ATTEMPT }],
    });
    const res = await collectInvoice({ ...base, charge });
    expect(res).toEqual({ status: "pending_reconcile", attemptId: ATTEMPT });
    // Crucially NOT "failed": a failure starts the grace clock (Rule 6).
    expect(res.status).not.toBe("failed");
  });

  it("★★ a THROWN gateway call is also UNKNOWN, not a failure", async () => {
    const charge = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as ChargeFn;
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "unknown" }],
      ],
      returning: [{ id: ATTEMPT }],
    });
    const res = await collectInvoice({ ...base, charge });
    expect(res).toEqual({ status: "pending_reconcile", attemptId: ATTEMPT });
  });

  it("★ an authorized-but-not-captured charge waits, it does not claim payment", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "authorized" }],
      ],
      returning: [{ id: ATTEMPT }],
    });
    const res = await collectInvoice({
      ...base,
      charge: chargeOk("authorized"),
    });
    expect(res).toEqual({ status: "pending_reconcile", attemptId: ATTEMPT });
  });

  it("★ an unrecognised gateway status waits rather than failing", async () => {
    seed({
      selects: [
        [{ id: ATTEMPT, state: "created", invoiceId: INVOICE }],
        [{ state: "unknown" }],
      ],
      returning: [{ id: ATTEMPT }],
    });
    const res = await collectInvoice({ ...base, charge: chargeOk("whatever") });
    expect(res).toMatchObject({ status: "pending_reconcile" });
  });
});
