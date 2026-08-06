import { describe, expect, it } from "vitest";
import {
  decideReissue,
  pendingDuration,
  REISSUE_COOLDOWN_MS,
  STALE_ATTEMPT_MS,
  STUCK_AFTER_MS,
  type ReissueInput,
} from "./reissue";

// ---------------------------------------------------------------------------
// The rules about when NOT to reissue matter more than the rule about when to:
// the action deletes a real certificate and spends a rate limit that is shared
// across every domain under the same registrable name.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-08-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const base: ReissueInput = {
  ready: false,
  failureReason: "CONFIG",
  attemptTime: ago(60 * 60 * 1000), // an hour ago
  cnameCorrect: true,
  nowMs: NOW,
};

describe("decideReissue", () => {
  it("reissues a stale CONFIG failure once DNS is correct — the wholesip.com case", () => {
    // Exactly what happened in prod: a CNAME_MISMATCH verdict from 59 minutes
    // before the correct records were published, apex down, Google in backoff.
    const d = decideReissue(base);
    expect(d.reissue).toBe(true);
    expect(d.reason).toContain("DNS now correct");
  });

  it("NEVER reissues when rate limited", () => {
    // The single most important guard: the failure IS that we asked too often,
    // so asking again is the one action guaranteed to prolong it.
    const d = decideReissue({ ...base, failureReason: "RATE_LIMITED" });
    expect(d.reissue).toBe(false);
    expect(d.reason).toContain("rate limited");
  });

  it("does not reissue on a CAA block — a new certificate hits the same wall", () => {
    const d = decideReissue({ ...base, failureReason: "CAA" });
    expect(d.reissue).toBe(false);
    expect(d.reason).toContain("CAA");
  });

  it("does not reissue while the challenge CNAME is still wrong", () => {
    // The failure is CURRENT, not stale. Recreating would spend the rate-limit
    // budget to relearn the same answer.
    const d = decideReissue({ ...base, cnameCorrect: false });
    expect(d.reissue).toBe(false);
    expect(d.reason).toContain("still wrong");
  });

  it("does not reissue when Google has not failed — it may be authorizing now", () => {
    const d = decideReissue({ ...base, failureReason: undefined });
    expect(d.reissue).toBe(false);
    expect(d.reason).toContain("no failed attempt");
  });

  it("does not reissue a fresh failure", () => {
    const d = decideReissue({
      ...base,
      attemptTime: ago(STALE_ATTEMPT_MS - 60_000),
    });
    expect(d.reissue).toBe(false);
    expect(d.reason).toContain("m ago");
  });

  it("reissues right at the staleness boundary", () => {
    expect(
      decideReissue({ ...base, attemptTime: ago(STALE_ATTEMPT_MS) }).reissue,
    ).toBe(true);
  });

  it("respects the cooldown, then allows another attempt after it", () => {
    // Anti-thrash: an hourly cron that recreated a certificate every run would
    // spend the per-domain rate limit and manufacture RATE_LIMITED.
    expect(
      decideReissue({ ...base, lastReissueAt: ago(REISSUE_COOLDOWN_MS - 1000) })
        .reissue,
    ).toBe(false);
    expect(
      decideReissue({ ...base, lastReissueAt: ago(REISSUE_COOLDOWN_MS + 1000) })
        .reissue,
    ).toBe(true);
  });

  it("never touches a host that is already serving", () => {
    expect(decideReissue({ ...base, ready: true }).reissue).toBe(false);
  });

  it("refuses to act on an unreadable or absent timestamp rather than guessing", () => {
    // Acting blind means possibly deleting a certificate Google is authorizing
    // this second.
    expect(decideReissue({ ...base, attemptTime: undefined }).reissue).toBe(
      false,
    );
    expect(decideReissue({ ...base, attemptTime: "not a date" }).reissue).toBe(
      false,
    );
  });

  it("always explains itself, including on a no", () => {
    // The reason goes straight into the log line; a silent decision here is
    // undebuggable.
    for (const override of [
      { ready: true },
      { failureReason: "RATE_LIMITED" },
      { cnameCorrect: false },
      {},
    ]) {
      expect(decideReissue({ ...base, ...override }).reason).toBeTruthy();
    }
  });
});

describe("pendingDuration", () => {
  it("reports days waited", () => {
    expect(pendingDuration(ago(2 * 24 * 3600 * 1000), NOW).days).toBe(2);
  });

  it("flags a domain stuck past the threshold", () => {
    // The sweep answers 200 while domains wait, so without this a domain stuck
    // for a week is indistinguishable from one stuck for a minute.
    expect(pendingDuration(ago(STUCK_AFTER_MS - 1000), NOW).stuck).toBe(false);
    expect(pendingDuration(ago(STUCK_AFTER_MS + 1000), NOW).stuck).toBe(true);
  });

  it("treats missing or unparseable timestamps as not stuck", () => {
    // A domain connected before this field existed must not alarm on its first
    // sweep just because we have no start time for it.
    expect(pendingDuration(undefined, NOW)).toEqual({ days: 0, stuck: false });
    expect(pendingDuration("nonsense", NOW)).toEqual({ days: 0, stuck: false });
  });
});
