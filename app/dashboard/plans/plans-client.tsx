"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Sparkles,
  Coins,
  ShoppingCart,
  Gift,
  Zap,
  Lock,
  History,
  Check,
  BadgeCheck,
  CalendarClock,
  RefreshCw,
  X,
} from "lucide-react";
import {
  confirmCreditPurchase,
  startCreditPurchase,
  type AiUsagePageData,
} from "@/app/actions/ai-credit-actions";
import {
  startPlanSubscription,
  confirmSubscription,
  cancelSubscription,
  changePlan,
  type SubscriptionState,
} from "@/app/actions/subscription-actions";
import type { CreditPack } from "@/lib/ai/credits";
import {
  openRazorpayModal,
  openRazorpaySubscriptionModal,
} from "@/lib/payments/razorpay-client";
import {
  PLAN_IDS,
  PLAN_LIMITS,
  PLAN_META,
  PLAN_RANK,
  normalizePlan,
  type Plan,
} from "@/lib/plans";
import type { PlanPricing } from "@/lib/plans/pricing";

const KIND_META: Record<
  AiUsagePageData["ledger"][number]["kind"],
  { label: string; Icon: typeof Zap; tone: string }
> = {
  spend: { label: "Generation", Icon: Zap, tone: "text-gray-500" },
  purchase: { label: "Purchase", Icon: ShoppingCart, tone: "text-green-600" },
  grant: { label: "Grant", Icon: Gift, tone: "text-indigo-600" },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// The bullets shown for each plan in "Available plans", derived from the plan
// limits so they can never drift from what's actually enforced.
function planFeatures(plan: Plan): string[] {
  const l = PLAN_LIMITS[plan];
  return [
    `${l.maxProducts === null ? "Unlimited" : l.maxProducts} products`,
    `${l.maxStaff === null ? "Unlimited" : l.maxStaff} staff account${l.maxStaff === 1 ? "" : "s"}`,
    `${l.aiGenerationsPerMonth === null ? "Unlimited" : l.aiGenerationsPerMonth} AI generations / month`,
    l.customDomain ? "Custom domain" : "Subdomain only",
    l.onlinePayments ? "Online payments (own gateway)" : "Cash on Delivery",
    ...(l.emailCampaigns ? ["Email campaigns"] : []),
    ...(l.removeBadge ? ['No "Powered by StoreMink" badge'] : []),
  ];
}

export function PlansBillingClient({
  initialData,
  subscription,
  packs,
  canManage,
  pricing,
}: {
  initialData: AiUsagePageData;
  subscription: SubscriptionState;
  packs: CreditPack[];
  canManage: boolean;
  /** Resolved server-side (code defaults + operator overrides). Never read
   *  PLAN_META prices here — they ignore what an operator has set, so the card
   *  and the charge would disagree. */
  pricing: PlanPricing;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const data = initialData;
  const [buyingPack, setBuyingPack] = useState<string | null>(null);
  // Yearly by default, matching the public pricing page. It is the cheaper
  // per-month figure and the one we want anchored before a comparison.
  const [period, setPeriod] = useState<"monthly" | "yearly">("yearly");
  const [upgradeTo, setUpgradeTo] = useState<Plan | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const refresh = () => startRefresh(() => router.refresh());

  async function handleCancel() {
    if (
      !window.confirm(
        "Cancel autopay? You keep your plan until the current cycle ends, then you'll move to Free. No further payments will be taken.",
      )
    ) {
      return;
    }
    setCancelling(true);
    const res = await cancelSubscription();
    setCancelling(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(res.message ?? "Subscription cancelled.");
    refresh();
  }

  const { used, cap, creditBalance } = data.usage;
  const remaining = cap === null ? null : Math.max(0, cap - used);
  const plan = normalizePlan(data.plan);
  const planMeta = PLAN_META[plan];
  const pct =
    cap === null
      ? 0
      : Math.min(100, Math.round((used / Math.max(cap, 1)) * 100));

  // Plan status, derived from the effective plan + expiry. `now` is captured
  // once (render must stay pure — no Date.now() inline).
  const [now] = useState(() => Date.now());

  // The monthly allowance resets at the start of the next calendar month (UTC,
  // matching lib/ai/quota.ts currentPeriod). Show a live countdown, not a
  // static "1st of the month".
  const resetCountdown = (() => {
    const d = new Date(now);
    const nextReset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const days = Math.ceil((nextReset - now) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "tomorrow";
    return `in ${days} days`;
  })();
  const expiresAt = data.planExpiresAt;
  const expired =
    plan === "free" && !!expiresAt && new Date(expiresAt).getTime() < now;
  const status = expired
    ? { label: "Expired", tone: "amber" as const }
    : plan === "free"
      ? { label: "Free", tone: "gray" as const }
      : { label: "Active", tone: "green" as const };

  async function handleBuy(pack: CreditPack) {
    setBuyingPack(pack.id);
    const start = await startCreditPurchase(pack.id);
    if ("error" in start) {
      toast.error(start.error);
      setBuyingPack(null);
      return;
    }
    const opened = await openRazorpayModal({
      keyId: start.keyId,
      rzpOrderId: start.rzpOrderId,
      amountPaise: start.amountPaise,
      name: "StoreMink",
      description: `${pack.credits} AI credits — ${start.packName} pack`,
      onSuccess: async (res) => {
        const confirm = await confirmCreditPurchase(
          start.purchaseId,
          res.razorpay_payment_id,
          res.razorpay_signature,
        );
        setBuyingPack(null);
        if (confirm.error) {
          toast.info(
            "Payment received — your credits will appear here in a few minutes.",
          );
        } else {
          toast.success(`${confirm.creditsAdded} AI credits added!`);
        }
        startRefresh(() => router.refresh());
      },
      onDismiss: () => {
        setBuyingPack(null);
        toast.error("Payment not completed.");
      },
    });
    if (!opened) {
      setBuyingPack(null);
      toast.error("Couldn't load the payment window. Please try again.");
    }
  }

  return (
    <div className="dash-page-enter mx-auto w-full max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#111827]">
          Plans &amp; Billing
        </h1>
        <p className="mt-1 text-sm text-[#5b6472]">
          Your subscription, AI usage &amp; credits, and the plans you can move
          to.
        </p>
      </div>

      {/* ─────────────── 1. Plan details ─────────────── */}
      <section className="rounded-xl border border-[rgba(17,24,39,0.08)] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-50">
              <BadgeCheck className="h-6 w-6 text-indigo-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-[#111827]">
                  {planMeta.name} plan
                </h2>
                <StatusPill status={status} />
              </div>
              <p className="mt-0.5 text-sm text-[#5b6472]">
                {planMeta.tagline}
              </p>
            </div>
          </div>
          {plan !== "pro" && (
            <button
              type="button"
              className="dash-btn dash-btn-primary"
              onClick={() =>
                document
                  .getElementById("available-plans")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              {plan === "free" ? "Upgrade plan" : "See upgrade options"}
            </button>
          )}
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Detail label="Price">
            {/* Resolved pricing, not PLAN_META — after an operator reprice the
                constant is no longer what this store is on. */}
            {pricing[plan].monthlyInr === 0
              ? "Free"
              : `₹${pricing[plan].monthlyInr.toLocaleString("en-IN")}/mo`}
          </Detail>
          <Detail label="Status">{status.label}</Detail>
          <Detail label={expired ? "Expired on" : "Renews / expires"}>
            {expiresAt ? formatDate(expiresAt) : "No expiry"}
          </Detail>
          <Detail label="Billing">
            {data.planSource === "paid"
              ? "Paid subscription"
              : data.planSource === "trial"
                ? "Trial"
                : data.planSource === "comp"
                  ? "Complimentary"
                  : "—"}
          </Detail>
        </dl>

        {/* Autopay controls / notices */}
        {(subscription.active ||
          subscription.cancelAtPeriodEnd ||
          subscription.scheduledPlan) && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[rgba(17,24,39,0.08)] pt-4">
            <p className="text-sm text-[#5b6472]">
              {subscription.cancelAtPeriodEnd ? (
                <>
                  Autopay is cancelled — you keep {planMeta.name}
                  {subscription.currentEnd
                    ? ` until ${formatDate(subscription.currentEnd)}`
                    : " until the cycle ends"}
                  , then move to Free.
                </>
              ) : subscription.scheduledPlan ? (
                <>
                  {PLAN_META[normalizePlan(subscription.scheduledPlan)].name}{" "}
                  starts at your next renewal
                  {subscription.currentEnd
                    ? ` (${formatDate(subscription.currentEnd)})`
                    : ""}
                  .
                </>
              ) : (
                <>
                  Autopay renews your {planMeta.name} plan
                  {subscription.currentEnd
                    ? ` on ${formatDate(subscription.currentEnd)}`
                    : " automatically"}
                  .
                </>
              )}
            </p>
            {canManage &&
              subscription.active &&
              !subscription.cancelAtPeriodEnd && (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
                >
                  {cancelling ? "Cancelling…" : "Cancel autopay"}
                </button>
              )}
          </div>
        )}
      </section>

      {/* ─────────────── 2. Credits & usage ─────────────── */}
      <section className="rounded-xl border border-[rgba(17,24,39,0.08)] bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-[#111827]">
          Credits &amp; usage
        </h2>
        <p className="mt-1 text-sm text-[#5b6472]">
          Every AI generation (product copy, SEO, brand voice, coupon emails)
          uses your plan&apos;s monthly allowance first, then your purchased
          credits — credits never expire.
        </p>

        <div className="mt-5 grid gap-6 sm:grid-cols-2">
          {/* Monthly allowance */}
          <div className="rounded-lg border border-[rgba(17,24,39,0.08)] p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50">
                <Sparkles className="h-5 w-5 text-indigo-600" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-[#111827]">
                  This month
                </h3>
                <p className="text-sm text-[#5b6472]">
                  {planMeta.name} plan allowance
                </p>
              </div>
              <button
                type="button"
                onClick={() => startRefresh(() => router.refresh())}
                disabled={refreshing}
                aria-label="Refresh usage"
                title="Refresh usage"
                className="flex h-8 w-8 items-center justify-center rounded-md text-[#6b7280] transition-colors hover:bg-[#f3f4f6] disabled:opacity-60"
              >
                <RefreshCw
                  className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                />
              </button>
            </div>
            <div className="mt-4">
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-bold text-[#111827]">
                  {cap === null ? used : remaining}
                </span>
                <span className="text-sm text-[#5b6472]">
                  {cap === null
                    ? "generations used"
                    : `of ${cap} generations left`}
                </span>
              </div>
              {cap !== null && (
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-indigo-500"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              <p className="mt-2 text-xs text-[#5b6472]">
                Resets {resetCountdown}.
              </p>
            </div>
          </div>

          {/* Credit balance */}
          <div className="rounded-lg border border-[rgba(17,24,39,0.08)] p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50">
                <Coins className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-[#111827]">
                  AI credits
                </h3>
                <p className="text-sm text-[#5b6472]">Never expire</p>
              </div>
            </div>
            <div className="mt-4">
              <span className="text-3xl font-bold text-[#111827]">
                {creditBalance}
              </span>
              <span className="ml-2 text-sm text-[#5b6472]">
                credit{creditBalance === 1 ? "" : "s"} remaining
              </span>
              <p className="mt-2 text-xs text-[#5b6472]">
                Used automatically once the monthly allowance runs out.
              </p>
            </div>
          </div>
        </div>

        {/* Buy credits */}
        <div className="mt-6">
          <h3 className="text-base font-semibold text-[#111827]">
            Top up credits
          </h3>
          <p className="mt-1 text-sm text-[#5b6472]">
            Cheaper per generation than upgrading a plan for a one-off burst.
          </p>
          <div className="mt-4">
            {!data.canBuyCredits ? (
              <div className="flex items-start gap-3 rounded-md bg-amber-50 p-4">
                <Lock className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
                <div className="text-sm text-amber-800">
                  <p className="font-medium">
                    Credit top-ups are available from the Basic plan.
                  </p>
                  <p className="mt-1">
                    Upgrade below to buy AI credits and unlock a larger monthly
                    allowance.
                  </p>
                </div>
              </div>
            ) : !data.purchasesAvailable ? (
              <p className="text-sm text-[#5b6472]">
                Credit purchases aren&apos;t available right now. Please check
                back soon.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                {packs.map((pack) => (
                  <div
                    key={pack.id}
                    className={`relative rounded-lg border p-5 ${
                      pack.popular
                        ? "border-indigo-300 ring-1 ring-indigo-200"
                        : "border-[rgba(17,24,39,0.08)]"
                    }`}
                  >
                    {pack.popular && (
                      <span className="absolute -top-2.5 left-4 rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white">
                        Most popular
                      </span>
                    )}
                    <div className="text-sm font-medium text-[#5b6472]">
                      {pack.name}
                    </div>
                    <div className="mt-1 text-2xl font-bold text-[#111827]">
                      {pack.credits}{" "}
                      <span className="text-sm font-medium text-[#5b6472]">
                        credits
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-[#5b6472]">
                      ₹{pack.priceInr.toLocaleString("en-IN")} · ₹
                      {(pack.priceInr / pack.credits).toFixed(2)}/credit
                    </div>
                    <button
                      type="button"
                      className="dash-btn dash-btn-primary mt-4 w-full justify-center"
                      onClick={() => handleBuy(pack)}
                      disabled={!canManage || buyingPack !== null}
                    >
                      {buyingPack === pack.id ? "Opening…" : "Buy now"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent activity */}
        <div className="mt-6 border-t border-[rgba(17,24,39,0.08)] pt-5">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-[#5b6472]" />
            <h3 className="text-base font-semibold text-[#111827]">
              Recent credit activity
            </h3>
          </div>
          {data.ledger.length === 0 ? (
            <p className="mt-3 text-sm text-[#5b6472]">
              No credit activity yet — purchases, grants and spends show up
              here.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-[rgba(17,24,39,0.06)]">
              {data.ledger.map((entry) => {
                const meta = KIND_META[entry.kind];
                return (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between py-3"
                  >
                    <div className="flex items-center gap-3">
                      <meta.Icon className={`h-4 w-4 ${meta.tone}`} />
                      <div>
                        <div className="text-sm font-medium text-[#344054]">
                          {meta.label}
                          {entry.note ? (
                            <span className="ml-2 text-xs font-normal text-[#5b6472]">
                              {entry.note}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-xs text-[#5b6472]">
                          {formatDateTime(entry.created_at)}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`text-sm font-semibold ${
                        entry.delta > 0 ? "text-green-600" : "text-[#5b6472]"
                      }`}
                    >
                      {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ─────────────── 3. Available plans ─────────────── */}
      <section
        id="available-plans"
        className="rounded-xl border border-[rgba(17,24,39,0.08)] bg-white p-6 shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-[#111827]">
              Available plans
            </h2>
            <p className="mt-1 text-sm text-[#5b6472]">
              Pick the plan that fits your business. Yearly billing saves ~2
              months.
            </p>
          </div>
          <div className="inline-flex items-center rounded-full bg-[#f1f3f5] p-1 text-sm font-medium">
            {(["monthly", "yearly"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`rounded-full px-4 py-1.5 capitalize transition-colors ${
                  period === p
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-[#5b6472]"
                }`}
              >
                {p}
                {p === "yearly" && (
                  <span className="ml-1.5 text-[11px] font-semibold text-amber-600">
                    SAVE
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {PLAN_IDS.map((p) => {
            const meta = PLAN_META[p];
            const isCurrent = p === plan;
            const isUpgrade = PLAN_RANK[p] > PLAN_RANK[plan];
            const p_ = pricing[p];
            // The headline is ALWAYS per month so the two tabs compare like
            // for like; the annual total is spelled out below rather than
            // hidden until checkout.
            const perMonth =
              period === "yearly"
                ? Math.round(p_.yearlyInr / 12)
                : p_.monthlyInr;
            const billed = period === "yearly" ? p_.yearlyInr : p_.monthlyInr;
            return (
              <div
                key={p}
                className={`relative flex flex-col rounded-xl border p-5 ${
                  isCurrent
                    ? "border-green-300 bg-green-50/40 ring-1 ring-green-200"
                    : "border-[rgba(17,24,39,0.1)]"
                }`}
              >
                {isCurrent && (
                  <span className="absolute right-4 top-4 rounded-full bg-green-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                    Current
                  </span>
                )}
                <div className="text-base font-bold text-[#111827]">
                  {meta.name}
                </div>
                <div className="mt-1 text-2xl font-bold text-[#111827]">
                  {perMonth === 0 ? (
                    "₹0"
                  ) : (
                    <>
                      ₹{perMonth.toLocaleString("en-IN")}
                      <span className="text-sm font-medium text-[#5b6472]">
                        /month
                      </span>
                    </>
                  )}
                </div>
                {billed === 0 && (
                  <p className="mt-0.5 text-xs text-[#5b6472]">Free forever</p>
                )}
                <p className="mt-1 text-xs text-[#5b6472]">{meta.tagline}</p>

                <ul className="mt-4 flex-1 space-y-2">
                  {planFeatures(p).map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2 text-sm text-[#344054]"
                    >
                      <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
                      {f}
                    </li>
                  ))}
                </ul>

                <div className="mt-5">
                  {isCurrent ? (
                    <button
                      type="button"
                      disabled
                      className="dash-btn w-full justify-center opacity-60"
                    >
                      Current plan
                    </button>
                  ) : isUpgrade ? (
                    <button
                      type="button"
                      className="dash-btn dash-btn-primary w-full justify-center"
                      onClick={() => setUpgradeTo(p)}
                    >
                      Upgrade to {meta.name}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="dash-btn w-full justify-center"
                      onClick={() => setUpgradeTo(p)}
                    >
                      Switch to {meta.name}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {upgradeTo && (
        <UpgradeModal
          plan={upgradeTo}
          period={period}
          purchasesAvailable={data.purchasesAvailable}
          hasActiveSubscription={subscription.active}
          onClose={() => setUpgradeTo(null)}
          onActivated={() => {
            setUpgradeTo(null);
            refresh();
          }}
          pricing={pricing}
        />
      )}
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-[#9ca3af]">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-[#111827]">{children}</dd>
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: { label: string; tone: "green" | "amber" | "gray" };
}) {
  const tone =
    status.tone === "green"
      ? "bg-green-50 text-green-700"
      : status.tone === "amber"
        ? "bg-amber-50 text-amber-700"
        : "bg-gray-100 text-gray-600";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}
    >
      {status.label}
    </span>
  );
}

// Upgrade flow, three branches:
//   • free → paid (no subscription): authorise a fresh autopay mandate.
//   • paid → higher paid (active subscription): change the plan on the same
//     mandate, either NOW (prorated) or at the next renewal.
//   • no self-serve path available: fall back to contacting support.
function UpgradeModal({
  plan,
  period,
  purchasesAvailable,
  hasActiveSubscription,
  onClose,
  onActivated,
  pricing,
}: {
  plan: Plan;
  period: "monthly" | "yearly";
  purchasesAvailable: boolean;
  hasActiveSubscription: boolean;
  onClose: () => void;
  onActivated: () => void;
  pricing: PlanPricing;
}) {
  const meta = PLAN_META[plan];
  // From the resolved pricing, not PLAN_META — this dialog is the last thing
  // someone reads before authorising a payment, so it must state the amount
  // that is actually taken.
  const price =
    period === "yearly" ? pricing[plan].yearlyInr : pricing[plan].monthlyInr;
  const [working, setWorking] = useState(false);

  // No live mandate yet (free, or an operator-granted paid plan) → start a
  // fresh subscription for the target plan. An existing active subscription →
  // change the plan on that same mandate (now / at renewal).
  const isPlanChange = hasActiveSubscription && purchasesAvailable;
  const isNewSubscription = !hasActiveSubscription && purchasesAvailable;

  async function subscribe() {
    setWorking(true);
    const start = await startPlanSubscription(plan, period);
    if ("error" in start) {
      toast.error(start.error);
      setWorking(false);
      return;
    }
    const opened = await openRazorpaySubscriptionModal({
      keyId: start.keyId,
      subscriptionId: start.subscriptionId,
      name: "StoreMink",
      description: `${start.planName} plan — ${period} autopay`,
      onSuccess: async (res) => {
        const confirmed = await confirmSubscription(
          res.razorpay_payment_id,
          res.razorpay_subscription_id,
          res.razorpay_signature,
        );
        setWorking(false);
        if (confirmed.error) {
          toast.info(
            "Mandate authorised — your plan will activate here shortly.",
          );
        } else {
          toast.success(`You're on the ${meta.name} plan!`);
        }
        onActivated();
      },
      onDismiss: () => {
        setWorking(false);
        toast.error("Autopay setup wasn't completed.");
      },
    });
    if (!opened) {
      setWorking(false);
      toast.error("Couldn't open the payment window. Please try again.");
    }
  }

  async function doChange(when: "now" | "cycle_end") {
    setWorking(true);
    const res = await changePlan(plan, when);
    setWorking(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(res.message ?? "Plan updated.");
    onActivated();
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50">
              <CalendarClock className="h-5 w-5 text-indigo-600" />
            </div>
            <h2 className="text-lg font-semibold text-[#111827]">
              Move to {meta.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-4 text-sm text-[#5b6472]">
          The {meta.name} plan is{" "}
          <span className="font-semibold text-[#111827]">
            ₹{price.toLocaleString("en-IN")}
            {period === "yearly" ? "/year" : "/month"}
          </span>
          .{" "}
          {isNewSubscription
            ? "You'll authorise autopay once — it then renews automatically, and you can cancel anytime."
            : isPlanChange
              ? "Choose when to start — right away (charged now, prorated) or at your next renewal, on your existing autopay."
              : "This change isn't self-serve yet — our team will switch it for you."}
        </p>

        {isNewSubscription ? (
          <button
            type="button"
            onClick={subscribe}
            disabled={working}
            className="dash-btn dash-btn-primary mt-5 w-full justify-center"
          >
            {working ? "Opening…" : "Subscribe & set up autopay"}
          </button>
        ) : isPlanChange ? (
          <div className="mt-5 space-y-2">
            <button
              type="button"
              onClick={() => doChange("now")}
              disabled={working}
              className="dash-btn dash-btn-primary w-full justify-center"
            >
              {working ? "Working…" : "Switch now (prorated)"}
            </button>
            <button
              type="button"
              onClick={() => doChange("cycle_end")}
              disabled={working}
              className="dash-btn w-full justify-center"
            >
              Start at next renewal
            </button>
          </div>
        ) : (
          <a
            href="mailto:support@storemink.com?subject=Change%20my%20plan"
            className="dash-btn dash-btn-primary mt-5 w-full justify-center"
          >
            Contact us to change plan
          </a>
        )}
      </div>
    </div>
  );
}
