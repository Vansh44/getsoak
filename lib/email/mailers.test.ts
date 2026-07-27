import { describe, it, expect } from "vitest";
import {
  MAILERS,
  MAILER_KEYS,
  getMailer,
  mailerLabel,
  isSensitiveMailer,
} from "./mailers";

describe("mailer catalog", () => {
  it("has an entry for every key, and no strays", () => {
    expect(MAILERS.map((m) => m.key).sort()).toEqual([...MAILER_KEYS].sort());
  });

  it("gives every mailer a label for the log's Type column", () => {
    for (const m of MAILERS) {
      expect(m.label.length, m.key).toBeGreaterThan(0);
      expect(m.description.length, m.key).toBeGreaterThan(0);
    }
  });

  // An email log is readable by store staff. Anything whose subject or body IS
  // a working credential is marked, or the log becomes a way to take over an
  // account — and one that outlives the credential's own expiry.
  it("marks the credential-carrying store mailers sensitive", () => {
    expect(isSensitiveMailer("password_reset")).toBe(true); // the link is the credential
    expect(isSensitiveMailer("staff_invite")).toBe(true); // plaintext temp password
  });

  // Owner's explicit decision (2026-07-27): operator sign-in codes ARE shown,
  // so a code that "never arrived" can be checked against the log directly.
  // Pinned in a test so it can't drift back by accident in either direction.
  it("shows operator sign-in codes, by decision", () => {
    expect(isSensitiveMailer("operator_otp")).toBe(false);
  });

  it("does not redact ordinary mail, which is the point of keeping bodies", () => {
    expect(isSensitiveMailer("notification")).toBe(false);
    expect(isSensitiveMailer("coupon_campaign")).toBe(false);
    expect(isSensitiveMailer("enquiry_notification")).toBe(false);
    expect(isSensitiveMailer("billing")).toBe(false);
  });

  it("treats an unknown mailer as non-sensitive but still labels it", () => {
    // A row written before a rename must still render; it just falls back to
    // its stored key rather than blanking the column.
    expect(getMailer("nope")).toBeUndefined();
    expect(mailerLabel("nope")).toBe("nope");
    expect(isSensitiveMailer("nope")).toBe(false);
  });
});
