import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// COVERAGE GUARD — every email leaves through the choke point.
//
// The whole value of the email log is that it is COMPLETE. A log with a hole in
// it is worse than no log, because it invites the wrong conclusion: a merchant
// searches for the order confirmation, doesn't find it, and concludes it was
// never sent.
//
// Before lib/email/send.ts there were eight independent `resend.emails.send`
// calls and none of them recorded anything. Nothing stops a ninth being added
// tomorrow except this test.
// ---------------------------------------------------------------------------

/**
 * Files allowed to talk to the Resend transport directly.
 *
 * send.ts IS the choke point. send-batch.ts is the batch transport it delegates
 * to — the two workers can't use the single-message path without giving up
 * batching entirely, so they call sendEmailBatch and then log explicitly.
 * Adding anything here means accepting that its mail is invisible to merchants;
 * route it through sendEmail() instead.
 */
const TRANSPORT_FILES = ["lib/email/send.ts", "lib/email/send-batch.ts"];

function filesCalling(pattern: string): string[] {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-rlE", "--include=*.ts", "--include=*.tsx", pattern, "app", "lib"],
      { encoding: "utf8" },
    );
  } catch {
    return []; // grep exits 1 when nothing matches
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes(".test."))
    .filter((f) => !TRANSPORT_FILES.includes(f));
}

describe("email send coverage", () => {
  it("nothing sends email outside the choke point", () => {
    // `.emails.send(` and `.batch.send(` are the only ways out through the SDK.
    const rogue = filesCalling("\\.(emails|batch)\\.send\\(");

    expect(
      rogue,
      rogue.length
        ? `\n\nThese files call Resend directly, so their mail never reaches ` +
            `the store's Email Logs:\n` +
            rogue.map((f) => `  • ${f}`).join("\n") +
            `\n\nUse sendEmail() from lib/email/send.ts instead. If it genuinely ` +
            `must batch, call sendEmailBatch AND logEmail for each message, and ` +
            `add the file to TRANSPORT_FILES here with the reason.\n`
        : "",
    ).toEqual([]);
  });

  it("both batch workers log what they send", () => {
    // They're the two exceptions above, so their logging can't be taken on
    // faith — assert the call is actually there.
    for (const worker of [
      "lib/email/notification-worker.ts",
      "lib/email/campaign-worker.ts",
    ]) {
      const calls = filesCalling("logEmail\\(").includes(worker);
      expect(calls, `${worker} must call logEmail for every send`).toBe(true);
    }
  });

  it("no sender constructs its own Resend client", () => {
    // A `new Resend(...)` outside the transport is the shape the old scattered
    // senders had, and the first step back towards an incomplete log. Three
    // files legitimately hold a client without being senders:
    const NON_SENDERS = [
      // Hand the client to sendEmailBatch; they log via logEmail (asserted above).
      "lib/email/notification-worker.ts",
      "lib/email/campaign-worker.ts",
      // Uses resend.domains.* to verify a store's custom domain. No mail.
      "app/actions/store-domain.ts",
      // Deletes retired resend.domains resources during tenant teardown. No mail.
      "lib/domains/cleanup.ts",
    ];
    const rogue = filesCalling("new Resend\\(").filter(
      (f) => !NON_SENDERS.includes(f),
    );

    expect(
      rogue,
      rogue.length
        ? `These build their own Resend client instead of using ` +
            `lib/email/send.ts: ${rogue.join(", ")}. If it only needs to know ` +
            `whether email is set up, call emailConfigured().`
        : "",
    ).toEqual([]);
  });
});
