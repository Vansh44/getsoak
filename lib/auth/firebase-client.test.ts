import { describe, expect, it } from "vitest";
import {
  firebaseAuthErrorMessage,
  phoneLinkErrorMessage,
} from "./firebase-client";

// ---------------------------------------------------------------------------
// What a user READS when auth fails.
//
// This mapper had no coverage, and its own comment records why it matters: the
// phone codes "used to fall through to the generic message, so a shopper who
// typed a number one digit short and a project that had run out of SMS quota
// saw exactly the same 'Something went wrong'". The same gap reopened for
// credential linking.
// ---------------------------------------------------------------------------

const err = (code: string) => ({ code });

describe("firebaseAuthErrorMessage", () => {
  it("names the cause for every code it claims to handle", () => {
    const cases: [string, RegExp][] = [
      ["auth/invalid-credential", /incorrect email or password/i],
      ["auth/email-already-in-use", /already exists/i],
      ["auth/invalid-phone-number", /valid mobile number/i],
      ["auth/quota-exceeded", /can't send codes/i],
      ["auth/code-expired", /expired/i],
      ["auth/invalid-verification-code", /isn't right/i],
    ];
    for (const [code, pattern] of cases) {
      expect(firebaseAuthErrorMessage(err(code)), code).toMatch(pattern);
    }
  });

  // ★ THE REGRESSION. `updatePhoneNumber` raises this when the number is
  // already on another account — the single most likely way phone linking
  // fails — and there was no case for it, so it read "Something went wrong".
  it("handles a linking conflict instead of falling through", () => {
    const message = firebaseAuthErrorMessage(
      err("auth/credential-already-in-use"),
    );
    expect(message).not.toMatch(/something went wrong/i);
    expect(message).toMatch(/already linked/i);
  });

  it("returns empty for a cancelled popup — nothing to surface", () => {
    expect(firebaseAuthErrorMessage(err("auth/popup-closed-by-user"))).toBe("");
    expect(firebaseAuthErrorMessage(err("auth/cancelled-popup-request"))).toBe(
      "",
    );
  });

  it("falls back rather than throwing on anything unrecognised", () => {
    for (const input of [undefined, null, {}, "boom", new Error("x")]) {
      expect(firebaseAuthErrorMessage(input)).toMatch(/something went wrong/i);
    }
  });
});

describe("phoneLinkErrorMessage", () => {
  // ★★ THE BUG THIS EXISTS FOR. The shared message is Google-popup language;
  // under a box asking for a mobile number it reads as though the EMAIL were
  // the problem, and gives no way forward.
  it("blames the NUMBER, not the sign-in method, for both conflict codes", () => {
    for (const code of [
      "auth/credential-already-in-use",
      "auth/account-exists-with-different-credential",
    ]) {
      const message = phoneLinkErrorMessage(err(code));
      expect(message, code).toMatch(/mobile number is already linked/i);
      // The wording that sent people looking at the wrong field.
      expect(message, code).not.toMatch(/different sign-in method/i);
      // And it says what to do next.
      expect(message, code).toMatch(/different number|log in/i);
    }
  });

  // The shared mapper already words these well; a second copy would drift.
  it("defers to the shared mapper for every other code", () => {
    for (const code of [
      "auth/invalid-phone-number",
      "auth/code-expired",
      "auth/quota-exceeded",
      "auth/too-many-requests",
      "auth/captcha-check-failed",
    ]) {
      expect(phoneLinkErrorMessage(err(code)), code).toBe(
        firebaseAuthErrorMessage(err(code)),
      );
    }
  });

  it("still falls back on an unrecognised error", () => {
    expect(phoneLinkErrorMessage(new Error("x"))).toMatch(
      /something went wrong/i,
    );
  });
});
