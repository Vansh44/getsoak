import { requireSectionAccess } from "../lib/access";
import { getAiUsagePageData } from "@/app/actions/ai-credit-actions";
import {
  getMySubscription,
  getPayableInvoices,
} from "@/app/actions/subscribe-actions";
import { CREDIT_PACKS } from "@/lib/ai/credits";
import { getPlanPricingLive } from "@/lib/plans/pricing";
import { PlansBillingClient } from "./plans-client";
import { OpenInvoices } from "./open-invoices";

export const metadata = { title: "Plans & Billing" };

// Permission section is still "ai" (the credit/AI actions gate on it) — only the
// nav label + route changed to "Plans & Billing".
export default async function PlansBillingPage() {
  const access = await requireSectionAccess("ai", "view");
  // LIVE, not the cached read: this page quotes a price and then charges it.
  // Reading through a cache a reprice had not yet reached would show one number
  // in the upgrade dialog and take a different one from the card.
  const [data, subscription, pricing, invoices] = await Promise.all([
    getAiUsagePageData(),
    getMySubscription(),
    getPlanPricingLive(),
    // ★ What they OWE, above everything else on the page. While automatic
    // collection is gated (lib/billing/gateway.ts) this is the only way a
    // renewal gets paid, so burying it would downgrade merchants who never
    // knew there was a bill.
    getPayableInvoices(),
  ]);
  const canManage = access.can("ai", "manage");
  return (
    <div className="space-y-6">
      <OpenInvoices invoices={invoices} canManage={canManage} />
      <PlansBillingClient
        initialData={data}
        subscription={subscription}
        packs={[...CREDIT_PACKS]}
        canManage={canManage}
        pricing={pricing}
      />
    </div>
  );
}
