// POS role capabilities (docs/pos-plan.md §3.3). POS roles are a SEPARATE model
// from dashboard `roles` — they live on pos_staff.role. Pure module — enforce
// these SERVER-SIDE in the POS actions, never from a client flag.
//
// FOUR actors, two of them dashboard-side:
//   cashier / manager  — pos_staff rows, signed in with a PIN or password.
//   owner              — a dashboard admin whose role grants the POS section.
//   superadmin         — the store's superadmin, or a platform operator (an
//                        implicit superadmin of every store).
//
// The last two are BOTH "the person at the back office", which is why
// `isPosOwnerRole` exists for the questions that only care about that (device
// authorization, the idle lock). They differ for exactly one thing: giving
// money away. See SUPERADMIN_ONLY.

export type PosRole = "cashier" | "manager";
export type PosActorRole = PosRole | "owner" | "superadmin";

export type PosCapability =
  | "sell"
  /** Give ANY discount — an order discount or a per-line markdown. */
  | "discount"
  /** Change a line's price during a sale — a discount by another name, and
   *  held to the same standard for that reason. */
  | "price_override"
  /** Exceed `pos.maxDiscountPercent`, or override a price, without a manager's
   *  PIN. Only consulted when a merchant has turned `pos.ownerOnlyDiscounts`
   *  OFF — under the default nobody but the superadmin gives money away at all,
   *  so there is no cap to exceed. Held by manager and above: it is exactly the
   *  old `role !== "cashier"` check, named. */
  | "discount_over_cap"
  | "refund"
  | "adjust_inventory"
  | "open_close_shift"
  | "cash_drop"
  | "manage_staff"
  /** GRANT a browser the right to take money on this store's behalf — "Authorize
   *  this device", and the pairing codes that do it remotely. Revoking is a
   *  different question; see `revokeDevice`. */
  | "authorize_device"
  /** Arrange which products appear on the register grid, and in what order. */
  | "edit_layout"
  /** Mark a collection order packed and ready. Manager and above: it is the
   *  step that tells a customer to travel, and it should be someone who has
   *  actually seen the box. Handing it over stays `sell` — that is a cashier's
   *  job with the customer standing there. */
  | "fulfil_pickup";

/**
 * ★ Reserved to the superadmin: not a cashier, not a manager, and **not a
 * delegated dashboard admin** either. Two kinds of act qualify.
 *
 * 1. Handing money to a customer with NOTHING missing from the shelf to count
 *    afterwards — the one class of till action that leaves no physical trace.
 *    `price_override` sits with `discount` deliberately: marking a ₹200 tin down
 *    to ₹1 is the same act as discounting it by ₹199, so leaving overrides with
 *    managers would have made the discount rule decorative.
 * 2. Handing out the ability to do (1) — `authorize_device`. A device grant is
 *    permanent until revoked and is what lets staff sell at all, so it belongs
 *    with the person whose money is at stake rather than with anyone who has
 *    been given a dashboard login.
 */
const SUPERADMIN_ONLY: readonly PosCapability[] = [
  "discount",
  "price_override",
  "authorize_device",
];

// NOTE the absence of every SUPERADMIN_ONLY capability from BOTH staff roles —
// that omission IS the grant, so a role added here later can't inherit them by
// resembling a manager.
const CAPS: Record<PosRole, PosCapability[]> = {
  cashier: ["sell"],
  manager: [
    "sell",
    "discount_over_cap",
    "refund",
    "adjust_inventory",
    "open_close_shift",
    "cash_drop",
    "edit_layout",
    "fulfil_pickup",
  ],
};

/** Can this POS actor perform `cap`? */
export function posCan(role: PosActorRole, cap: PosCapability): boolean {
  if (role === "superadmin") return true;
  // A delegated dashboard admin runs the till with everything EXCEPT the
  // money-losing capabilities.
  if (role === "owner") return !SUPERADMIN_ONLY.includes(cap);
  return CAPS[role]?.includes(cap) ?? false;
}

/**
 * Exempt from the register's idle auto-lock (`app/pos/idle-lock.tsx`).
 *
 * Not a capability, because it isn't something you may DO — it is a statement
 * about whose screen can be left unattended. ONLY the superadmin: a delegated
 * admin standing at a shared counter is the same
 * walked-away-from-an-open-till risk as any operator, and their session can
 * reach more than a cashier's. It is also not an authorization boundary either
 * way (see idle-lock.tsx) — the boundary is the device gate plus the
 * per-request `pos_staff` re-validation.
 */
export function isIdleLockExempt(role: PosActorRole): boolean {
  return role === "superadmin";
}

export function isPosRole(v: unknown): v is PosRole {
  return v === "cashier" || v === "manager";
}
