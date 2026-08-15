import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CircleDollarSign,
  Globe,
  MailWarning,
  MessageSquareWarning,
  Radar,
  Rocket,
  ShieldAlert,
  Store,
  StoreIcon,
  Wallet,
} from "lucide-react";
import { getServerUser } from "@/lib/auth/server-user";
import { getPlatformViewer } from "@/app/actions/platform";
import { getPlatformInsights } from "@/lib/platform/overview";
import { PLAN_META } from "@/lib/plans";

export const metadata = { title: "StoreMink Admin" };

// ---------------------------------------------------------------------------
// The operator home screen.
//
// ★ IT NO LONGER CONTAINS THE PRODUCT. This page used to be the store table,
// the pricing editor and the theme seeder stacked on top of each other, which
// meant it grew a panel every time the platform did and answered no question
// in particular. It is an OVERVIEW now: what the estate looks like, what is
// growing, and — the part that earns the screen — what needs someone.
//
// ★ IT DOES NOT USE `requireOperator()`. That helper redirects a non-operator
// to `/dashboard`, which is this page: a signed-in user who is not an operator
// would loop forever. They get an explanation and a way out instead.
// ---------------------------------------------------------------------------

function Metric({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  icon: React.ElementType;
  tone: string;
}) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div
        className={`mb-4 flex h-9 w-9 items-center justify-center rounded-lg ${tone}`}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="text-2xl font-semibold tracking-tight text-slate-950">
        {value.toLocaleString("en-IN")}
      </div>
      <div className="mt-1 text-sm font-medium text-slate-700">{label}</div>
      <div className="mt-0.5 text-xs text-slate-400">{detail}</div>
    </article>
  );
}

/**
 * One attention queue.
 *
 * ★ ZERO IS RENDERED QUIETLY, NEVER HIDDEN. A row that disappears when it is
 * clear teaches nobody what is being watched, so on a good day this block
 * reads as six greyed-out zeroes — which is itself the useful signal. Only a
 * non-zero row takes colour and becomes a link worth following.
 */
function Queue({
  label,
  count,
  href,
  hint,
  icon: Icon,
}: {
  label: string;
  count: number;
  href: string;
  hint: string;
  icon: React.ElementType;
}) {
  const active = count > 0;
  const body = (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3.5 py-3 transition ${
        active
          ? "border-amber-200 bg-amber-50/60 hover:bg-amber-50"
          : "border-slate-200 bg-white"
      }`}
    >
      <Icon
        className={`h-4 w-4 shrink-0 ${active ? "text-amber-600" : "text-slate-300"}`}
      />
      <div className="min-w-0 flex-1">
        <div
          className={`text-sm font-medium ${active ? "text-slate-900" : "text-slate-500"}`}
        >
          {label}
        </div>
        <div className="truncate text-xs text-slate-400">{hint}</div>
      </div>
      <span
        className={`text-lg font-semibold tabular-nums ${
          active ? "text-amber-700" : "text-slate-300"
        }`}
      >
        {count}
      </span>
    </div>
  );

  return active ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export default async function PlatformDashboard() {
  const user = await getServerUser();
  if (!user) {
    // Not signed in at all — the login page, not an error.
    return (
      <div className="stq-auth-wrap">
        <div className="stq-auth">
          <h1>Sign in</h1>
          <p className="sub">This console is for StoreMink operators.</p>
          <Link
            href="/dashboard/login"
            className="stq-btn stq-btn-ghost stq-btn-block"
          >
            Operator login
          </Link>
        </div>
      </div>
    );
  }

  const viewer = await getPlatformViewer();
  if (!viewer) {
    return (
      <div className="stq-auth-wrap">
        <div className="stq-auth">
          <h1>Not authorized</h1>
          <p className="sub">
            {user.email} isn&apos;t a StoreMink operator. If you run a store,
            log in at your store&apos;s address instead.
          </p>
          <Link href="/login" className="stq-btn stq-btn-ghost stq-btn-block">
            Store login
          </Link>
        </div>
      </div>
    );
  }

  const insights = await getPlatformInsights();
  const peak = Math.max(1, ...insights.signups.map((s) => s.count));
  const attentionTotal = Object.values(insights.attention).reduce(
    (sum, n) => sum + n,
    0,
  );

  return (
    <div className="w-full max-w-7xl space-y-8">
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 text-white shadow-sm">
        <div className="flex flex-col gap-5 px-6 py-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
              Platform operations
            </p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              StoreMink control centre
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
              {attentionTotal === 0
                ? "Nothing needs attention right now."
                : `${attentionTotal} ${attentionTotal === 1 ? "item needs" : "items need"} attention.`}{" "}
              {insights.totals.new7d > 0
                ? `${insights.totals.new7d} new ${insights.totals.new7d === 1 ? "store" : "stores"} this week.`
                : "No new stores this week."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/dashboard/stores"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
            >
              All stores <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/dashboard/logs/failures"
              className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Failures <Radar className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {!insights.ok ? (
        // A read failure must say so. Rendering zeroes as though they were the
        // answer is the one thing this screen must never do.
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Platform figures are unavailable — the database read failed. The
          numbers below are not current.
        </div>
      ) : null}

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
        aria-label="Platform summary"
      >
        <Metric
          label="All stores"
          value={insights.totals.stores}
          detail={`${insights.totals.new30d} new in 30 days`}
          icon={StoreIcon}
          tone="bg-indigo-50 text-indigo-700"
        />
        <Metric
          label="Active"
          value={insights.totals.active}
          detail="currently serving"
          icon={Store}
          tone="bg-emerald-50 text-emerald-700"
        />
        <Metric
          label="Paid"
          value={insights.totals.paid}
          detail="effective paid plans"
          icon={CircleDollarSign}
          tone="bg-violet-50 text-violet-700"
        />
        <Metric
          label="Launched"
          value={insights.totals.launched}
          detail="published, indexable"
          icon={Rocket}
          tone="bg-sky-50 text-sky-700"
        />
        <Metric
          label="New this week"
          value={insights.totals.new7d}
          detail="signups in 7 days"
          icon={Wallet}
          tone="bg-amber-50 text-amber-700"
        />
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="lg:col-span-2 rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">
              Signups — last 12 weeks
            </h2>
            <span className="text-xs text-slate-400">peak {peak} / week</span>
          </header>
          <div className="px-5 py-5">
            <div className="flex h-32 items-end gap-1.5">
              {insights.signups.map((point) => (
                <div
                  key={point.weekStart}
                  className="group flex flex-1 flex-col items-center justify-end gap-1"
                  title={`Week of ${new Date(
                    point.weekStart,
                  ).toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "short",
                    timeZone: "Asia/Kolkata",
                  })}: ${point.count}`}
                >
                  <span className="text-[10px] font-medium tabular-nums text-slate-400">
                    {point.count || ""}
                  </span>
                  <div
                    className="w-full rounded-t bg-indigo-500/80 transition group-hover:bg-indigo-600"
                    // A zero week still draws a 2px sliver: a bar of literally
                    // no height reads as a missing week rather than an empty one.
                    style={{
                      height: `${Math.max(2, (point.count / peak) * 100)}%`,
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between text-[11px] text-slate-400">
              <span>
                {insights.signups[0]
                  ? new Date(insights.signups[0].weekStart).toLocaleDateString(
                      "en-GB",
                      {
                        day: "2-digit",
                        month: "short",
                        timeZone: "Asia/Kolkata",
                      },
                    )
                  : ""}
              </span>
              <span>this week</span>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-100 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">Plan mix</h2>
          </header>
          <div className="space-y-3 px-5 py-5">
            {(["pro", "basic", "free"] as const).map((plan) => {
              const count = insights.planMix[plan];
              const share = insights.totals.stores
                ? Math.round((count / insights.totals.stores) * 100)
                : 0;
              return (
                <div key={plan}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium text-slate-700">
                      {PLAN_META[plan]?.name ?? plan}
                    </span>
                    <span className="tabular-nums text-slate-500">
                      {count.toLocaleString("en-IN")}{" "}
                      <span className="text-xs text-slate-400">({share}%)</span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${
                        plan === "pro"
                          ? "bg-violet-500"
                          : plan === "basic"
                            ? "bg-sky-500"
                            : "bg-slate-300"
                      }`}
                      style={{ width: `${share}%` }}
                    />
                  </div>
                </div>
              );
            })}
            <p className="pt-1 text-xs text-slate-400">
              Counted by effective plan — an expired timed grant reads as Free.
            </p>
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">
            Needs attention
          </h2>
          <span className="text-xs text-slate-400">
            {attentionTotal === 0 ? "all clear" : `${attentionTotal} open`}
          </span>
        </header>
        <div className="grid gap-2.5 px-5 py-5 sm:grid-cols-2 xl:grid-cols-3">
          <Queue
            label="Suspended stores"
            count={insights.attention.suspendedStores}
            href="/dashboard/stores"
            hint="Offline until reactivated"
            icon={ShieldAlert}
          />
          <Queue
            label="Subscriptions in grace"
            count={insights.attention.billingGrace}
            href="/dashboard/billing/reconciliation"
            hint="Lose their plan within 48h"
            icon={CircleDollarSign}
          />
          <Queue
            label="Domains stuck"
            count={insights.attention.stuckDomains}
            href="/dashboard/stores"
            hint="Provisioning for over 3 days"
            icon={Globe}
          />
          <Queue
            label="Email failures"
            count={insights.attention.emailFailures24h}
            href="/dashboard/logs/email-logs?status=failed"
            hint="In the last 24 hours"
            icon={MailWarning}
          />
          <Queue
            label="SMS failures"
            count={insights.attention.smsFailures24h}
            href="/dashboard/logs/sms-logs?status=failed"
            hint="In the last 24 hours"
            icon={MessageSquareWarning}
          />
          <Queue
            label="Reconciliation"
            count={insights.attention.openReconciliation}
            href="/dashboard/billing/reconciliation"
            hint="Payment discrepancies to judge"
            icon={Wallet}
          />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">
            Latest signups
          </h2>
          <Link
            href="/dashboard/stores"
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
          >
            All stores
          </Link>
        </header>
        {insights.recent.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            No stores yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {insights.recent.map((store) => (
              <li key={store.id}>
                <Link
                  href={`/dashboard/stores/${store.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-3 transition hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">
                      {store.name}
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {store.ownerEmail ?? store.slug}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium capitalize text-slate-600">
                      {store.plan}
                    </span>
                    <span className="tabular-nums text-slate-400">
                      {new Date(store.createdAt).toLocaleDateString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        timeZone: "Asia/Kolkata",
                      })}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
