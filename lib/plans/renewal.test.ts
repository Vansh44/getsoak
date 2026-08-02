import { describe, it, expect } from "vitest";
import { renewalTerm, renewalLabel, type RenewalInput } from "./renewal";

const base: RenewalInput = {
  expiresAt: "2026-09-12T18:30:00Z",
  expired: false,
  hasMandate: false,
  cancelAtPeriodEnd: false,
  status: null,
};

describe("renewalTerm", () => {
  it("says renews only when a live mandate will charge again", () => {
    expect(renewalTerm({ ...base, hasMandate: true, status: "active" })).toBe(
      "renews",
    );
  });

  it("says expires for a dated grant with no subscription behind it", () => {
    // A comp or trial plan with plan_expires_at set: the date is a deadline.
    expect(renewalTerm(base)).toBe("expires");
  });

  it("says expires once the merchant has cancelled", () => {
    // Still active and still paid-up, but the date now marks the last day of
    // service rather than the next charge.
    expect(
      renewalTerm({
        ...base,
        hasMandate: true,
        status: "active",
        cancelAtPeriodEnd: true,
      }),
    ).toBe("expires");
  });

  it("distinguishes a retrying subscription from an exhausted one", () => {
    // `pending` is mid-retry and can still renew.
    expect(renewalTerm({ ...base, hasMandate: true, status: "pending" })).toBe(
      "renews",
    );
    // `halted` means Razorpay gave up: nothing more will be charged.
    expect(renewalTerm({ ...base, hasMandate: true, status: "halted" })).toBe(
      "expires",
    );
  });

  it("says none when there is no date at all", () => {
    // Free, or an indefinite operator grant.
    expect(renewalTerm({ ...base, expiresAt: null })).toBe("none");
  });

  it("reports a lapsed plan as expired regardless of mandate state", () => {
    expect(
      renewalTerm({
        ...base,
        expired: true,
        hasMandate: true,
        status: "active",
      }),
    ).toBe("expired");
  });

  it("falls back to expires for an unknown state, never to renews", () => {
    // The safe direction: a merchant who is told "Expires" goes and looks. One
    // told "Renews" about a subscription that won't does not.
    expect(renewalTerm({ ...base, hasMandate: false, status: "created" })).toBe(
      "expires",
    );
  });
});

describe("renewalLabel", () => {
  it("labels each term", () => {
    expect(renewalLabel("renews")).toBe("Renews");
    expect(renewalLabel("expires")).toBe("Expires");
    expect(renewalLabel("expired")).toBe("Expired on");
    // Neutral when there's no date to qualify.
    expect(renewalLabel("none")).toBe("Renews / expires");
  });
});
