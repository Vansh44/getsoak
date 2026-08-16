"use client";

// The client half of /api/pos/live — the till's polling transport.
//
// A plain `fetch`, deliberately, and that is the whole reason this exists: the
// Server Actions these calls replaced went through Next's client dispatcher,
// which runs actions ONE AT A TIME, so a background refresh in flight delayed
// the cashier's next tap. A GET has no such queue and overlaps freely with
// whatever the operator is doing.

import type { PickupOrder } from "@/app/actions/pos-pickup-actions";
import type { PosInventoryItem } from "@/app/actions/pos-inventory-actions";

/** `null` means "we could not tell" — never "there is nothing". */
export type LiveResult<T> = T | null;

async function poll<T>(
  need: string,
  params: Record<string, string> = {},
): Promise<LiveResult<T>> {
  const qs = new URLSearchParams({ need, ...params });
  try {
    const res = await fetch(`/api/pos/live?${qs}`, {
      // The screen wants what is true NOW; a cached poll is not a poll.
      cache: "no-store",
      // Same-origin cookies carry the device + operator tokens. They are
      // SameSite=Strict and host-only (CODEBASE §22), so this only ever works
      // from the till's own origin — which is the intent.
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // Offline, aborted, or a blip. `usePoll` already stops on `offline`; this
    // covers the window before that event lands. The caller keeps what it had.
    return null;
  }
}

/** Collections waiting on this shop's shelf. */
export function fetchPickupCount(): Promise<LiveResult<{ count: number }>> {
  return poll<{ count: number }>("pickups");
}

/** The full collection queue for this counter. */
export function fetchPickupQueue(): Promise<
  LiveResult<{ orders: PickupOrder[]; error?: string }>
> {
  return poll<{ orders: PickupOrder[]; error?: string }>("queue");
}

/** Stock rows at this location, matching the screen's current filters. */
export function fetchStock(
  query: string,
  lowOnly: boolean,
): Promise<LiveResult<{ items: PosInventoryItem[]; error?: string }>> {
  return poll<{ items: PosInventoryItem[]; error?: string }>("stock", {
    q: query,
    low: lowOnly ? "1" : "0",
  });
}
