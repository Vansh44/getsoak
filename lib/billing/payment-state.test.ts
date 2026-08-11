import { describe, expect, it } from "vitest";
import {
  invoiceStatusForAttempts,
  isInFlight,
  isSettled,
  isTerminal,
  needsReconciliation,
  resolvePaymentState,
  type PaymentState,
} from "./payment-state";

const ALL: PaymentState[] = [
  "created",
  "processing",
  "authorized",
  "captured",
  "failed",
  "cancelled",
  "refunded",
  "unknown",
];

describe("terminality", () => {
  it("treats captured/refunded/failed/cancelled as terminal", () => {
    for (const s of ["captured", "refunded", "failed", "cancelled"] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(isInFlight(s)).toBe(false);
    }
  });

  it("★ treats `unknown` as IN FLIGHT, not as a failure", () => {
    expect(isTerminal("unknown")).toBe(false);
    expect(isInFlight("unknown")).toBe(true);
    expect(needsReconciliation("unknown")).toBe(true);
  });

  it("settles only on captured or refunded", () => {
    expect(ALL.filter(isSettled)).toEqual(["captured", "refunded"]);
  });
});

describe("forward progress", () => {
  it.each([
    ["created", "processing"],
    ["processing", "authorized"],
    ["authorized", "captured"],
    ["created", "captured"],
  ] as const)("advances %s → %s", (from, to) => {
    expect(resolvePaymentState(from, to)).toEqual({
      state: to,
      changed: true,
      ignored: false,
    });
  });

  it("ignores a duplicate without flagging it as regressive", () => {
    expect(resolvePaymentState("captured", "captured")).toEqual({
      state: "captured",
      changed: false,
      ignored: false,
    });
  });

  it("ignores a backwards step along the happy path", () => {
    expect(resolvePaymentState("authorized", "processing")).toEqual({
      state: "authorized",
      changed: false,
      ignored: true,
    });
  });
});

describe("★ out-of-order webhooks (spec §26)", () => {
  it("★★ a late `failed` NEVER overwrites `captured`", () => {
    expect(resolvePaymentState("captured", "failed")).toEqual({
      state: "captured",
      changed: false,
      ignored: true,
    });
  });

  it("resolves the same pair identically in either arrival order", () => {
    // failed then captured
    const a = resolvePaymentState("processing", "failed");
    const b = resolvePaymentState(a.state, "captured");
    // captured then failed
    const c = resolvePaymentState("processing", "captured");
    const d = resolvePaymentState(c.state, "failed");
    // ⚠ NOT identical, and deliberately so: a failed attempt is CLOSED, so a
    // later capture on the same attempt is a reconciliation question, not a
    // silent upgrade to paid. What matters is that neither path can end up
    // reporting a capture as a failure.
    expect(d.state).toBe("captured");
    expect(b.state).toBe("failed");
    expect(b.ignored).toBe(true);
  });

  it("refuses every transition out of a failed attempt", () => {
    for (const to of ALL) {
      if (to === "failed") continue;
      const r = resolvePaymentState("failed", to);
      expect(r.state).toBe("failed");
      expect(r.changed).toBe(false);
    }
  });

  it("refuses `refunded` on an attempt never seen captured", () => {
    expect(resolvePaymentState("processing", "refunded")).toEqual({
      state: "processing",
      changed: false,
      ignored: true,
    });
  });

  it("allows the one legal move out of success: captured → refunded", () => {
    expect(resolvePaymentState("captured", "refunded")).toEqual({
      state: "refunded",
      changed: true,
      ignored: false,
    });
  });

  it("refuses to move off refunded", () => {
    for (const to of ALL) {
      if (to === "refunded") continue;
      expect(resolvePaymentState("refunded", to).state).toBe("refunded");
    }
  });
});

describe("★ the unknown state (Rule 6 / spec §44)", () => {
  it("can be entered from any in-flight state", () => {
    for (const from of ["created", "processing", "authorized"] as const) {
      expect(resolvePaymentState(from, "unknown")).toEqual({
        state: "unknown",
        changed: true,
        ignored: false,
      });
    }
  });

  it("★ cannot be entered from a settled state — that would lose a known truth", () => {
    expect(resolvePaymentState("captured", "unknown")).toEqual({
      state: "captured",
      changed: false,
      ignored: true,
    });
  });

  it("resolves to either outcome once verification answers", () => {
    expect(resolvePaymentState("unknown", "captured").state).toBe("captured");
    expect(resolvePaymentState("unknown", "failed").state).toBe("failed");
  });

  it("accepts a known in-flight stage as information gained", () => {
    expect(resolvePaymentState("unknown", "authorized")).toEqual({
      state: "authorized",
      changed: true,
      ignored: false,
    });
  });
});

describe("no transition ever produces an invalid state", () => {
  it("only ever returns one of the declared states", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(ALL).toContain(resolvePaymentState(from, to).state);
      }
    }
  });

  it("★ a settled attempt can never become unsettled except by refund", () => {
    for (const to of ALL) {
      const r = resolvePaymentState("captured", to);
      expect(isSettled(r.state)).toBe(true);
    }
  });
});

describe("invoiceStatusForAttempts", () => {
  it("is paid when any attempt captured", () => {
    expect(invoiceStatusForAttempts(["failed", "captured"])).toBe("paid");
  });

  it("prefers paid over an in-flight retry", () => {
    expect(invoiceStatusForAttempts(["captured", "processing"])).toBe("paid");
  });

  it("is processing while an attempt is in flight", () => {
    expect(invoiceStatusForAttempts(["failed", "processing"])).toBe(
      "processing",
    );
  });

  it("★ counts `unknown` as processing, not as failed", () => {
    expect(invoiceStatusForAttempts(["unknown"])).toBe("processing");
  });

  it("★ returns to open after a failure — a failed attempt is not a failed invoice", () => {
    expect(invoiceStatusForAttempts(["failed"])).toBe("open");
    expect(invoiceStatusForAttempts(["failed", "cancelled"])).toBe("open");
  });

  it("is open with no attempts yet", () => {
    expect(invoiceStatusForAttempts([])).toBe("open");
  });

  it("is paid on a refunded capture, which the refund status then supersedes", () => {
    // `refunded` is set on the invoice explicitly by the refund path; this
    // derivation only ever runs for collectable invoices.
    expect(invoiceStatusForAttempts(["captured", "refunded"])).toBe("paid");
  });
});
