import { requireSectionAccess } from "../lib/access";
import { getAiUsagePageData } from "@/app/actions/ai-credit-actions";
import { getSubscriptionState } from "@/app/actions/subscription-actions";
import { CREDIT_PACKS } from "@/lib/ai/credits";
import { getPlanPricingLive } from "@/lib/plans/pricing";
import { PlansBillingClient } from "./plans-client";

export const metadata = { title: "Plans & Billing" };

// Permission section is still "ai" (the credit/AI actions gate on it) — only the
// nav label + route changed to "Plans & Billing".
export default async function PlansBillingPage() {
  const access = await requireSectionAccess("ai", "view");
  // LIVE, not the cached read: this page quotes a price and then charges it.
  // Reading through a cache a reprice had not yet reached would show one number
  // in the upgrade dialog and take a different one from the card.
  const [data, subscription, pricing] = await Promise.all([
    getAiUsagePageData(),
    getSubscriptionState(),
    getPlanPricingLive(),
  ]);
  return (
    <PlansBillingClient
      initialData={data}
      subscription={subscription}
      packs={[...CREDIT_PACKS]}
      canManage={access.can("ai", "manage")}
      pricing={pricing}
    />
  );
}
