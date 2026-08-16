"use client";

// The collections count, shared between the nav that DRAWS it and the counter
// screen that already knows it.
//
// ★ TWO PROBLEMS, ONE STORE.
//
//   1. THEY DISAGREED. `/pos/pickups` drops a row the moment it is handed over,
//      but the rail's badge only moved on its own next tick — so for up to
//      thirty seconds the menu said "3" over a list showing 2. A badge that
//      contradicts the screen under it is worse than no badge, which is the
//      rule `pickup-count.test.ts` already exists to defend.
//
//   2. THEY BOTH ASKED. The queue read already contains the count, so polling
//      for it separately on that screen is a second request for a fact the
//      first one carried.
//
// ★ THE CLAIM IS TIED TO THE COUNTER'S OWN POLL, not to the screen being
// mounted. That poll suspends while the cashier is mid-action or searching, and
// a claim held across those would freeze the badge for as long as somebody kept
// a search box full. Claim while it is live, release when it is not, and the nav
// picks polling straight back up.
//
// A module-level store rather than context: the nav is mounted in the layout and
// the counter is a page under it, so a provider would have to wrap the layout to
// serve a child two levels down — and this is one number.

import { useSyncExternalStore } from "react";

export interface PickupBadgeState {
  /** null = nobody has published one; fall back to the server's number. */
  count: number | null;
  /** True while a screen is keeping the count fresh itself. */
  owned: boolean;
}

// Stable identities. `useSyncExternalStore` compares snapshots by reference, so
// building a fresh object per read would re-render forever.
const EMPTY: PickupBadgeState = { count: null, owned: false };
let snapshot: PickupBadgeState = EMPTY;
let owners = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getSnapshot = () => snapshot;
/** The server has no store; the nav falls back to its prop. */
const getServerSnapshot = () => EMPTY;

/** Report the count a screen has just read for itself. */
export function publishPickupCount(count: number): void {
  if (snapshot.count === count) return;
  snapshot = { ...snapshot, count };
  emit();
}

/**
 * Say that this screen is keeping the count fresh, so the nav can stop asking.
 * Returns the release; safe to nest, since several screens could in principle
 * claim at once and the badge only goes back to polling when the last releases.
 */
export function claimPickupBadge(): () => void {
  owners += 1;
  if (owners === 1) {
    snapshot = { ...snapshot, owned: true };
    emit();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners -= 1;
    if (owners === 0) {
      snapshot = { ...snapshot, owned: false };
      emit();
    }
  };
}

export function usePickupBadge(): PickupBadgeState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test seam — module state outlives a test file otherwise. */
export function __resetPickupBadge(): void {
  snapshot = EMPTY;
  owners = 0;
  listeners.clear();
}
