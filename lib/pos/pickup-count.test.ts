import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ★ THE BADGE AND THE LIST MUST COUNT THE SAME THING.
//
// countPickupsWaiting draws the number on the register's Orders rail; opening
// that entry runs getPickupQueue. They are two separate queries against the
// same table, and if their predicates drift the badge sends someone to a screen
// to look for work that isn't there — after which nobody trusts the number
// again. The count exists as its own query for a reason (it runs on every POS
// page load, including /pos/sell), so they can't simply be one function.
//
// A source-text guard, like app/pos/idle-lock-coverage.test.ts and
// lib/email/send-coverage.test.ts: a structural rule the type system cannot
// express, held by a test instead.

const COUNT_SRC = readFileSync(
  join(process.cwd(), "lib/pos/pickup-count.ts"),
  "utf8",
);
const QUEUE_SRC = readFileSync(
  join(process.cwd(), "app/actions/pos-pickup-actions.ts"),
  "utf8",
);

/** The `pickupStatus` values a query treats as "still waiting". */
function pickupStatuses(src: string): string[] {
  return [
    ...new Set(
      [...src.matchAll(/orders\.pickupStatus,\s*"([a-z_]+)"/g)].map(
        (m) => m[1],
      ),
    ),
  ].sort();
}

describe("pickup badge count", () => {
  it("reads both sources at all (a guard that matches nothing passes forever)", () => {
    expect(COUNT_SRC).toContain("countPickupsWaiting");
    expect(QUEUE_SRC).toContain("getPickupQueue");
  });

  it("counts exactly the statuses the queue lists", () => {
    // The queue file also writes statuses elsewhere (markReady, markCollected),
    // so compare against the count's set rather than the file's whole vocabulary
    // — every status the BADGE counts must be one the QUEUE shows.
    const counted = pickupStatuses(COUNT_SRC);
    expect(counted).toEqual(["awaiting", "ready"]);
    for (const status of counted) {
      expect(pickupStatuses(QUEUE_SRC)).toContain(status);
    }
  });

  it("scopes to the same store, location and fulfilment type", () => {
    // Missing any one of these is a badge counting another shop's shelf.
    for (const predicate of [
      /orders\.storeId/,
      /orders\.pickupLocationId/,
      /orders\.fulfilmentType,\s*"pickup"/,
    ]) {
      expect(COUNT_SRC).toMatch(predicate);
      expect(QUEUE_SRC).toMatch(predicate);
    }
  });

  it("never throws into the layout", () => {
    // It decorates a rail entry that renders either way. A DB blip must cost a
    // badge, not the ability to serve the customer at the counter.
    expect(COUNT_SRC).toMatch(/catch/);
    expect(COUNT_SRC).toMatch(/return 0/);
  });

  it("is not a server action — it takes ids as arguments", () => {
    // Every export of a "use server" file is a public endpoint, and this one
    // would accept somebody else's store and location. Callers derive both from
    // resolvePosOperator(). Same rule as lib/retention/prune.ts.
    expect(COUNT_SRC).not.toMatch(/^\s*["']use server["']/m);
    expect(COUNT_SRC).toMatch(/["']server-only["']/);
  });
});
