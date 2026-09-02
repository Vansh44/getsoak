import { redirect } from "next/navigation";

// Marketing surfaces a single tool — Offers, which absorbed coupons: a
// discount code is one DELIVERY METHOD of an offer, not a separate feature
// (docs/offers-plan.md §2). Land there directly.
//
// ★ Straight to /dashboard/offers rather than through the coupons path, which
// now redirects here-ward itself. Chaining two redirects for one click is how a
// navigation ends up with a visible flash and an extra round trip.
export default function MarketingPage() {
  redirect("/dashboard/offers");
}
