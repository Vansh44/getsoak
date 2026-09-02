// ---------------------------------------------------------------------------
// Offers on a real cart — the boundary between the pure engine and a sale.
// Server-only. `docs/offers-plan.md` §8, §11.
//
// ★ EVERY READ HERE FAILS OPEN, and that is a deploy decision rather than
// timidity. Database DDL is a separate release gate from the application
// deploy, so this code reaches production before 20260902_0059 does — and a
// throw in that window would take down every checkout and every till in the
// business. `isSchemaNotReady` distinguishes "the migration has not run" from
// a genuine outage, and either way a sale completes at full price rather than
// failing. Invariant 6: never refuse a sale over an optional feature.
//
// The consequence to keep in mind: `resolveOffersForCart` returning null means
// "offers are unavailable", NOT "no offer applied". Callers must fall back to
// the legacy coupon path on null, or a migrated coupon stops working in the
// window between the two deploys.
// ---------------------------------------------------------------------------

import "server-only";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { isSchemaNotReady, dbErrorMessage } from "@/lib/db/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { offerRedemptions, orderItemOffers } from "@/drizzle/schema";
import { toPaise } from "@/lib/money/allocate";
import {
  applyOffers,
  type AppliedOffer,
  type OfferContext,
  type OfferLine,
  type OfferResult,
} from "./apply";
import {
  loadCustomerGroupIds,
  loadLiveOffers,
  loadOfferPolicy,
} from "./resolve";
import type { Offer, OfferChannel } from "./types";

export interface ResolveOffersInput {
  storeId: string;
  lines: readonly OfferLine[];
  channel: OfferChannel;
  locationId?: string | null;
  customerId?: string | null;
  /** The code the shopper or cashier entered. */
  code?: string | null;
  /** Injected so a caller can price a cart "as of" a moment — the historical
   *  replay in the offer editor needs exactly this. */
  now?: Date;
}

/**
 * Price a cart against the store's live offers.
 *
 * Returns `null` when offers cannot be resolved at all — see the header. A
 * resolved result with `discount: 0` is a different thing entirely: it means
 * the engine ran and nothing qualified.
 */
export async function resolveOffersForCart(
  input: ResolveOffersInput,
): Promise<OfferResult | null> {
  if (input.lines.length === 0) return null;
  try {
    const [policy, { offers, groupIds }] = await Promise.all([
      loadOfferPolicy(),
      withService(async (db) => ({
        offers: await loadLiveOffers(
          db,
          input.storeId,
          input.customerId ?? null,
        ),
        groupIds: await loadCustomerGroupIds(db, input.customerId ?? null),
      })),
    ]);

    if (offers.length === 0) {
      // A store with no offers is the common case; returning a real (empty)
      // result rather than null keeps the caller on the offer path, so a
      // storefront can still say "no offer applied" rather than falling back.
      return applyOffers({
        lines: input.lines,
        offers: [],
        context: {
          ...policy,
          channel: input.channel,
          locationId: input.locationId ?? null,
          customerId: input.customerId ?? null,
          groupIds,
          code: input.code ?? null,
          now: input.now ?? new Date(),
        },
      });
    }

    return applyOffers({
      lines: input.lines,
      offers,
      context: {
        ...policy,
        channel: input.channel,
        locationId: input.locationId ?? null,
        customerId: input.customerId ?? null,
        groupIds,
        code: input.code ?? null,
        now: input.now ?? new Date(),
      },
    });
  } catch (err) {
    if (isSchemaNotReady(err)) {
      // Expected between the application deploy and the migration. Warn, not
      // error: this is a known window, and paging on it teaches people to
      // ignore the log.
      logWarn("offers unavailable — migration not applied", {
        storeId: input.storeId,
      });
    } else {
      logError("resolveOffersForCart failed", {
        storeId: input.storeId,
        error: dbErrorMessage(err, "unknown"),
      });
    }
    return null;
  }
}

export interface ReservedOffer {
  offerId: string;
  amountPaise: number;
}

export interface ReserveOutcome {
  ok: boolean;
  /** Shown to the shopper when a cap was reached mid-checkout. */
  error?: string;
  reserved: ReservedOffer[];
}

/**
 * Claim every applied offer's caps, atomically, BEFORE the order exists.
 *
 * ★ THE CAP IS CLAIMED, NOT CHECKED. `reserve_offer_use` puts the redemption
 * cap, the budget cap and the per-customer cap all inside one conditional
 * UPDATE, so two simultaneous checkouts cannot both take the last redemption
 * or both spend the last of the budget. A read-then-write here would make
 * every limit approximate under exactly the load that makes limits matter.
 *
 * ★ A REFUSAL IS REPORTED; A TRANSIENT ERROR FAILS OPEN. Hitting a cap is a
 * real answer the shopper must be told ("this offer has just run out"). An
 * unreachable database is not a reason to refuse a paying customer, and the
 * engine has already validated the offer — so the sale proceeds at the priced
 * total, which is the same trade `increment_coupon_usage` already makes.
 *
 * Partial success is unwound by the caller through `releaseOfferUses`, so a
 * second offer failing cannot leave the first one's budget spent.
 */
export async function reserveOfferUses(
  storeId: string,
  applied: readonly AppliedOffer[],
  customerId: string | null,
): Promise<ReserveOutcome> {
  const reserved: ReservedOffer[] = [];
  for (const offer of applied) {
    const amountPaise = toPaise(offer.amount);
    try {
      const res = await withService((db) =>
        db.execute(
          sql`select reserve_offer_use(
                p_offer_id => ${offer.offerId}::uuid,
                p_store_id => ${storeId}::uuid,
                p_customer_id => ${customerId},
                p_amount_paise => ${amountPaise}::bigint
              ) as reserved`,
        ),
      );
      const ok = (res.rows[0] as { reserved: boolean | null } | undefined)
        ?.reserved;
      if (ok === false) {
        return {
          ok: false,
          error: `“${offer.offerName}” has just reached its limit. Refresh your cart to see the current price.`,
          reserved,
        };
      }
      reserved.push({ offerId: offer.offerId, amountPaise });
    } catch (err) {
      if (isSchemaNotReady(err)) {
        logWarn("offer reservation skipped — migration not applied", {
          storeId,
        });
      } else {
        logError("reserve_offer_use failed", {
          storeId,
          offerId: offer.offerId,
          error: dbErrorMessage(err, "unknown"),
        });
      }
      // Fails OPEN, deliberately — see the docblock.
    }
  }
  return { ok: true, reserved };
}

/** Give back everything `reserveOfferUses` took. Best-effort: a failed release
 *  overstates an offer's spend, which is safe in the direction that matters. */
export async function releaseOfferUses(
  storeId: string,
  reserved: readonly ReservedOffer[],
): Promise<void> {
  for (const r of reserved) {
    await withService((db) =>
      db.execute(
        sql`select release_offer_use(
              p_offer_id => ${r.offerId}::uuid,
              p_store_id => ${storeId}::uuid,
              p_amount_paise => ${r.amountPaise}::bigint
            )`,
      ),
    ).catch((err) => {
      if (!isSchemaNotReady(err)) {
        logError("release_offer_use failed", {
          storeId,
          offerId: r.offerId,
          error: dbErrorMessage(err, "unknown"),
        });
      }
    });
  }
}

export interface RecordOffersInput {
  storeId: string;
  orderId: string;
  customerId: string | null;
  result: OfferResult;
  /** Maps the engine's line id to the persisted `order_items.id`. */
  orderItemIdByLine: ReadonlyMap<string, string>;
}

/**
 * Persist what each line received and who redeemed what.
 *
 * ★ IDEMPOTENT ON (offer, order) AND (order_item, offer). A retried checkout
 * must not double-count a redemption or double-report a line's discount, and
 * both unique indexes make that structural rather than a caller's
 * responsibility.
 *
 * ★ NEVER THROWS INTO THE SALE. This runs after the order, its items, the
 * stock reserve and the payment are all committed. Losing the per-line offer
 * record is a reporting gap; failing the sale here would take money and then
 * tell the customer it did not work.
 */
export async function recordOfferRedemptions(
  input: RecordOffersInput,
): Promise<void> {
  const { result } = input;
  if (result.allocations.length === 0 && result.applied.length === 0) return;

  try {
    await withService(async (db) => {
      if (result.applied.length > 0) {
        await db
          .insert(offerRedemptions)
          .values(
            result.applied.map((a) => ({
              offerId: a.offerId,
              storeId: input.storeId,
              orderId: input.orderId,
              customerId: input.customerId,
              amountPaise: toPaise(a.amount),
            })),
          )
          .onConflictDoNothing();
      }

      const rows = result.allocations
        .map((a) => {
          const orderItemId = input.orderItemIdByLine.get(a.lineId);
          if (!orderItemId) return null;
          return {
            orderItemId,
            orderId: input.orderId,
            storeId: input.storeId,
            offerId: a.offerId,
            // Snapshotted — a rename or delete must not change what an issued
            // invoice says.
            offerName: a.offerName,
            rewardType:
              result.applied.find((x) => x.offerId === a.offerId)?.rewardType ??
              "percent_off",
            amount: a.amount,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (rows.length > 0) {
        await db.insert(orderItemOffers).values(rows).onConflictDoNothing();
      }
    });
  } catch (err) {
    if (!isSchemaNotReady(err)) {
      logError("recordOfferRedemptions failed", {
        storeId: input.storeId,
        orderId: input.orderId,
        error: dbErrorMessage(err, "unknown"),
      });
    }
  }
}

/**
 * The offers and policy a REGISTER needs to quote with, shipped to the client.
 *
 * ★ THE TILL MUST QUOTE WHAT THE SERVER WILL CHARGE, and the register's whole
 * design goal is that it opens and prices without waiting on the network. So
 * offers ride in `RegisterConfig` and the sell screen runs the SAME pure engine
 * — exactly how `taxRates` already works, and for the same reason.
 *
 * ★ IN THE CONFIG, NEVER THE CACHED CATALOGUE. The catalogue persists in
 * IndexedDB, so an offer that ended (or a budget that ran out) would keep being
 * quoted to customers until the next background sync. The config is re-read
 * when the register opens.
 *
 * ⚠ No customer is attached when a register opens, so per-customer caps cannot
 * be resolved here. `resolvePosCustomerByPhone` returns the ids this customer
 * has used up, and the screen re-prices once they are identified;
 * `reserve_offer_use` is the atomic backstop either way.
 */
export async function loadOffersForRegister(storeId: string): Promise<{
  offers: Offer[];
  policy: Pick<
    OfferContext,
    "onSalePrice" | "maxTotalDiscountPercent" | "autoApply"
  >;
}> {
  const fallback = {
    offers: [] as Offer[],
    policy: {
      onSalePrice: "best" as const,
      maxTotalDiscountPercent: 50,
      autoApply: false,
    },
  };
  try {
    const [policy, offers] = await Promise.all([
      loadOfferPolicy(),
      withService((db) => loadLiveOffers(db, storeId, null)),
    ]);
    return { offers, policy };
  } catch (err) {
    if (isSchemaNotReady(err)) {
      logWarn("register offers unavailable — migration not applied", {
        storeId,
      });
    } else {
      logError("loadOffersForRegister failed", {
        storeId,
        error: dbErrorMessage(err, "unknown"),
      });
    }
    // ★ FAILS OPEN TO NO OFFERS. A register that cannot open is a shop that
    // cannot trade; a register with no offers is a shop selling at full price.
    return fallback;
  }
}

/** Offers this customer has already used up, so the till can re-price the
 *  moment they are identified rather than discovering it at completion. */
export async function loadExhaustedOfferIds(
  storeId: string,
  customerId: string,
): Promise<string[]> {
  try {
    const offersForCustomer = await withService((db) =>
      loadLiveOffers(db, storeId, customerId),
    );
    return offersForCustomer.filter((o) => o.exhausted).map((o) => o.id);
  } catch {
    // Silent: the atomic reservation still refuses at completion, and a
    // failure here must never block attaching a customer to a sale.
    return [];
  }
}
