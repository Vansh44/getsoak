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
 * Call `fn` every `ms`, but ONLY while the tab is visible.
 *
 * ★ THE VISIBILITY RULE IS NOT AN OPTIMISATION. A till is left open all night
 * and a browser keeps background timers running; without it every closed shop
 * would spend the small hours making requests nobody will read. It also fires
 * once on becoming visible again, so a cashier returning to the tab sees the
 * truth immediately instead of waiting out the rest of an interval.
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

    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      if (timer === null) timer = setInterval(() => saved.current(), ms);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        saved.current();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms, enabled]);
}
