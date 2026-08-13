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

/**
 * grep with N lines of leading context, over BOTH app and lib.
 *
 * ⚠ `lib` is not optional: the billing writers moved there in the 2026-08-13
 * cutover, and a guard that scans only `app` silently stops guarding them.
 */
function grepBlock(pattern: string, before: number): string {
  try {
    return execFileSync(
      "grep",
      ["-rEn", `-B${before}`, "--include=*.ts", pattern, "app", "lib"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((l) => !/\.test\.ts[-:]/.test(l))
      .join("\n");
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

  it("★★ every plan_events insert opens its OWN transaction", () => {
    // The activation must survive an audit failure. `withService` wraps its
    // callback in one BEGIN/COMMIT, so an insert sharing a callback with the
    // `stores` update takes the plan down with it when the CHECK rejects it —
    // which is exactly the outage above, and it was silent for months.
    //
    // ★ STRUCTURAL, not comment-based. This used to assert that a `grep`
    // for "Audit trail" contained the words "own transaction", which stopped
    // meaning anything the moment the file holding that comment was deleted
    // (2026-08-13, the billing cutover) — it passed a `""` haystack for a while
    // and then failed for the wrong reason. Now it checks the property: the
    // insert is the FIRST db call inside its own withService.
    const block = grepBlock("insert\\(planEvents\\)", 3);
    expect(block, "no planEvents inserts found — did the table move?").not.toBe(
      "",
    );

    // Each match arrives as up to 3 preceding lines then the insert. An insert
    // that opens its own scope has `withService(` within those lines and no
    // other `db.` call between.
    const groups = block.split(/^--$/m).filter((g) => g.trim() !== "");
    const offenders = groups.filter((g) => {
      if (!/withService\(/.test(g)) return true;
      const after = g.slice(g.search(/withService\(/));
      const dbCalls = after.match(/\bdb\s*\.\w+/g) ?? [];
      // Exactly one: the planEvents insert itself.
      return dbCalls.length !== 1;
    });

    expect(
      offenders,
      "a plan_events insert must be alone in its withService — sharing one with " +
        "the stores update lets a rejected audit row roll back a paid plan.",
    ).toEqual([]);
  });
});
