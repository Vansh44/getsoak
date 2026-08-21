import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectionNote,
  collectionState,
  handoverGate,
  isCollectable,
  isExpiringSoon,
  isPrepared,
  PICKUP_WARN_HOURS,
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

// ---------------------------------------------------------------------------
// Handing over something nobody prepared
//
// The bug: markCollected accepted 'awaiting' as readily as 'ready', and the row
// drew one green button for either — so a cashier could close an order out of
// the "To prepare" queue that nobody had packed, in one tap, silently.
//
// ★ IT IS NOT A PERMISSION QUESTION. There was briefly a `manager_only` policy
// here; it went when `fulfil_pickup` was granted to cashiers, because the same
// person could then tap Mark ready and then Hand over — the same outcome in two
// taps. What remains is making the skip DELIBERATE.
// ---------------------------------------------------------------------------

describe("handoverGate", () => {
  it("lets a prepared order straight through", () => {
    expect(handoverGate({ status: "ready" })).toEqual({
      allowed: true,
      unprepared: false,
    });
  });

  // A prepared order must never ask for an acknowledgement — a confirmation on
  // the ordinary path is one people learn to dismiss without reading, which is
  // what would make it useless on the path that needs it.
  it("never asks about an order that was marked ready", () => {
    for (const acknowledged of [true, false, undefined]) {
      expect(handoverGate({ status: "ready", acknowledged })).toEqual({
        allowed: true,
        unprepared: false,
      });
    }
  });

  it("stops an unprepared order until it is acknowledged", () => {
    const r = handoverGate({ status: "awaiting" });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/hasn't been marked ready/i);
  });

  // ★ POSSIBLE, DELIBERATE, RECORDED. A customer who arrives before the shop
  // has packed is ordinary, and whoever is at the counter must be able to serve
  // them — the acknowledgement is what stops it being a mis-tap.
  it("lets an acknowledged operator through, and flags it as unprepared", () => {
    expect(handoverGate({ status: "awaiting", acknowledged: true })).toEqual({
      allowed: true,
      unprepared: true,
    });
  });

  // An unknown or missing status is not "ready", so it takes the careful path
  // rather than being waved through.
  it.each([[null], [undefined], [""], ["collected"], ["nonsense"]])(
    "treats the status %s as unprepared",
    (status) => {
      expect(isPrepared(status as string | null | undefined)).toBe(false);
      expect(handoverGate({ status }).allowed).toBe(false);
    },
  );
});

// ── isExpiringSoon (roadmap Step 18) ───────────────────────────────────────
// The counter row already said "2 days left"; nothing SUMMARISED it, so on a
// queue of twenty parcels the urgent one had to be found by reading every row.

describe("isExpiringSoon", () => {
  const now = new Date("2026-08-18T12:00:00Z");
  const inHours = (h: number) =>
    new Date(now.getTime() + h * 3_600_000).toISOString();

  it("flags a collection inside the warning window", () => {
    expect(isExpiringSoon(inHours(12), now)).toBe(true);
    expect(isExpiringSoon(inHours(PICKUP_WARN_HOURS - 1), now)).toBe(true);
  });

  it("does not flag one comfortably in the future", () => {
    expect(isExpiringSoon(inHours(PICKUP_WARN_HOURS + 1), now)).toBe(false);
  });

  it("★★ an ALREADY-expired collection is not 'expiring soon'", () => {
    // That is `lapsed`/`gone`, which the row says in its own words. Counting it
    // here would put a parcel nobody can act on into a banner about chasing
    // customers.
    expect(isExpiringSoon(inHours(-1), now)).toBe(false);
    expect(isExpiringSoon(inHours(0), now)).toBe(false);
  });

  it("a collection with no deadline is never urgent", () => {
    expect(isExpiringSoon(null, now)).toBe(false);
    expect(isExpiringSoon(undefined, now)).toBe(false);
  });

  it("an unparseable date is not urgent rather than throwing", () => {
    expect(isExpiringSoon("not-a-date", now)).toBe(false);
  });

  it("★ uses the SAME window as the customer's email", () => {
    // The shop seeing "3 expiring" while the customer was nudged on a different
    // clock is the drift that makes staff distrust both numbers.
    expect(PICKUP_WARN_HOURS).toBe(48);
  });
});
