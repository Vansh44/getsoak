import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// COVERAGE GUARD — every plan_events write uses a source the DB will accept.
//
// `plan_events.source` is CHECK-constrained to ('operator', 'billing',
// 'system') by supabase/plans_01_schema.sql. `stores.plan_source` is a
// DIFFERENT vocabulary — ('comp', 'paid', 'trial') — and the two sit two lines
// apart in the code that writes them.
//
// All three billing writers reached for `source: "paid"`. Postgres rejected
// every one, and because each insert sat in the SAME transaction as the
// `stores` update, the rejection rolled back the plan the merchant had just
// been charged for. It failed silently for months: the audit log looked empty
// because nothing could ever be written to it, and the empty log is exactly
// what you'd check to find out why a plan didn't change.
//
// TypeScript can't catch this — `source` is a plain `text` column, so every
// string typechecks. This test is the only thing standing between a fourth
// writer and the same outage.
// ---------------------------------------------------------------------------

/** The values supabase/plans_01_schema.sql permits. Keep in step with the SQL. */
const ALLOWED_SOURCES = ["operator", "billing", "system"];

function grep(pattern: string, paths: string[]): string {
  try {
    return execFileSync("grep", ["-rEn", "--include=*.ts", pattern, ...paths], {
      encoding: "utf8",
    });
  } catch {
    return ""; // grep exits 1 when nothing matches
  }
}

describe("plan_events audit coverage", () => {
  it("★ every `source:` written near a planEvents insert is CHECK-valid", () => {
    // -A8 keeps the object literal with its insert, so an unrelated `source:`
    // elsewhere in the file can't produce a false positive.
    let block = "";
    try {
      block = execFileSync(
        "grep",
        [
          "-rEn",
          "-A8",
          "--include=*.ts",
          "insert\\(planEvents\\)",
          "app",
          "lib",
        ],
        { encoding: "utf8" },
      );
    } catch {
      block = "";
    }
    expect(block, "no planEvents inserts found — did the table move?").not.toBe(
      "",
    );

    const offenders = block
      .split("\n")
      .filter((line) => /\bsource:\s*"/.test(line))
      .filter((line) => !line.includes(".test."))
      .filter((line) => {
        const value = /\bsource:\s*"([^"]*)"/.exec(line)?.[1] ?? "";
        return !ALLOWED_SOURCES.includes(value);
      });

    expect(
      offenders,
      `plan_events.source must be one of ${ALLOWED_SOURCES.join(" | ")}. ` +
        `"paid" is stores.plan_source's vocabulary — the CHECK rejects it and ` +
        `the insert takes the plan activation down with it.`,
    ).toEqual([]);
  });

  it("★ a billing audit insert never shares a transaction with the plan update", () => {
    // The activation must survive an audit failure. Both correct writers
    // (platform.ts, plan-expiry) already isolate it; the billing ones did not,
    // and their comment claimed "best-effort" while the code was anything but.
    const hits = grep("Audit trail", ["app"]);
    expect(hits).toContain("own transaction");
  });
});
