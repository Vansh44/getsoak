// The pin is the whole point of this module, so the test asserts the OUTPUT
// rather than the arguments.
//
// ⚠ These expectations only prove anything because the process timezone is not
// Asia/Kolkata. Vitest inherits the machine's zone, so `withTz` forces UTC for
// the duration of a test — the same guard lib/notifications/format.ts relies
// on. If these ever start passing for the wrong reason, that is why.

import { describe, it, expect, afterEach } from "vitest";
import { formatDay, formatWhen } from "./dates";

const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

function withTz<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  return fn();
}

// 2026-08-06T16:56:00Z is 2026-08-06 22:26 in Asia/Kolkata (+5:30) — the exact
// timestamp from the hydration error this module was written for.
const ISO = "2026-08-06T16:56:00.000Z";

describe("the harness itself", () => {
  it("CONTROL: an unpinned formatter really does move with the zone", () => {
    // Without this, every assertion below could pass for the wrong reason —
    // if changing process.env.TZ did nothing, "same string in three zones"
    // would be trivially true even for a formatter with no pin at all. This
    // is the unpinned call the logs pages used to make, and it must differ.
    const unpinned = (iso: string) =>
      new Date(iso).toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });

    expect(withTz("UTC", () => unpinned(ISO))).not.toBe(
      withTz("Asia/Kolkata", () => unpinned(ISO)),
    );
  });
});

describe("formatWhen", () => {
  it("renders in Asia/Kolkata whatever the machine's zone is", () => {
    const utc = withTz("UTC", () => formatWhen(ISO));
    const nyc = withTz("America/New_York", () => formatWhen(ISO));
    const kol = withTz("Asia/Kolkata", () => formatWhen(ISO));

    // Same string everywhere: this is what makes SSR and the browser agree.
    expect(utc).toBe(nyc);
    expect(utc).toBe(kol);
    // …and it is the LOCAL time, not the UTC one. 16:56 UTC would be 04:56 pm.
    expect(utc).toContain("10:26");
    expect(utc).toContain("Aug");
    expect(utc).toContain("2026");
  });

  it("crosses the date boundary correctly", () => {
    // 19:00 UTC on the 6th is 00:30 on the 7th in Kolkata. A formatter reading
    // the machine's zone would render the 6th on a UTC server.
    const s = withTz("UTC", () => formatWhen("2026-08-06T19:00:00.000Z"));
    expect(s).toContain("07");
    expect(s).toContain("12:30");
  });

  it("returns empty for missing or unparseable input", () => {
    // "" reads as "no timestamp"; "Invalid Date" reads as a broken row.
    expect(formatWhen(null)).toBe("");
    expect(formatWhen(undefined)).toBe("");
    expect(formatWhen("")).toBe("");
    expect(formatWhen("not a date")).toBe("");
  });
});

describe("formatDay", () => {
  it("is zone-stable too", () => {
    const utc = withTz("UTC", () => formatDay(ISO));
    const nyc = withTz("America/New_York", () => formatDay(ISO));
    expect(utc).toBe(nyc);
    expect(utc).toContain("August");
    expect(utc).toContain("2026");
  });

  it("puts a late-evening UTC timestamp on the following Indian day", () => {
    expect(
      withTz("UTC", () => formatDay("2026-08-06T19:00:00.000Z")),
    ).toContain("7 August");
  });

  it("returns empty for missing input", () => {
    expect(formatDay(null)).toBe("");
    expect(formatDay("nope")).toBe("");
  });
});
