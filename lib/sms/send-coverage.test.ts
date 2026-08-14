import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// COVERAGE GUARD — every SMS leaves through the choke point.
//
// The same guard `lib/email/send-coverage.test.ts` exists for, added at the
// same time as the channel rather than after the log had already grown holes.
// The email one was written retroactively, once eight independent
// `resend.emails.send` calls had accumulated and none of them recorded
// anything; there is no reason to repeat that discovery on the second channel.
//
// An SMS log with a hole in it is worse than no log: a merchant searches for
// the message a customer says never arrived, doesn't find it, and concludes it
// was never sent — when in fact it was sent by a path nobody wired to the log.
// ---------------------------------------------------------------------------

/**
 * The ONLY file allowed to call the Twilio transport.
 *
 * Unlike email there is no batch exception, because there is no batch endpoint
 * worth having here: an SMS is billed per segment per recipient, so batching
 * saves nothing and would cost the per-message outcome that decides whether a
 * retry is safe.
 */
const TRANSPORT_FILES = [
  // The choke point — the one caller.
  "lib/sms/send.ts",
  // The client itself, which DEFINES twilioSendSms and so matches the grep.
  "lib/sms/twilio.ts",
];

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

describe("sms send coverage", () => {
  it("nothing sends an SMS outside the choke point", () => {
    const rogue = filesCalling("twilioSendSms\\(");

    expect(
      rogue,
      rogue.length
        ? `\n\nThese files call Twilio directly, so their messages never reach ` +
            `the store's SMS Logs:\n` +
            rogue.map((f) => `  • ${f}`).join("\n") +
            `\n\nUse sendSms() from lib/sms/send.ts instead.\n`
        : "",
    ).toEqual([]);
  });

  // The transport is reached by URL as well as by function name, so a new
  // sender could bypass the client entirely and still send.
  it("nothing POSTs to the Twilio API outside the client", () => {
    const rogue = filesCalling("api\\.twilio\\.com").filter(
      (f) => f !== "lib/sms/twilio.ts",
    );

    expect(
      rogue,
      rogue.length
        ? `\n\nThese files reach Twilio's API directly, bypassing both the ` +
            `client and the log:\n` +
            rogue.map((f) => `  • ${f}`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("the choke point writes a log row on every path", () => {
    // sent, failed AND skipped — a message that never left still has to be
    // findable, or "why did my customer hear nothing?" has no answer.
    const source = execFileSync("cat", ["lib/sms/send.ts"], {
      encoding: "utf8",
    });
    for (const status of [
      'status: "sent"',
      'status: "failed"',
      'status: "skipped"',
    ]) {
      expect(
        source.includes(status),
        `lib/sms/send.ts must write a ${status} log row`,
      ).toBe(true);
    }
  });
});
