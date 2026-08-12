// The register's destinations — ONE list, so a screen cannot exist without a
// way to reach it and a role cannot be shown a door it will be turned away at.
//
// ★ WHY A REGISTRY RATHER THAN LINKS IN A HEADER. Every POS screen used to
// hand-roll its own navigation: /pos/sell's header carried four links, the other
// five screens carried a back arrow to /pos and nothing else, and /pos itself was
// a pile of buttons. Three consequences, all of them real:
//
//   1. Collections was reachable ONLY from a tile on /pos that rendered when the
//      queue was non-empty — so a manager could not open an empty queue to mark
//      the box in their hands as ready.
//   2. Going from Stock to the cash drawer took three taps, via a screen whose
//      entire content was "You're signed in".
//   3. The gating drifted. /pos/sell showed "Stock" when `canEditLayout`, which
//      is the edit_layout capability standing in for adjust_inventory — the same
//      set today, but nothing keeps them that way.
//
// Pure and dependency-free ON PURPOSE (no React, no lucide): the icons live in
// app/pos/pos-nav.tsx keyed by `key`, so this module stays importable from a
// server component and a test without dragging a client bundle behind it. Same
// split as lib/logs/failure-types.ts and lib/themes/meta.ts.

import type { PosActorRole, PosCapability } from "./permissions";
import { posCan } from "./permissions";

export type PosNavKey =
  | "sell"
  | "pickups"
  | "returns"
  | "sales"
  | "inventory"
  | "shift";

export interface PosNavItem {
  key: PosNavKey;
  href: string;
  /** The rail/drawer label. Kept to one word where possible — it sits under a
   *  24px icon in a 64px rail, and two words wrap to two lines. */
  label: string;
  /** What the screen is for, shown in the drawer where there is room for it. */
  hint: string;
  /**
   * The capability that opens the SCREEN — never the strongest thing on it.
   * `orders` is `sell`, because handing over a collection and reprinting a
   * receipt are a cashier's job with the customer standing there; taking a
   * return is gated again, inside, on `refund`. Gating the door on the strongest
   * action would hide collections from every cashier who has to hand them over.
   */
  cap: PosCapability;
}

/** Order is display order, and it is the order of a shift: sell first, because
 *  that is what the till is for and the rail's first slot is the one hit by
 *  muscle memory. */
export const POS_NAV: readonly PosNavItem[] = [
  {
    key: "sell",
    href: "/pos/sell",
    label: "Sell",
    hint: "Ring up a sale",
    cap: "sell",
  },
  {
    key: "pickups",
    href: "/pos/pickups",
    // ★ "Pickups", not "Orders". Shopify POS calls the equivalent screen
    // Orders, but at THIS till it sat two rows below "Sales" — and a cashier
    // reads both as "the things we sold". Naming the job the screen exists for
    // beats matching another product's vocabulary.
    label: "Pickups",
    hint: "Orders waiting to be collected",
    cap: "sell",
  },
  {
    key: "returns",
    href: "/pos/returns",
    // ★ ITS OWN DOOR, THE SAME SEARCH BEHIND IT. Someone holding goods a
    // customer just handed back would not think to tap "Pickups", so returns
    // needs a name in the rail. It is NOT a second lookup — both doors run the
    // same query; see app/pos/counter-client.tsx.
    label: "Returns",
    hint: "Take goods back",
    // The one destination gated above `sell`: a cashier cannot give money back,
    // so a door they would be turned away at is worse than no door. The screen
    // re-checks, for anyone who types the URL.
    cap: "refund",
  },
  {
    key: "sales",
    href: "/pos/sales",
    label: "Sales",
    hint: "Find a sale, reprint a receipt",
    cap: "sell",
  },
  {
    key: "inventory",
    href: "/pos/inventory",
    label: "Stock",
    hint: "Count, receive and transfer",
    cap: "adjust_inventory",
  },
  {
    key: "shift",
    href: "/pos/shift",
    label: "Drawer",
    hint: "Open, count and close the till",
    // A cashier may LOOK — they need to know whether the drawer is open before
    // they can sell into it — and every mutating control on the screen is gated
    // again in pos-shift-actions. Mirrors the page's own redirect.
    cap: "sell",
  },
] as const;

/** The destinations this actor may open. */
export function posNavFor(role: PosActorRole): PosNavItem[] {
  return POS_NAV.filter((item) => posCan(role, item.cap));
}

/**
 * Which destination a pathname belongs to, for the "you are here" state.
 *
 * Prefix-matched on a SEGMENT boundary, not equality: `/pos/returns/<id>` is
 * the return detail, which has no rail entry of its own and belongs to Returns.
 * The boundary matters — a plain `startsWith` would light Sell on a future
 * `/pos/sell-report`.
 *
 * Returns null on /pos/login, /pos/register and /pos/reset, where there is no
 * operator and therefore no rail.
 */
export function activePosNavKey(pathname: string): PosNavKey | null {
  // `/pos/orders` is where the counter screen briefly lived; it 307s to
  // /pos/pickups, but a mid-flight render should still light the right entry.
  if (/^\/pos\/orders(\/|$)/.test(pathname)) return "pickups";
  const hit = POS_NAV.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  return hit?.key ?? null;
}
