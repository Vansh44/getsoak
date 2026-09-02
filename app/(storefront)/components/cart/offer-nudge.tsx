"use client";

// ---------------------------------------------------------------------------
// "You're ₹200 away from free delivery" — `docs/offers-plan.md` §14b.
//
// ★ THE GAP COMES FROM THE ENGINE, NEVER COMPUTED HERE. This is a claim about
// what happens if the shopper adds something, and only the engine knows the
// answer: under best-offer-wins, whether an offer would actually apply depends
// on what it is competing with. A component that computed
// `threshold − subtotal` itself would promise an offer the engine then declines
// because another one scored higher — on precisely the carts where a shopper is
// paying attention.
//
// ★ AND THE SERVER DECIDES WHAT IS NUDGEABLE. A code-delivery or
// group-restricted offer is filtered out in `collectNearMiss`, because nudging
// "₹200 from 20% off with WHOLESALE20" leaks a targeted code to every visitor
// and defeats the restriction that was deliberately set. This component renders
// what it is given; it must never widen that.
// ---------------------------------------------------------------------------

import type { NearMissOffer } from "@/lib/offers/apply";

const inr = (n: number) =>
  `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** What the shopper would get. Deliberately not the offer's internal name,
 *  which is the merchant's reference ("Launch week Q3") and means nothing to a
 *  customer. */
function rewardPhrase(offer: NearMissOffer): string {
  if (offer.rewardType === "amount_off" && offer.amount) {
    return `${inr(offer.amount)} off`;
  }
  if (offer.percent) return `${offer.percent}% off`;
  return "a discount";
}

export function OfferNudge({
  nearMiss,
  className = "",
}: {
  nearMiss: readonly NearMissOffer[] | null | undefined;
  className?: string;
}) {
  // ★ ONE NUDGE, THE CLOSEST. The engine returns them sorted nearest-first;
  // three "you could save more" banners at once is noise that trains people to
  // read past the strip entirely.
  const offer = nearMiss?.[0];
  if (!offer || offer.gap <= 0) return null;

  return (
    <p
      className={`sm-offer-nudge ${className}`.trim()}
      // Announced politely: it changes as the cart changes, and a live region
      // that interrupts on every quantity tap is worse than silence.
      aria-live="polite"
    >
      Add <strong>{inr(offer.gap)}</strong> more to get {rewardPhrase(offer)}.
    </p>
  );
}
