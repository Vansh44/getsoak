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
import { toPaise, toRupees } from "@/lib/money/allocate";
import {
  applyOffers,
  type AppliedOffer,
  type OfferContext,
  type OfferLine,
  type OfferResult,
} from "./apply";
import {
  loadCustomerGroupIds,
  loadFirstOrderState,
  loadLiveOffers,
  loadOfferPolicy,
} from "./resolve";
import { getStoreSettings } from "@/lib/settings/resolve";
import type {
  Offer,
  OfferChannel,
  OfferFulfilmentType,
  OfferPaymentMethod,
} from "./types";

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

  // --- Phase E: what the extra conditions are judged against ---------------

  /** The payment method the shopper has CHOSEN, for a `payment_method`
   *  condition. Website only — see `isWebsiteOnlyCondition`. */
  paymentMethod?: OfferPaymentMethod | null;
  /** Delivery or collection, for a `fulfilment_type` condition. */
  fulfilmentType?: OfferFulfilmentType | null;
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
    const [policy, { offers, groupIds, isFirstOrder }] = await Promise.all([
      loadOfferPolicy(),
      withService(async (db) => ({
        offers: await loadLiveOffers(
          db,
          input.storeId,
          input.customerId ?? null,
        ),
        groupIds: await loadCustomerGroupIds(db, input.customerId ?? null),
        // ★ Resolved server-side from order history, never taken from the
        // caller: "is this your first order" is exactly the claim a client
        // would like to make about itself.
        isFirstOrder: await loadFirstOrderState(
          db,
          input.storeId,
          input.customerId ?? null,
        ),
      })),
    ]);

    // ★ ONE CONTEXT, BUILT ONCE. The two branches below differ only in whether
    // any offers were loaded; building the context twice is how one of them
    // ends up missing a condition input and silently ignoring a restriction.
    const context: OfferContext = {
      ...policy,
      channel: input.channel,
      locationId: input.locationId ?? null,
      customerId: input.customerId ?? null,
      groupIds,
      code: input.code ?? null,
      now: input.now ?? new Date(),
      paymentMethod: input.paymentMethod ?? null,
      fulfilmentType: input.fulfilmentType ?? null,
      isFirstOrder,
    };

    if (offers.length === 0) {
      // A store with no offers is the common case; returning a real (empty)
      // result rather than null keeps the caller on the offer path, so a
      // storefront can still say "no offer applied" rather than falling back.
      return applyOffers({ lines: input.lines, offers: [], context });
    }

    return applyOffers({ lines: input.lines, offers, context });
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

/**
 * The GIFT and CASHBACK an order earned, as reservable offers.
 *
 * ★★ THEY WERE NEVER RESERVED AND NEVER RECORDED. `applied` is built from the
 * per-line merchandise allocation, so a `free_item` or `credit_back` offer —
 * which allocates nothing to a line — was absent from it, and both counters
 * only ever reserved `applied`. Every cap was therefore decorative: "free
 * tumbler, limited to 100" gave away unlimited tumblers, and "₹100 cashback,
 * budget ₹5,000" issued unbounded store credit, which is a real liability. No
 * `offer_redemptions` row was written either, so `max_per_customer` could not
 * bind even in principle.
 *
 * ★ KEPT OUT OF `applied` ON PURPOSE. That array gates the legacy coupon
 * fallback in `placeOrder` (`applied.length > 0`), so folding a gift into it
 * would silently drop a shopper's coupon on any order that also won a gift.
 * These are separate axes, exactly as shipping is.
 *
 * ★ A GIFT IS CHARGED AT WHAT THE SHOPPER WOULD OTHERWISE HAVE PAID — the same
 * rule the shipping waiver uses for `offerWaivedAmount`. The engine is pure and
 * never prices a gift, so the caller resolves it from the product row and
 * passes it in; 0 means "unpriced", which still lets the redemption and
 * per-customer caps bind.
 */
export function bonusOffersToReserve(
  result: OfferResult,
  giftValuePaise = 0,
): AppliedOffer[] {
  const out: AppliedOffer[] = [];
  if (result.gift) {
    out.push({
      offerId: result.gift.offerId,
      offerName: result.gift.offerName,
      code: result.gift.code,
      rewardType: "free_item",
      level: "gift",
      amount: toRupees(Math.max(0, Math.trunc(giftValuePaise))),
    });
  }
  if (result.credit && result.credit.amount > 0) {
    out.push({
      offerId: result.credit.offerId,
      offerName: result.credit.offerName,
      code: result.credit.code,
      rewardType: "credit_back",
      level: "credit",
      // Cashback's cost to the merchant is exactly the credit issued, so a
      // budget cap on it binds precisely.
      amount: result.credit.amount,
    });
  }
  return out;
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
  /**
   * Exactly what `reserveOfferUses` claimed for this order — merchandise, plus
   * the gift, cashback and shipping waiver.
   *
   * ★★ PASSED IN RATHER THAN RE-DERIVED, so the ledger and the caps cannot
   * describe different sets. Reading `result.applied` here is what left every
   * gift, cashback and free-shipping redemption unrecorded while its
   * `redemption_count` had already moved — and `max_per_customer` is counted
   * from THIS table, so a cap the merchant set could never bind.
   */
  redeemed: readonly AppliedOffer[];
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
  const { result, redeemed } = input;
  if (result.allocations.length === 0 && redeemed.length === 0) return;

  try {
    await withService(async (db) => {
      if (redeemed.length > 0) {
        await db
          .insert(offerRedemptions)
          .values(
            redeemed.map((a) => ({
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
              redeemed.find((x) => x.offerId === a.offerId)?.rewardType ??
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
export async function loadOffersForRegister(
  storeId: string,
  /** A register opens anonymous, so this is null there. The storefront loader
   *  below passes a real customer, which lets per-customer caps resolve up
   *  front rather than only at the atomic reservation. */
  customerId: string | null = null,
): Promise<{
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
      withService((db) => loadLiveOffers(db, storeId, customerId)),
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

/**
 * The offers a STOREFRONT client may price with, plus the policy.
 *
 * ★ AUTOMATIC OFFERS ONLY. A code-delivery offer is deliberately withheld: the
 * storefront never needs to READ a code — it validates one the shopper typed,
 * server-side — and shipping the list would publish every active discount code
 * to anyone who opened the network tab. The column grant on `offers` seals
 * `code` from the API for the same reason; this is the second half of that
 * decision, for the path that legitimately bypasses RLS.
 *
 * ★ AND ONLY OFFERS THIS VIEWER COULD ACTUALLY GET. A group-restricted offer
 * is filtered out here rather than left for the client engine to decline,
 * because the restriction is the point: its existence, name and terms are
 * merchant targeting, not public information.
 */
export async function loadOffersForStorefront(
  storeId: string,
  customerId: string | null,
  groupIds: readonly string[],
): Promise<{
  offers: Offer[];
  showNearMiss: boolean;
  policy: Pick<
    OfferContext,
    "onSalePrice" | "maxTotalDiscountPercent" | "autoApply" | "timeZone"
  >;
  /**
   * Facts about THIS viewer, resolved server-side so the cart's preview can
   * reach the same answer the charge will.
   *
   * ★★ WITHOUT THIS THE PREVIEW SILENTLY UNDER-PROMISES. The client cannot
   * derive any of it — `groupIds` needs a membership read, `isFirstOrder`
   * needs order history — so a cart that omitted them would price every
   * group-restricted and first-order offer as NOT APPLYING, then have
   * `placeOrder` apply it: the total drops at the last step, and the offer the
   * shopper was promised looks broken right up until they commit.
   * (Group-restricted offers had exactly that gap before Phase E: the bundle
   * filtered them to the ones the viewer qualifies for, and the client then
   * re-rejected them by passing an empty group list.)
   *
   * ★ NOT A LEAK. These are facts about the viewer themselves, and the offers
   * shipped alongside have already been filtered by them.
   */
  viewer: {
    groupIds: string[];
    isFirstOrder: boolean | null;
  };
}> {
  // ★ CONCURRENT, NOT SEQUENTIAL. `withService` takes its own pool client per
  // call, so separate calls genuinely overlap — while statements INSIDE one
  // transaction share a client and run serially (CODEBASE §22, Step 20). Three
  // independent reads awaited in turn is ~140ms at Mumbai's ~46ms RTT, paid on
  // every cart hydration, for nothing.
  const [bundle, isFirstOrder, settings] = await Promise.all([
    loadOffersForRegister(storeId, customerId),
    withService((db) => loadFirstOrderState(db, storeId, customerId)).catch(
      // Fails to "not first", the closed direction: a blip must not hand the
      // new-customer discount to every returning customer at once.
      () => false,
    ),
    getStoreSettings().catch(() => null),
  ]);
  // The nudge switch is RESOLVED here and travels with the bundle, so the
  // client is told the answer rather than reading the setting itself — the
  // rule the register follows for `canDiscount`.
  //
  // ⚠ It does not WITHHOLD anything, and it is not a security boundary. The
  // offers still ship, because the cart needs them to price the discount it
  // displays; the flag only decides whether a near-miss line is rendered.
  // Nothing here is secret — these are the automatic offers any visitor would
  // receive, with codes and group-restricted offers already filtered out
  // above, which IS the boundary.
  const showNearMiss = settings?.["offers.showNearMiss"] !== false;

  return {
    ...bundle,
    showNearMiss,
    viewer: { groupIds: [...groupIds], isFirstOrder },
    offers: bundle.offers
      .filter((o) => o.delivery === "automatic")
      .filter(
        (o) =>
          o.groupIds.length === 0 ||
          o.groupIds.some((g) => groupIds.includes(g)),
      )
      // Never ship a code even for an automatic offer, which has none — belt
      // and braces, so a later `link` offer joining this list cannot leak one.
      .map((o) => ({ ...o, code: null })),
  };
}
