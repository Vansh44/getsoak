// POS role capabilities (docs/pos-plan.md §3.3). POS roles are a SEPARATE model
// from dashboard `roles` — they live on pos_staff.role. The store owner/admin
// operating /pos with their Firebase session is the pseudo-role "owner" (all
// capabilities, all locations). Pure module — enforce these SERVER-SIDE in the
// POS actions, never from a client flag.

export type PosRole = "cashier" | "manager";
export type PosActorRole = PosRole | "owner";

export type PosCapability =
  | "sell"
  | "discount_over_cap"
  | "price_override"
  | "refund"
  | "adjust_inventory"
  | "open_close_shift"
  | "cash_drop"
  | "manage_staff";

const CAPS: Record<PosRole, PosCapability[]> = {
  cashier: ["sell"],
  manager: [
    "sell",
    "discount_over_cap",
    "price_override",
    "refund",
    "adjust_inventory",
    "open_close_shift",
    "cash_drop",
  ],
};

/** Can this POS actor perform `cap`? Owners (dashboard admins on /pos) always can. */
export function posCan(role: PosActorRole, cap: PosCapability): boolean {
  if (role === "owner") return true;
  return CAPS[role]?.includes(cap) ?? false;
}

export function isPosRole(v: unknown): v is PosRole {
  return v === "cashier" || v === "manager";
}
