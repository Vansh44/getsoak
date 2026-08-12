import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectionNote,
  collectionState,
  isCollectable,
} from "./collection-state";

const NOW = new Date("2026-08-12T10:00:00.000Z");
const YESTERDAY = "2026-08-11T10:00:00.000Z";
const TOMORROW = "2026-08-13T10:00:00.000Z";

describe("collection state", () => {
  describe("what the counter may still do", () => {
    it("is collectable while waiting inside the hold window", () => {
      expect(collectionState("awaiting", TOMORROW, NOW)).toBe("collectable");
      expect(collectionState("ready", TOMORROW, NOW)).toBe("collectable");
    });

    it("★ is LAPSED, not gone, once the window passes but before the sweep", () => {
      // The state that made the screen look broken. sweepExpiredPickups runs
      // daily, so this lasts up to 24h in production — and markCollected will
      // still hand the order over, because its claim only checks the STATUS.
      // The row must keep its button and explain itself.
      expect(collectionState("ready", YESTERDAY, NOW)).toBe("lapsed");
      expect(collectionState("awaiting", YESTERDAY, NOW)).toBe("lapsed");
      expect(isCollectable("lapsed")).toBe(true);
    });

    it("is gone once the sweep has cancelled it", () => {
      expect(collectionState("expired", YESTERDAY, NOW)).toBe("gone");
      expect(isCollectable("gone")).toBe(false);
    });

    it("is gone once it has been handed over", () => {
      // A second hand-over must not be offered. markCollected's claim would
      // match zero rows, so the button could only ever fail.
      expect(collectionState("collected", TOMORROW, NOW)).toBe("gone");
    });

    it("treats an unknown or missing status as gone", () => {
      // Fails toward NOT offering an action: the server's claim allows exactly
      // awaiting|ready, so anything else cannot be handed over. Guessing the
      // other way puts a failing button in front of a customer.
      expect(collectionState("something_new", TOMORROW, NOW)).toBe("gone");
      expect(collectionState(null, TOMORROW, NOW)).toBe("gone");
      expect(collectionState(undefined, TOMORROW, NOW)).toBe("gone");
    });
  });

  describe("dates that cannot be trusted", () => {
    it("stays collectable with no expiry at all", () => {
      // A store with no hold window set. Nothing has lapsed.
      expect(collectionState("ready", null, NOW)).toBe("collectable");
      expect(collectionState("ready", undefined, NOW)).toBe("collectable");
    });

    it("stays collectable on an unparseable expiry", () => {
      // The hold is a courtesy and the goods are on the shelf — refusing to
      // serve someone because a timestamp is malformed helps nobody.
      expect(collectionState("ready", "not-a-date", NOW)).toBe("collectable");
    });

    it("accepts a Date as well as an ISO string", () => {
      expect(collectionState("ready", new Date(YESTERDAY), NOW)).toBe("lapsed");
      expect(collectionState("ready", new Date(TOMORROW), NOW)).toBe(
        "collectable",
      );
    });
  });

  describe("what the cashier is told", () => {
    it("says nothing at all in the ordinary case", () => {
      // A note on every row is a note nobody reads.
      expect(collectionNote("collectable", "ready")).toBe("");
    });

    it("says a lapsed order can still be handed over", () => {
      expect(collectionNote("lapsed", "ready")).toMatch(
        /still be handed over/i,
      );
    });

    it("says where the STOCK went on an expired one", () => {
      // The merchant's next question after "cancelled", and not obvious.
      const note = collectionNote("gone", "expired");
      expect(note).toMatch(/cancelled/i);
      expect(note).toMatch(/stock/i);
    });

    it("distinguishes already-collected from expired", () => {
      // "It may already have been collected" was the old catch-all guess for
      // every one of these; the counter can be exact.
      expect(collectionNote("gone", "collected")).toMatch(/already handed/i);
      expect(collectionNote("gone", "collected")).not.toMatch(/cancelled/i);
    });

    it("still says something useful for an unknown status", () => {
      expect(collectionNote("gone", "who_knows")).toMatch(/no longer waiting/i);
      expect(collectionNote("gone", null)).toBeTruthy();
    });
  });

  // ★★ THE BUTTON AND THE CLAIM MUST AGREE ON WHAT IS COLLECTABLE.
  //
  // This whole module exists because they did not: markCollected has always
  // scoped its read to `pickup_status in ('awaiting','ready')`, while the row
  // drew "Hand over" unconditionally — so a scanned expired order offered a
  // button that could only fail. If someone widens the action's claim (adding a
  // status a counter may hand over from) without widening LIVE_STATUSES, the
  // button silently goes missing for it; narrowing the claim without narrowing
  // this brings the failing button back. A source-text guard, like
  // app/pos/idle-lock-coverage.test.ts.
  it("uses exactly the statuses markCollected will claim", () => {
    const action = readFileSync(
      join(process.cwd(), "app/actions/pos-pickup-actions.ts"),
      "utf8",
    );
    // The claim inside markCollected, as `eq(orders.pickupStatus, "…")` pairs.
    const claimed = [
      ...new Set(
        [...action.matchAll(/orders\.pickupStatus,\s*"([a-z_]+)"/g)].map(
          (m) => m[1],
        ),
      ),
    ].sort();
    // The action also WRITES statuses (collected, expired) via .set(), which
    // this pattern does not match — only the eq() comparisons, which are the
    // read predicates. Both the queue and the hand-over gate on the same two.
    expect(claimed).toEqual(["awaiting", "ready"]);

    const src = readFileSync(
      join(process.cwd(), "lib/pos/collection-state.ts"),
      "utf8",
    );
    const live = [
      ...src
        .match(/LIVE_STATUSES = new Set\(\[([^\]]*)\]\)/)![1]
        .matchAll(/"([a-z_]+)"/g),
    ]
      .map((m) => m[1])
      .sort();
    expect(live).toEqual(claimed);
  });
});
