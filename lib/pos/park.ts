// ---------------------------------------------------------------------------
// Parking a sale — the rules, PURE.
//
// Lives in lib/ rather than beside the action for the usual reason: a
// `"use server"` file may only export async functions, and everything it
// exports is a publicly reachable endpoint. A cap and a validator are neither.
// ---------------------------------------------------------------------------

/**
 * How many carts one counter may hold at once.
 *
 * ★ A CEILING, NOT A PREFERENCE. Without one, a stuck button — or a cashier
 * parking instead of voiding — fills the list until it is useless for finding
 * the one cart that matters, which is the only thing the list is for. Twenty is
 * far more than a real counter juggles and still small enough to scan.
 */
export const MAX_PARKED_SALES = 20;

/** Guards against a paste, not a person: nobody labels a cart with an essay. */
export const MAX_LABEL_LENGTH = 60;

/** The same ceiling `placePosSale` applies, so a park can never hold a cart
 *  that could not be rung up. */
export const MAX_PARKED_LINES = 200;

export interface ParkedLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Rupees off THIS line. Re-derived and capped server-side at completion —
   *  stored only so a resumed cart looks like the one that was parked. */
  lineDiscount?: number;
}

export type ParkValidation =
  | {
      ok: true;
      label: string | null;
      lines: ParkedLine[];
      orderDiscount: number;
      customerId: string | null;
      customerGstin: string | null;
      note: string | null;
    }
  | { ok: false; error: string };

/**
 * Is this cart parkable, and in what shape does it get stored?
 *
 * ★ IT VALIDATES SHAPE, NOT MONEY. Prices are deliberately absent and
 * quantities are only checked for being whole and positive — the authority on
 * what a cart costs is `placePosSale` at completion, which re-reads everything.
 * Validating a price here would imply this one mattered.
 */
export function validateParkInput(input: {
  label?: string | null;
  lines: ParkedLine[];
  orderDiscount?: number;
  customerId?: string | null;
  customerGstin?: string | null;
  note?: string | null;
}): ParkValidation {
  const raw = Array.isArray(input.lines) ? input.lines : [];
  if (raw.length === 0) {
    // Nothing to come back to. Parking an empty cart would leave a row that
    // resumes into the state the cashier is already in.
    return { ok: false, error: "Add something to the sale before holding it." };
  }
  if (raw.length > MAX_PARKED_LINES) {
    return { ok: false, error: "That sale has too many lines to hold." };
  }

  const lines: ParkedLine[] = [];
  for (const l of raw) {
    const productId = String(l?.productId ?? "").trim();
    const quantity = Number(l?.quantity);
    if (!productId)
      return { ok: false, error: "A line is missing its product." };
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return {
        ok: false,
        error: "Every line needs a whole, positive quantity.",
      };
    }
    const lineDiscount = Number(l?.lineDiscount);
    lines.push({
      productId,
      variantId: l?.variantId ? String(l.variantId) : null,
      quantity,
      ...(Number.isFinite(lineDiscount) && lineDiscount > 0
        ? { lineDiscount }
        : {}),
    });
  }

  const orderDiscount = Number(input.orderDiscount);
  const gstin = (input.customerGstin ?? "").trim().toUpperCase();

  return {
    ok: true,
    label: (input.label ?? "").trim().slice(0, MAX_LABEL_LENGTH) || null,
    lines,
    orderDiscount:
      Number.isFinite(orderDiscount) && orderDiscount > 0 ? orderDiscount : 0,
    customerId: (input.customerId ?? "").trim() || null,
    customerGstin: gstin || null,
    note: (input.note ?? "").trim().slice(0, 500) || null,
  };
}

/**
 * What to call a held sale that the cashier didn't name.
 *
 * ★ NEVER "Untitled". At a counter the list is scanned under pressure, and the
 * useful discriminators are what it contains and when it was held — a row of
 * identical placeholders is the same as no list.
 */
export function parkedSaleLabel(sale: {
  label: string | null;
  items: number;
  parkedByName?: string | null;
}): string {
  if (sale.label) return sale.label;
  const items = `${sale.items} item${sale.items === 1 ? "" : "s"}`;
  return sale.parkedByName ? `${items} · ${sale.parkedByName}` : items;
}

/** "2 min ago" — a held cart's age is the thing that tells you it's stale. */
export function parkedAge(createdAt: string, now: Date = new Date()): string {
  const then = new Date(createdAt).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.floor((now.getTime() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
