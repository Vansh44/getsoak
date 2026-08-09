import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ★ THE IDLE LOCK IS MOUNTED IN EXACTLY ONE PLACE, AND THIS FAILS IF THAT SLIPS.
//
// It used to be per-page opt-in, and five of the seven POS screens never opted
// in — including the three where walking away costs the most: /pos/returns
// issues refunds, /pos/inventory adjusts stock, /pos/shift moves cash. A
// control every new page has to remember is one the next page will forget, so
// it now lives in app/pos/layout.tsx and covers the whole surface.
//
// Both directions are guarded, because both are silent:
//   - the layout losing it puts EVERY screen back to never locking;
//   - a page mounting its own runs a SECOND timer on that screen — two
//     countdown banners, and two posLock() calls racing each other.
//
// The same shape as lib/notifications/coverage.test.ts: a structural rule the
// type system cannot express, so a test holds it instead.

const POS_DIR = join(process.cwd(), "app/pos");

/** Where the component is defined — naturally names itself, and is not a mount. */
const DEFINITION = join(POS_DIR, "idle-lock.tsx");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("POS idle lock coverage", () => {
  const files = walk(POS_DIR);

  it("finds the POS route files at all (the walk itself must not silently pass)", () => {
    // A guard whose glob quietly matches nothing reports success forever. The
    // surface is 25+ files today; ten is a floor that only trips on a move.
    expect(files.length).toBeGreaterThan(10);
  });

  it("mounts IdleLock in the layout, so no screen can miss it", () => {
    const layout = readFileSync(join(POS_DIR, "layout.tsx"), "utf8");
    expect(layout).toMatch(/import\s*\{\s*IdleLock\s*\}/);
    expect(layout).toMatch(/<IdleLock\b/);
  });

  it("mounts it NOWHERE else — a second timer is two locks racing", () => {
    const offenders = files
      .filter((f) => f !== DEFINITION && f !== join(POS_DIR, "layout.tsx"))
      .filter((f) => /<IdleLock\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(process.cwd(), f));

    expect(offenders).toEqual([]);
  });

  it("keeps the superadmin exemption on the mount", () => {
    // The exemption is the whole reason the lock is safe to apply everywhere:
    // posLock clears sm_session too, so locking the person whose shop it is
    // would sign them out of the dashboard for standing still.
    const layout = readFileSync(join(POS_DIR, "layout.tsx"), "utf8");
    expect(layout).toMatch(/isIdleLockExempt/);
  });
});
