import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// COVERAGE GUARD — an export may never be wider than the screen it came from.
//
// ★★ THIS EXISTS BECAUSE IT ALREADY HAPPENED. The orders exporter filtered on
// `storeId` alone while the orders LIST filtered by the viewer's locations, so
// a Delhi-restricted admin saw Delhi orders on screen, pressed Export, and got
// every location's rows — customer names, addresses and phones included. The
// narrower path was the visible one, which is the worst way round: nothing on
// screen suggested the button was a way out of the scope.
//
// A unit test over the query builder would pin the two exporters that exist
// today. What actually goes wrong is the THIRD one, added next year against a
// location-bearing table by someone who has never read this file — so the guard
// is over the source, and it fails when a new exporter forgets.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync("lib/import-export/exporters.ts", "utf8");

/**
 * Exporters whose underlying table carries a location, and must therefore bound
 * their rows by the viewer's scope.
 *
 * Products, categories and coupons are deliberately absent: they are store-wide
 * by decision (a product is not IN a shop — its STOCK is), so scoping them
 * would hide catalogue rows from someone who is allowed to edit them.
 */
const LOCATION_BEARING = [
  { fn: "exportOrders", column: "orders.locationId" },
  { fn: "exportInventory", column: "inventoryLevels.locationId" },
];

/**
 * The body of one exporter, from its declaration to the next one.
 *
 * ⚠ They are async GENERATORS (`async function* exportOrders`), so the `*` has
 * to be optional — matching on `function ${fn}(` finds nothing and the guard
 * then passes vacuously, which is how a coverage test becomes decoration.
 */
function bodyOf(fn: string): string {
  const decl = new RegExp(`function\\*?\\s+${fn}\\s*\\(`);
  const start = SOURCE.search(decl);
  if (start === -1) return "";
  const rest = SOURCE.slice(start + 1);
  const next = rest.search(/\nasync function\*?\s/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("export location scope", () => {
  it("the context carries the viewer's scope", () => {
    expect(SOURCE).toMatch(/locationScope\?: LocationScope/);
  });

  it.each(LOCATION_BEARING)(
    "$fn bounds its rows by the viewer's locations",
    ({ fn, column }) => {
      const body = bodyOf(fn);
      expect(body, `${fn} not found in exporters.ts`).not.toBe("");
      expect(
        body.includes("scopeCondition"),
        `\n\n${fn} reads a table with a location but never applies ` +
          `ctx.locationScope, so a location-restricted admin can export rows ` +
          `they cannot see on screen. Add:\n\n` +
          `  const scoped = scopeCondition(ctx.locationScope, ${column});\n` +
          `  if (scoped) conds.push(scoped);\n`,
      ).toBe(true);
    },
  );

  // ⚠ The route is the gate. Resolving the scope inside each exporter would be
  // one more place to forget it, and one more place to look when asking whether
  // an export is bounded.
  it("the route resolves the scope and passes it in", () => {
    const route = readFileSync("app/api/dashboard/export/route.ts", "utf8");
    expect(route).toMatch(/getViewerLocations\(\)/);
    expect(route).toMatch(/locationScope/);
  });

  // ★ An EMPTY scope means "assigned to nothing that still exists" and must
  // match NOTHING. Skipping the predicate when the array is empty would
  // silently promote such an admin to exporting the whole store — the exact
  // inversion this guard exists to prevent.
  it("an empty scope still produces a predicate", () => {
    const helper = SOURCE.slice(
      SOURCE.indexOf("function scopeCondition"),
      SOURCE.indexOf("function scopeCondition") + 400,
    );
    // Null/undefined is the only thing that opts out; length is never checked.
    expect(helper).toMatch(/=== null \|\| scope === undefined/);
    expect(helper).not.toMatch(/\.length === 0/);
  });
});
