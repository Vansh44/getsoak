import { describe, expect, it } from "vitest";
import { explainCertificate } from "./certificates";

// ---------------------------------------------------------------------------
// The three failure modes Google reports, and why telling them apart matters:
// only ONE of them is fixed by adding the DNS records the settings page shows.
// Before this existed, all three produced "Certificate isn't issued yet. Add
// the DNS records shown" — so a merchant blocked by a CAA record was sent round
// the same loop forever, with nothing in the logs to say otherwise either.
// ---------------------------------------------------------------------------

describe("explainCertificate", () => {
  it("says nothing when there is nothing wrong", () => {
    expect(explainCertificate(undefined)).toEqual({});
    expect(explainCertificate({ state: "ACTIVE" })).toEqual({});
    expect(explainCertificate({ state: "PROVISIONING" })).toEqual({});
  });

  it("names the CAA record, and what to add — the records on screen can't fix it", () => {
    const res = explainCertificate({
      state: "PROVISIONING",
      authorizationAttemptInfo: [
        { domain: "acme.com", state: "FAILED", failureReason: "CAA" },
      ],
    });
    expect(res.failureReason).toBe("CAA");
    expect(res.diagnosis).toContain("CAA");
    expect(res.diagnosis).toContain("pki.goog");
  });

  it("tells a rate-limited merchant to wait rather than change anything", () => {
    const res = explainCertificate({
      state: "PROVISIONING",
      provisioningIssue: { reason: "RATE_LIMITED" },
    });
    expect(res.failureReason).toBe("RATE_LIMITED");
    expect(res.diagnosis).toContain("try again");
    // Must NOT ask them to touch DNS: nothing they own is wrong.
    expect(res.diagnosis).not.toContain("CNAME");
  });

  it("stays quiet on CONFIG so the caller's own CNAME check speaks instead", () => {
    // checkCnameTarget names the record AND what it currently points at, which
    // beats anything derivable from the enum — so this reports the reason for
    // the logs and deliberately supplies no merchant-facing text.
    const res = explainCertificate({
      authorizationAttemptInfo: [
        { domain: "acme.com", state: "FAILED", failureReason: "CONFIG" },
      ],
    });
    expect(res.failureReason).toBe("CONFIG");
    expect(res.diagnosis).toBeUndefined();
  });

  it("prefers the per-domain cause over the generic top-level one", () => {
    // provisioningIssue only ever says AUTHORIZATION_ISSUE; the specific reason
    // lives in authorizationAttemptInfo. Reading the wrong one loses the CAA
    // case entirely, which is the one case that needs a different action.
    const res = explainCertificate({
      provisioningIssue: { reason: "AUTHORIZATION_ISSUE" },
      authorizationAttemptInfo: [
        { domain: "acme.com", state: "FAILED", failureReason: "CAA" },
      ],
    });
    expect(res.failureReason).toBe("CAA");
  });

  it("passes through an unrecognised reason with Google's own details", () => {
    // Forward-compatible: a reason added to the API later must still surface
    // something rather than silently reverting to the generic message.
    const res = explainCertificate({
      provisioningIssue: { reason: "SOMETHING_NEW", details: "the specifics" },
    });
    expect(res.failureReason).toBe("SOMETHING_NEW");
    expect(res.diagnosis).toBe("the specifics");
  });

  it("ignores an attempt that is still in progress", () => {
    // AUTHORIZING with no failureReason is the normal waiting state, not a fault.
    expect(
      explainCertificate({
        state: "PROVISIONING",
        authorizationAttemptInfo: [
          { domain: "acme.com", state: "AUTHORIZING" },
        ],
      }),
    ).toEqual({});
  });
});
