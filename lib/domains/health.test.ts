import { describe, expect, it } from "vitest";
import {
  shouldHealthCheck,
  recordHealthResult,
  HEALTHY_RECHECK_MS,
  FAILING_RECHECK_MS,
  REVERT_AFTER_FAILURES,
} from "./health";

const NOW = Date.parse("2026-08-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("shouldHealthCheck", () => {
  it("checks a domain that has never been checked", () => {
    // A domain verified before health checking existed needs a baseline now, not
    // in six hours.
    expect(shouldHealthCheck({}, NOW)).toBe(true);
  });

  it("leaves a recently-checked healthy domain alone", () => {
    // The checks cost Certificate Manager calls plus DNS lookups per domain, for
    // something that changes maybe once a year.
    expect(
      shouldHealthCheck({ checkedAt: ago(HEALTHY_RECHECK_MS - 60_000) }, NOW),
    ).toBe(false);
    expect(shouldHealthCheck({ checkedAt: ago(HEALTHY_RECHECK_MS) }, NOW)).toBe(
      true,
    );
  });

  it("re-checks a FAILING domain sooner than a healthy one", () => {
    // Asymmetric on purpose: confirming a suspected failure is time-critical
    // because the merchant may be locked out; re-confirming health is not.
    const failing = { checkedAt: ago(FAILING_RECHECK_MS + 1000), failures: 1 };
    const healthy = { checkedAt: ago(FAILING_RECHECK_MS + 1000), failures: 0 };
    expect(shouldHealthCheck(failing, NOW)).toBe(true);
    expect(shouldHealthCheck(healthy, NOW)).toBe(false);
  });

  it("checks rather than skips on an unreadable timestamp", () => {
    // Fails toward doing the work: a skipped check on a broken domain is a
    // lock-out, an extra check is a few API calls.
    expect(shouldHealthCheck({ checkedAt: "nonsense" }, NOW)).toBe(true);
  });
});

describe("recordHealthResult", () => {
  it("does not revert on a single failure", () => {
    // ★ The hysteresis. Reverting on one verdict would flap the store's
    // canonical URL on any transient DNS hiccup, and that URL is what Google
    // indexes — oscillating is worse for the merchant than being briefly down.
    const r = recordHealthResult({}, false);
    expect(r).toEqual({ failures: 1, revert: false });
  });

  it("reverts only after the threshold of CONSECUTIVE failures", () => {
    let state = {};
    for (let i = 1; i < REVERT_AFTER_FAILURES; i++) {
      const r = recordHealthResult(state, false);
      expect(r.revert, `failure ${i}`).toBe(false);
      state = { failures: r.failures };
    }
    expect(recordHealthResult(state, false).revert).toBe(true);
  });

  it("★ any single success clears the count entirely", () => {
    // A domain that works is not "two failures away from working". Carrying
    // history forward would revert a healthy domain on an unlucky sequence of
    // unrelated blips spread over days.
    expect(
      recordHealthResult({ failures: REVERT_AFTER_FAILURES - 1 }, true),
    ).toEqual({ failures: 0, revert: false });
  });

  it("keeps reverting once past the threshold rather than resetting", () => {
    // Idempotent: the caller may see this state again before the revert is
    // persisted, and it must not silently start counting from zero.
    expect(
      recordHealthResult({ failures: REVERT_AFTER_FAILURES }, false).revert,
    ).toBe(true);
  });
});
