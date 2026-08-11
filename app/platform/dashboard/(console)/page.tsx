import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerUser } from "@/lib/auth/server-user";
import {
  getPlatformOverview,
  getPlatformViewer,
  listAllStores,
} from "@/app/actions/platform";
import { THEME_META } from "@/lib/themes/meta";
import { StoresConsole } from "./stores-console";
import { ThemesPanel } from "./themes-panel";
import { PricingPanel } from "./pricing-panel";
import {
  getExtraLocationPricingLive,
  getPlanPricingLive,
} from "@/lib/plans/pricing";
import {
  Activity,
  ArrowRight,
  CircleDollarSign,
  MailWarning,
  ShieldAlert,
  Store,
  StoreIcon,
} from "lucide-react";

export const metadata = { title: "StoreMink Admin" };

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";

export default async function PlatformDashboard({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // Must be signed in to the platform, and be a platform operator.
  const user = await getServerUser();
  if (!user) redirect("/dashboard/login");

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

  const { q } = await searchParams;
  const [stores, overview] = await Promise.all([
    listAllStores(q),
    getPlatformOverview(),
  ]);

  // Which theme demo stores already exist (for the Themes panel).
  const demoSlugs = new Set(THEME_META.map((t) => t.demo.slug));
  const demoSlugsLive = stores
    .filter((s) => demoSlugs.has(s.slug))
    .map((s) => s.slug);

  return (
    <div className="w-full max-w-6xl space-y-8">
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
              Monitor merchant growth, delivery health and stores that need
              attention from one workspace.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/dashboard/email-logs?mailer=signup_test_otp&days=1"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
            >
              Dummy signup codes <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/dashboard/failures"
              className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Failure feed <Activity className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
        aria-label="Platform summary"
      >
        {[
          {
            label: "All stores",
            value: overview.totalStores,
            detail: `${overview.newStores30d} new in 30 days`,
            icon: StoreIcon,
            tone: "bg-indigo-50 text-indigo-700",
          },
          {
            label: "Active",
            value: overview.activeStores,
            detail: "currently serving",
            icon: Store,
            tone: "bg-emerald-50 text-emerald-700",
          },
          {
            label: "Paid",
            value: overview.paidStores,
            detail: "effective paid plans",
            icon: CircleDollarSign,
            tone: "bg-violet-50 text-violet-700",
          },
          {
            label: "Suspended",
            value: overview.suspendedStores,
            detail: "require review",
            icon: ShieldAlert,
            tone: "bg-amber-50 text-amber-700",
          },
          {
            label: "Email failures",
            value: overview.emailFailures24h,
            detail: "in the last 24h",
            icon: MailWarning,
            tone:
              overview.emailFailures24h > 0
                ? "bg-red-50 text-red-700"
                : "bg-slate-100 text-slate-600",
          },
        ].map((metric) => {
          const Icon = metric.icon;
          return (
            <article
              key={metric.label}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div
                className={`mb-4 flex h-9 w-9 items-center justify-center rounded-lg ${metric.tone}`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="text-2xl font-semibold tracking-tight text-slate-950">
                {metric.value.toLocaleString("en-IN")}
              </div>
              <div className="mt-1 text-sm font-medium text-slate-700">
                {metric.label}
              </div>
              <div className="mt-0.5 text-xs text-slate-400">
                {metric.detail}
              </div>
            </article>
          );
        })}
      </section>

      <StoresConsole
        stores={stores}
        canManage={viewer.role === "superadmin"}
        email={viewer.email}
        q={q ?? ""}
        rootDomain={ROOT_DOMAIN}
      />
      {viewer.role === "superadmin" && (
        <>
          <PricingPanel
            pricing={await getPlanPricingLive()}
            extraLocation={await getExtraLocationPricingLive()}
          />
          <ThemesPanel rootDomain={ROOT_DOMAIN} demoSlugsLive={demoSlugsLive} />
        </>
      )}
    </div>
  );
}
