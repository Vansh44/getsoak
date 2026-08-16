"use client";

// Re-read something on a timer, for the till.
//
// ★ WHY THE REGISTER POLLS AT ALL. A collection arrives from the STOREFRONT and
// stock moves on the till next to you — nothing on this screen causes either, so
// without this the queue, the badge and the stock list only move when a human
// reloads the page. That is what a shop actually hit.
//
// ★ AND WHY IT IS A POLL RATHER THAN A PUSH — with the numbers, because the
// intuition points the wrong way. A socket or SSE stream means one HELD
// connection per till: at 10,000 tills and Cloud Run's default concurrency of
// 80, that is ~125 instances doing nothing but holding connections open, plus a
// reconnect story and a server that has to know which locations are watching.
// The same 10,000 tills polling once a minute is ~167 req/s, which is ordinary
// traffic that scales to zero when the shops are shut. Push is the better answer
// only when the watched thing changes faster than the poll interval; a shop
// takes a handful of collections a day. THIS is the seam to replace if that ever
// stops being true.

import { useEffect, useRef } from "react";

/**
 * Slow on purpose: a collection is a person walking to a shop, not a tick.
 *
 * ★ THE STEADY-STATE COST IS WHAT THIS NUMBER BUYS. Every active till pays it
 * all day whether or not anything happens, so it is the one figure that decides
 * what the fleet costs at rest. See `POS_POLL_BACKOFF_MAX_MS` — a till watching
 * a queue that never changes stretches out to that instead.
 */
export const POS_POLL_MS = 30_000;

/**
 * Where an unchanging poll settles.
 *
 * ★ A QUIET SHOP SHOULD NOT COST WHAT A BUSY ONE DOES. A store taking two
 * collections a day was making ~2,880 requests to learn "still nothing" 2,878
 * times. Backing off to two minutes cuts that by 4× while changing nothing about
 * the busy case, because ANY change — or any catch-up — resets it to the base
 * interval immediately.
 */
export const POS_POLL_BACKOFF_MAX_MS = 120_000;

/**
 * ±15%, so a fleet of tills does not phase-lock.
 *
 * ★ THEY START TOGETHER. A deploy restarts every till at once, and a shop opens
 * its registers within a minute of each other — on a fixed interval those stay
 * in step forever, turning steady traffic into a spike every 30 seconds against
 * one Cloud SQL instance. Jitter costs nothing and spreads them out for good.
 */
const JITTER = 0.15;

export interface PollOptions {
  /** Base interval. */
  ms?: number;
  /** False suspends everything — used while a cashier is mid-action. */
  enabled?: boolean;
  /**
   * Stretch the interval while `fn` reports nothing changed.
   *
   * Opt-in, because it needs `fn` to RETURN whether anything moved, and a caller
   * that cannot tell (the catalog sync, which does not diff) would otherwise
   * slow itself down on no evidence.
   */
  backOff?: boolean;
}

/** What a polled callback may report so back-off knows what happened. */
export type PollResult = boolean | void | Promise<boolean | void>;

function withJitter(ms: number): number {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * JITTER));
}

/**
 * Call `fn` on an interval, but only while the tab is visible AND the browser is
 * online — and immediately whenever either of those becomes true again.
 *
 * ★ THE TWO GATES ARE NOT OPTIMISATIONS, they are what makes this dependable:
 *
 *   VISIBILITY. A till is left open all night and browsers keep background
 *   timers running, so without it every closed shop spends the small hours
 *   making requests nobody will read.
 *
 *   ONLINE. Shop wifi drops. A bare interval keeps firing into a dead network,
 *   each call failing silently, and then — this is the part that actually hurt —
 *   the FIRST tick after the network returns is up to a full interval away, so
 *   the screen stays wrong long after the connection is back.
 *
 * ★★ THE CATCH-UP IS THROTTLED BY THE INTERVAL ITSELF, and that is a bug fix,
 * not a tuning knob. `visibilitychange` fires on every tab switch, every window
 * minimise, and every app switch on a tablet — so an unthrottled catch-up let
 * somebody flipping between two tabs trigger a full catalog sync (several
 * requests over hundreds of products) on EVERY flip. The rule is: if we already
 * ran within one interval, the data is exactly as fresh as the schedule
 * promises, so a catch-up would add nothing. Away for longer than an interval
 * and it fires at once — which is the case that matters, someone coming back to
 * the till expecting the screen to be true.
 *
 * ★ AND IT NEVER STACKS. One timer, cleared before another starts, so a flapping
 * connection cannot leave two running against one screen.
 */
export function usePoll(
  fn: () => PollResult,
  msOrOptions: number | PollOptions = POS_POLL_MS,
  enabledArg = true,
) {
  const opts: PollOptions =
    typeof msOrOptions === "number"
      ? { ms: msOrOptions, enabled: enabledArg }
      : msOrOptions;
  const ms = opts.ms ?? POS_POLL_MS;
  const enabled = opts.enabled ?? true;
  const backOff = opts.backOff ?? false;

  // The latest callback, so changing it never restarts the timer — a poll that
  // resets whenever its closure changes is a poll that may never fire, and these
  // close over search text and filters that change on every keystroke.
  const saved = useRef(fn);
  useEffect(() => {
    saved.current = fn;
  }, [fn]);

  const lastRunAt = useRef(0);
  const idleRuns = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    // `navigator.onLine` is a weak signal — true means "there is an interface",
    // not "the internet works". It is used only to STOP and to trigger a
    // catch-up, never to decide that a request would have succeeded, so a false
    // positive costs one failed request and a false negative is corrected by the
    // `online` event.
    const awake = () =>
      document.visibilityState === "visible" && navigator.onLine !== false;

    /** How long until the next run — base interval, stretched while nothing
     *  changes, then jittered so tills do not move in step. */
    const nextDelay = () => {
      const grown = backOff
        ? Math.min(
            ms * 2 ** Math.min(idleRuns.current, 4),
            POS_POLL_BACKOFF_MAX_MS,
          )
        : ms;
      return withJitter(grown);
    };

    const arm = () => {
      if (cancelled || timer !== null) return;
      timer = setTimeout(run, nextDelay());
    };
    const disarm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    async function run() {
      timer = null;
      if (cancelled || !awake()) return;
      lastRunAt.current = Date.now();
      let changed: boolean | void;
      try {
        changed = await saved.current();
      } catch {
        // A failed poll is not an event. The screen keeps what it had and the
        // next tick tries again; surfacing it would be a toast nobody asked for.
        changed = undefined;
      }
      // `undefined` means the caller does not report — treat that as "changed"
      // so an uninstrumented poll never silently slows itself down.
      idleRuns.current = changed === false ? idleRuns.current + 1 : 0;
      arm();
    }

    const wake = () => {
      if (!awake()) {
        disarm();
        return;
      }
      // ★ Already ran within one interval ⇒ nothing to catch up on.
      if (Date.now() - lastRunAt.current >= ms) {
        // Coming back is evidence something may have happened while away, so
        // the stretched interval is abandoned rather than carried through it.
        idleRuns.current = 0;
        disarm();
        void run();
        return;
      }
      arm();
    };

    // Mount is not a catch-up: the server has just rendered this screen.
    lastRunAt.current = Date.now();
    if (awake()) arm();

    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("offline", disarm);
    return () => {
      cancelled = true;
      disarm();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", disarm);
    };
  }, [ms, enabled, backOff]);
}
