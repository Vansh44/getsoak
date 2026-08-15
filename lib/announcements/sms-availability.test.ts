import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { platformSmsSender, smsAvailability } from "./sms-availability";

const KEYS = [
  "PLATFORM_TWILIO_ACCOUNT_SID",
  "PLATFORM_TWILIO_AUTH_TOKEN",
  "PLATFORM_SMS_SENDER_HEADER",
  "PLATFORM_DLT_ENTITY_ID",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function connect() {
  process.env.PLATFORM_TWILIO_ACCOUNT_SID = "AC123";
  process.env.PLATFORM_TWILIO_AUTH_TOKEN = "token";
  process.env.PLATFORM_SMS_SENDER_HEADER = "SMINKX";
  process.env.PLATFORM_DLT_ENTITY_ID = "1234567890";
}

describe("platformSmsSender", () => {
  it("is null with nothing configured", () => {
    expect(platformSmsSender()).toBeNull();
  });

  // All four or none: a partial connection authenticates and then fails at the
  // carrier, which is the failure mode this whole module exists to prevent.
  it("is null when any single value is missing", () => {
    for (const omit of KEYS) {
      connect();
      delete process.env[omit];
      expect(platformSmsSender(), `missing ${omit}`).toBeNull();
    }
  });

  it("resolves when all four are set", () => {
    connect();
    expect(platformSmsSender()).toMatchObject({
      accountSid: "AC123",
      senderHeader: "SMINKX",
    });
  });
});

describe("smsAvailability", () => {
  it("refuses with a reason, not a bare false, when nothing is connected", () => {
    const result = smsAvailability("TPL1");
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no registered sender/i);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("names the missing env values so the fix is actionable", () => {
    process.env.PLATFORM_TWILIO_ACCOUNT_SID = "AC123";
    const result = smsAvailability("TPL1");
    expect(result.blockers[0]).toContain("PLATFORM_TWILIO_AUTH_TOKEN");
    expect(result.blockers[0]).not.toContain("PLATFORM_TWILIO_ACCOUNT_SID");
  });

  // ★ A CONNECTION IS NECESSARY AND NOT SUFFICIENT. An approved DLT template
  // covers ONE body; without it the carrier drops the message silently, which
  // is indistinguishable from delivery in every log we keep.
  it("still refuses a connected sender with no template", () => {
    connect();
    const result = smsAvailability("");
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no approved DLT template/i);
  });

  it("allows only a connected sender with a template", () => {
    connect();
    expect(smsAvailability("TPL1").available).toBe(true);
    expect(smsAvailability("   ").available).toBe(false);
  });

  it("reports every blocker at once rather than one at a time", () => {
    // Nothing configured AND no template: an operator should see the whole
    // path, not discover the next step after clearing the last one.
    const result = smsAvailability(null);
    expect(result.blockers.length).toBe(3);
  });
});
