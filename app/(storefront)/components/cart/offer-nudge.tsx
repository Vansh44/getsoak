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

/** "one is free" / "two are half price" — what completing the set earns. */
function setReward(offer: NearMissOffer): string {
  const n = offer.getQuantity ?? 1;
  const noun = n === 1 ? "one" : `${n}`;
  const verb = n === 1 ? "is" : "are";
  return offer.percent && offer.percent < 100
    ? `${noun} ${verb} ${offer.percent}% off`
    : `${noun} ${verb} free`;
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

  // ★ TWO SENTENCES, BECAUSE THE TWO GAPS ARE NOT THE SAME KIND OF THING.
  // "Add ₹200 more" and "add 1 more" cannot share a template — a single one
  // would have to render the unit gap as currency or the spend gap as a count,
  // and either reads as a bug. The engine tags which it is rather than leaving
  // the component to infer it from the number.
  const body =
    offer.kind === "units" ? (
      <>
        Add <strong>{offer.gap}</strong> more and {setReward(offer)}.
      </>
    ) : (
      <>
        Add <strong>{inr(offer.gap)}</strong> more to get {rewardPhrase(offer)}.
      </>
    );

  return (
    <p
      className={`sm-offer-nudge ${className}`.trim()}
      // Announced politely: it changes as the cart changes, and a live region
      // that interrupts on every quantity tap is worse than silence.
      aria-live="polite"
    >
      {body}
    </p>
  );
}
