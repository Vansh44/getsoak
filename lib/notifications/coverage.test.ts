import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { EVENT_KEYS } from "./events";

// ---------------------------------------------------------------------------
// COVERAGE GUARD — every notification in the registry must actually fire.
//
// The console lists every registry entry as configurable. A merchant who opens
// "Plan changed", sets recipients and writes copy has been told, by the UI,
// that it works. If nothing emits it, that's worse than the notification not
// existing: it's a promise the product doesn't keep, and nothing fails loudly.
//
// This test caught exactly that — 11 of 38 events had an emitter and the rest
// were dead entries, including plan changes and customer signup. All 38 fire
// now; the two exceptions below are features that don't exist yet.
//
// So: an event is either EMITTED somewhere, or explicitly listed as PENDING
// below with the feature it's waiting on. There is no third state.
// ---------------------------------------------------------------------------

/**
 * Events with no emitter YET, each blocked on a feature that doesn't exist.
 *
 * Adding a key here is a deliberate act — it should come with the reason, and
 * it should be removed the moment the feature lands. Do NOT add a key here to
 * silence the test.
 */
const PENDING: Record<string, string> = {
  "order.cancellation_requested":
    "Order cancellation isn't built yet (see docs/ — cancellation phase).",
  "order.refund_issued":
    "Refunds are out of scope until the cancellation phase (CODEBASE.md §18).",
};

/**
 * Every key that is emitted somewhere real, found in ONE grep pass.
 *
 * One pass, not one per key: 38 greps over the whole tree took long enough to
 * blow the 5s test timeout when the rest of the suite was running in parallel,
 * which read as a coverage failure rather than a slow test.
 *
 * A key found only in the notification library itself, a test, or docs doesn't
 * count — the registry, the renderer and the default templates all name every
 * key by definition, so matching there would prove nothing.
 */
const EMITTED: Set<string> = (() => {
  const found = new Set<string>();
  let out = "";
  try {
    out = execFileSync(
      "grep",
      [
        "-rHoE",
        "--include=*.ts",
        "--include=*.tsx",
        `"(${EVENT_KEYS.join("|")})"`,
        "app",
        "lib",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    // grep exits 1 when nothing matches at all.
    return found;
  }
  for (const line of out.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const file = line.slice(0, sep);
    if (
      file.startsWith("lib/notifications/") ||
      file.includes(".test.") ||
      file.includes("/docs/")
    ) {
      continue;
    }
    found.add(line.slice(sep + 1).replace(/"/g, ""));
  }
  return found;
})();

function isEmitted(key: string): boolean {
  return EMITTED.has(key);
}

describe("notification coverage", () => {
  it("every registry event is either emitted or explicitly pending", () => {
    const orphans: string[] = [];
    for (const key of EVENT_KEYS) {
      if (key in PENDING) continue;
      if (!isEmitted(key)) orphans.push(key);
    }

    expect(
      orphans,
      orphans.length
        ? `\n\nThese notifications are in the registry and shown in the console, ` +
            `but NOTHING emits them:\n` +
            orphans.map((o) => `  • ${o}`).join("\n") +
            `\n\nEither call emitEvent({ type: "…" }) from the action that does ` +
            `the thing, or add the key to PENDING in this file with the feature ` +
            `it's waiting on.\n`
        : "",
    ).toEqual([]);
  });

  it("nothing in PENDING has quietly gained an emitter", () => {
    // Keeps the allowlist honest: once a feature ships and starts emitting, its
    // entry has to come out, so PENDING never becomes a graveyard.
    const shipped = Object.keys(PENDING).filter(isEmitted);
    expect(
      shipped,
      shipped.length
        ? `These are emitted now — remove them from PENDING: ${shipped.join(", ")}`
        : "",
    ).toEqual([]);
  });

  it("every PENDING key is a real registry key", () => {
    for (const key of Object.keys(PENDING)) {
      expect(EVENT_KEYS, `PENDING lists "${key}"`).toContain(key);
    }
  });
});
