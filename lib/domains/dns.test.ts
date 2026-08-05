import { describe, expect, it } from "vitest";
import { assessCnameTargets, assessDomainAddresses } from "./dns";

describe("assessDomainAddresses", () => {
  const expected = "136.69.75.127";

  it("accepts a domain that points only at the load balancer", () => {
    expect(assessDomainAddresses([expected], expected)).toEqual({
      pointsToUs: true,
      found: [expected],
    });
  });

  it("rejects a domain with old A records alongside the load balancer", () => {
    const result = assessDomainAddresses(
      [expected, "15.197.148.33", "3.33.130.190"],
      expected,
    );
    expect(result.pointsToUs).toBe(false);
    expect(result.error).toContain("Remove the other A records");
  });

  it("explains a missing or entirely wrong A record", () => {
    expect(assessDomainAddresses([], expected).error).toContain(
      "couldn't find",
    );
    expect(assessDomainAddresses(["203.0.113.1"], expected).error).toContain(
      `Update its A record to ${expected}`,
    );
  });
});

describe("assessCnameTargets", () => {
  const expected = "token.authorize.certificatemanager.goog";

  it("normalizes case and trailing dots", () => {
    expect(
      assessCnameTargets(["TOKEN.authorize.certificatemanager.goog."], expected)
        .matches,
    ).toBe(true);
  });

  it("distinguishes missing and incorrect challenge records", () => {
    expect(assessCnameTargets([], expected).error).toContain("couldn't find");
    expect(assessCnameTargets(["wrong.example.com"], expected)).toMatchObject({
      matches: false,
      found: ["wrong.example.com"],
    });
  });
});
