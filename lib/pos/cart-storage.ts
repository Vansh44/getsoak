// ---------------------------------------------------------------------------
// Surviving a refresh — the in-progress register cart, kept in the tab.
//
// A cashier who reloads /pos/sell (an F5, a stray gesture on a kiosk, a
// hot-reload in dev, the browser reclaiming a backgrounded tab) used to lose
// the basket they had already scanned and had to ring it up again with the
// customer standing there. `cart` was plain component state and nothing wrote
// it anywhere.
//
// ★★ THIS IS NOT A SECOND "HOLD". Parking a sale (lib/pos/park.ts) is the
// DELIBERATE, DURABLE hold: it is a server row, so it survives the idle lock
// and can be resumed from a different till by a colleague. This is a crash mat
// for the sale in front of you — same tab, same operator session, no server
// round trip. Do not "upgrade" it into the other one; see the storage note
// below for why the difference is load-bearing.
//
// ★ sessionStorage, NOT localStorage. Deliberate, and the reason is the
// counter, not tidiness:
//   • PER TAB. localStorage is shared, so two register tabs on one till would
//     write one key and a refresh could hand a cashier the OTHER tab's basket.
//     A wrong basket at a counter is a money error, and it would look exactly
//     like a correct one.
//   • DIES WITH THE TAB, so there is no basket from last Tuesday to resurrect
//     and no "is this mine?" question on a shared kiosk.
// It survives a reload, a client navigation away and back, and the lock/unlock
// round trip — which is the whole of what was reported.
//
// ★ CHOICES, NEVER PRICES — park.ts's rule, and for park.ts's reason. A stored
// price would let a restored basket quote yesterday's; the catalogue re-prices
// every line on the way back in (cart-line.ts), and `placePosSale` re-reads
// again at completion, so nothing here is ever the basis for a charge.
//
// ★ NO CUSTOMER, NO RECEIPT ADDRESS. Both are resolved at Charge in one server
// read, so re-entering the mobile is one tap — not worth leaving a shopper's
// name, phone, email and credit balance sitting in browser storage for the
// convenience. Products are what was reported lost, and products are what this
// keeps.
// ---------------------------------------------------------------------------

import { cartLineFrom, type CartLine } from "./cart-line";
import type { CatalogItem } from "./catalog-index";

/** Bumped when the stored shape changes, so an older payload is dropped rather
 *  than half-read — the SCHEMA_VERSION rule the catalogue cache follows. */
export const POS_CART_SCHEMA_VERSION = 1;

const KEY_PREFIX = `sm-pos-cart-v${POS_CART_SCHEMA_VERSION}:`;

/**
 * How stale a stored basket may be before it is ignored.
 *
 * ★ A TAB ON A KIOSK LIVES FOR WEEKS, so "dies with the tab" is not by itself a
 * freshness guarantee. Twelve hours covers the longest realistic trading day —
 * including a lunch break and a lock/unlock — and guarantees the next morning
 * opens on an empty till rather than yesterday's abandoned basket.
 */
export const POS_CART_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** The register caps a sale at 200 lines; a stored basket cannot exceed it. */
const MAX_STORED_LINES = 200;

/** One stored line: what the cashier CHOSE, and nothing the catalogue owns. */
export interface StoredCartChoice {
  productId: string;
  variantId: string | null;
  quantity: number;
  lineDiscount?: number;
}

export interface StoredPosCart {
  v: number;
  /** Epoch ms, for POS_CART_MAX_AGE_MS. */
  savedAt: number;
  /**
   * The return this basket is settling, or null for an ordinary sale.
   *
   * ★★ AN EXCHANGE BASKET MUST NOT COME BACK AS A PLAIN SALE. A counter
   * exchange is a replacement priced against a specific completed return
   * (CODEBASE.md §28) with the original customer attached and locked. The
   * context is re-supplied by the server from `?exchange=…` on refresh, so
   * restoring the lines into a DIFFERENT context — or into no context at all,
   * once that param is gone — would tender the replacement as an unrelated
   * sale. Stored, compared, and the basket discarded when it does not match.
   */
  exchangeReturnId: string | null;
  /** Rupees off the whole sale. Re-derived and capped server-side. */
  discount: number;
  /** The buyer's GSTIN as typed: it prints on the invoice and is a nuisance to
   *  retype, and it identifies a business rather than a person. */
  gstin: string;
  lines: StoredCartChoice[];
}

/** One key per register — stock is per location and a browser can be shared
 *  between stores, the same scoping the catalogue cache uses. */
export function posCartKey(storeId: string, locationId: string): string {
  return `${KEY_PREFIX}${storeId}:${locationId}`;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Read a stored basket back, or decide there isn't a usable one.
 *
 * PURE, so every rejection is directly testable. It returns null — never a
 * partially-trusted object — for bad JSON, a stale schema, an expired basket,
 * an exchange mismatch, or a payload with no valid line left. A caller that
 * gets null must leave the cart exactly as it found it.
 */
export function parseStoredPosCart(
  raw: string | null,
  context: { now: number; exchangeReturnId: string | null },
): StoredPosCart | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<StoredPosCart>;

  if (value.v !== POS_CART_SCHEMA_VERSION) return null;

  const savedAt = Number(value.savedAt);
  if (!Number.isFinite(savedAt)) return null;
  // A clock that has gone BACKWARDS since the write (a kiosk syncing NTP, a
  // manually corrected date) must not read as fresh-forever either.
  const age = context.now - savedAt;
  if (age < 0 || age > POS_CART_MAX_AGE_MS) return null;

  const storedExchange =
    typeof value.exchangeReturnId === "string" && value.exchangeReturnId
      ? value.exchangeReturnId
      : null;
  if (storedExchange !== context.exchangeReturnId) return null;

  const rawLines = Array.isArray(value.lines) ? value.lines : [];
  if (rawLines.length === 0 || rawLines.length > MAX_STORED_LINES) return null;

  const lines: StoredCartChoice[] = [];
  for (const line of rawLines) {
    const productId = String(line?.productId ?? "").trim();
    const quantity = positiveInt(line?.quantity);
    if (!productId || quantity === null) return null;
    const lineDiscount = Number(line?.lineDiscount);
    lines.push({
      productId,
      variantId: line?.variantId ? String(line.variantId) : null,
      quantity,
      ...(Number.isFinite(lineDiscount) && lineDiscount > 0
        ? { lineDiscount }
        : {}),
    });
  }

  const discount = Number(value.discount);
  return {
    v: POS_CART_SCHEMA_VERSION,
    savedAt,
    exchangeReturnId: storedExchange,
    discount: Number.isFinite(discount) && discount > 0 ? discount : 0,
    gstin: typeof value.gstin === "string" ? value.gstin.slice(0, 20) : "",
    lines,
  };
}

/** The payload for a live cart — choices only. */
export function serializePosCart(input: {
  lines: readonly Pick<
    CartLine,
    "productId" | "variantId" | "quantity" | "lineDiscount"
  >[];
  discount: number;
  gstin: string;
  exchangeReturnId: string | null;
  now: number;
}): StoredPosCart {
  return {
    v: POS_CART_SCHEMA_VERSION,
    savedAt: input.now,
    exchangeReturnId: input.exchangeReturnId,
    discount: input.discount > 0 ? input.discount : 0,
    gstin: input.gstin.trim().slice(0, 20),
    lines: input.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      quantity: l.quantity,
      ...(l.lineDiscount > 0 ? { lineDiscount: l.lineDiscount } : {}),
    })),
  };
}

/**
 * Rebuild live cart lines from stored choices, re-priced by the catalogue.
 *
 * ★ QUANTITIES ARE NOT SILENTLY CLAMPED to what is now on the shelf, matching
 * the parked-sale resume: shrinking a basket without saying so is how a
 * customer is charged for less than they picked up. `placePosSale` reserves
 * atomically and reports the exact shortfall, so the authority stays there.
 *
 * ★ AN UNRESOLVABLE LINE IS DROPPED AND COUNTED, never carried with a stored
 * price. A line the catalogue cannot price would make the screen quote a total
 * the server will not charge.
 */
export function restoreCartLines(
  stored: StoredPosCart,
  resolve: (productId: string, variantId: string | null) => CatalogItem | null,
): { lines: CartLine[]; dropped: number } {
  const lines: CartLine[] = [];
  for (const choice of stored.lines) {
    const item = resolve(choice.productId, choice.variantId);
    if (!item) continue;
    lines.push(
      cartLineFrom(item, {
        quantity: choice.quantity,
        lineDiscount: choice.lineDiscount,
      }),
    );
  }
  return { lines, dropped: stored.lines.length - lines.length };
}

// --- storage wrappers ------------------------------------------------------
// ★ EVERY ONE DEGRADES TO A NO-OP. sessionStorage throws outright in some
// contexts (Safari private mode, a kiosk profile with site data blocked, a
// quota-exceeded write), and the register must open and sell regardless — the
// rule catalog-store.ts already follows for IndexedDB. Losing the safety net is
// a worse refresh; losing the till is a closed shop.

function session(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPosCartRaw(
  storeId: string,
  locationId: string,
): string | null {
  try {
    return session()?.getItem(posCartKey(storeId, locationId)) ?? null;
  } catch {
    return null;
  }
}

export function writePosCart(
  storeId: string,
  locationId: string,
  payload: StoredPosCart,
): void {
  try {
    session()?.setItem(
      posCartKey(storeId, locationId),
      JSON.stringify(payload),
    );
  } catch {
    // Full or blocked: the sale in progress is unaffected.
  }
}

export function clearPosCart(storeId: string, locationId: string): void {
  try {
    session()?.removeItem(posCartKey(storeId, locationId));
  } catch {
    // Nothing to do — a basket that cannot be removed also cannot be read.
  }
}

/**
 * Drop every stored basket in this tab, whatever register it belonged to.
 *
 * ★★ CALLED FROM THE LOGIN SCREEN, WHICH IS THE ONE PLACE EVERY SIGNED-OUT
 * PATH LANDS — the idle lock, the manual Lock button, an expired operator
 * cookie, a cashier deactivated mid-shift. Hooking the two `posLock()` call
 * sites instead would be the per-page opt-in that left the idle lock off five
 * of seven POS screens (CODEBASE.md §22); a third lock path would forget it.
 *
 * Reaching the login screen means no operator session is active, so the basket
 * must not be waiting for whoever signs in next: it is not their sale, and
 * ringing it up would attribute it to them. The cost is that a cashier who
 * locks the till mid-sale comes back to an empty cart — which is precisely
 * what Hold is for, and the sign-out copy is where to say so.
 *
 * It cannot use posCartKey: the login screen knows no location, and a device
 * can be re-paired to another one.
 */
export function clearAllPosCarts(): void {
  try {
    const store = session();
    if (!store) return;
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(KEY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Same reasoning as the single-key clear.
  }
}
