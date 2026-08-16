"use client";

// Re-read something on a timer, for the till.
//
// ★ WHY THE REGISTER POLLS AT ALL. A collection arrives from the STOREFRONT —
// nothing on the counter's screen causes it — so without this the queue and its
// badge only move when a human reloads the page. That is what a shop actually
// hit: an order placed online sat invisible until someone thought to refresh, on
// the one screen whose whole job is to notice it.
//
// ★ AND WHY IT IS A POLL RATHER THAN A PUSH. A socket or SSE stream means a held
// connection per till, a reconnect story, and a server that has to know which
// locations are watching. The thing being watched is one indexed COUNT and
// changes a few times an hour; a request on a slow timer is the honest size of
// the problem. If collections ever become high-frequency this is the seam to
// replace.

import { useEffect, useRef } from "react";

/** Slow on purpose: a collection is a person walking to a shop, not a tick. */
export const POS_POLL_MS = 30_000;

/**
 * Call `fn` every `ms`, but only while the tab is visible AND the browser is
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
 * ★ THE CATCH-UP IS THE POINT. Coming back to the tab, or back onto the network,
 * fires straight away. That matches how staleness is actually noticed: somebody
 * walks back to the till and expects the screen to be true, not to be true in
 * another twenty seconds.
 *
 * ★ AND IT NEVER STACKS. One interval, cleared before another starts, so a
 * flapping connection cannot leave two timers running against one screen.
 */
export function usePoll(fn: () => void, ms = POS_POLL_MS, enabled = true) {
  // The latest callback, so changing it never restarts the timer — a poll that
  // resets whenever its closure changes is a poll that may never fire.
  const saved = useRef(fn);
  useEffect(() => {
    saved.current = fn;
  }, [fn]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    // `navigator.onLine` is a weak signal — true means "there is an interface",
    // not "the internet works". It is used only to STOP and to trigger a
    // catch-up, never to decide that a request would have succeeded, so a false
    // positive costs one failed request and a false negative is corrected by the
    // `online` event.
    const awake = () =>
      document.visibilityState === "visible" && navigator.onLine !== false;

    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer === null) timer = setInterval(() => saved.current(), ms);
    };
    const sync = (catchUp: boolean) => {
      if (!awake()) {
        stop();
        return;
      }
      if (catchUp) saved.current();
      start();
    };

    const onVisibility = () => sync(true);
    const onOnline = () => sync(true);
    const onOffline = () => stop();

    sync(false); // Mount is not a catch-up: the server just rendered this.
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [ms, enabled]);
}
