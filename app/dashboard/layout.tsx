import { redirect } from "next/navigation";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { getStoreBrand } from "@/lib/store/brand";
import { getCurrentStore } from "@/lib/store/resolve";
import { effectivePlan, PLAN_META } from "@/lib/plans";
import { DashboardTopbar } from "./dashboard-topbar";
import { DashboardSidebar } from "./dashboard-sidebar";
import { MobileNavProvider } from "./dashboard-mobile-nav";
import { getViewerContext } from "./lib/access";
import { SwitchAccountButton } from "./switch-account-button";
import { getNewEnquiriesCount } from "./enquiries/data";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";
import { outstandingDocs } from "@/lib/legal/store";
import { ChatProvider } from "./chat-context";
import { DashboardChat } from "./dashboard-chat";
import { ImportRunnerProvider } from "./components/import-runner";
import {
  SECTIONS,
  SECTION_GROUPS,
  foldNestedSections,
  can,
  type SectionGroup,
} from "./lib/permissions";
import "./dashboard.css";

const dashFont = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-dash",
});

const dashMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dash-mono",
});

export async function generateMetadata() {
  const brand = await getStoreBrand();
  return {
    title: `${brand.name} — Operations Center`,
    icons: brand.logoUrl
      ? { icon: brand.logoUrl }
      : { icon: "/brand/storemink-mark.png" },
  };
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Shared, request-cached resolution (getUser → profiles → roles). The page
  // rendering inside this layout reuses the SAME result via getViewerAccess.
  const ctx = await getViewerContext();

  if (!ctx) {
    redirect("/auth/login");
  }

  const { userEmail, profile, isSuperadmin, permissions } = ctx;

  if (ctx.dbError) {
    // The access lookups failed — we don't know who this is, so we must NOT
    // fall through to the "no access" screen below and accuse them of not
    // being staff. This is an outage, and it's usually transient (locally:
    // the Cloud SQL Auth Proxy losing its credentials), hence the plain
    // GET-form retry — no JS needed to try again.
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f6f7f9] px-4 text-[#111827]">
        <div className="max-w-md space-y-4 rounded-2xl border border-[rgba(17,24,39,0.08)] bg-white p-8 text-center shadow-[0_12px_32px_-8px_rgba(16,24,40,0.16)]">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-2xl">
            ⚠️
          </div>
          <h1 className="text-lg font-bold">
            Couldn&apos;t reach the database
          </h1>
          <p className="text-sm text-[#5b6472]">
            Your dashboard is fine — we just can&apos;t load it right now. This
            is usually temporary, so try again in a moment.
          </p>
          <form>
            <button
              type="submit"
              className="rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              Try again
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!profile) {
    // Authenticated, but this account is not staff of THIS store (and not a
    // platform operator). In the multi-tenant model that's simply "no access"
    // — never expose SQL / a self-provision path, which would be a privilege
    // escalation hint.
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f6f7f9] px-4 text-[#111827]">
        <div className="max-w-md space-y-4 rounded-2xl border border-[rgba(17,24,39,0.08)] bg-white p-8 text-center shadow-[0_12px_32px_-8px_rgba(16,24,40,0.16)]">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-2xl">
            🔒
          </div>
          <h1 className="text-lg font-bold">No access to this dashboard</h1>
          <p className="text-sm text-[#5b6472]">
            You&apos;re signed in as{" "}
            <span className="font-medium text-[#111827]">{userEmail}</span>, but
            this account isn&apos;t a staff member of this store. If this is
            your store, sign in with the account you used to create it.
          </p>
          <SwitchAccountButton />
        </div>
      </div>
    );
  }

  // --- Re-acceptance gate -------------------------------------------------
  // A policy published at a new version binds nobody until they agree to it,
  // so someone who accepted v1 has to be asked again when v2 goes out. Same
  // shape as the force_password_reset gate in proxy.ts, one layer lower.
  //
  // It lives HERE rather than in proxy.ts on purpose: the proxy reads its
  // claims straight from the verified session cookie and does no DB query at
  // all, and putting a lookup on every dashboard request would give that up.
  // This layout already resolves the viewer from the database.
  //
  // Deliberately AFTER the outage and no-access branches above: someone who
  // can't use this dashboard shouldn't be asked to accept terms for it, and an
  // unreachable database must never present as a consent demand. outstandingDocs
  // fails open for the same reason — a hiccup must not lock everyone out.
  const pendingPolicies = await outstandingDocs(ctx.userId);
  if (pendingPolicies.length > 0) {
    redirect("/auth/policy-update");
  }

  // isSuperadmin + permissions come from the shared cached context above.

  // Live count of unhandled enquiries → sidebar badge (only when the viewer can
  // see enquiries, and only when there's at least one new one).
  const canViewEnquiries = can(permissions, "enquiries", "view", isSuperadmin);
  const newEnquiries = canViewEnquiries ? await getNewEnquiriesCount() : 0;

  // NOTE: no low-stock badge on Inventory. It was removed deliberately, and
  // with it the getLowStockAlertCount() query — one less DB round trip on every
  // dashboard page load. Low stock still surfaces where it is actionable: the
  // Inventory page's own Low Stock filter, and the inventory.low_stock
  // notification (CODEBASE.md §24), which fires on the CROSSING rather than
  // sitting there as a permanent number.

  // Store identity for the topbar (name + current plan, Shopify-style). Cached
  // host lookup, so this adds no query. effectivePlan folds an expired timed
  // plan back to free so the badge never overstates what the store can do.
  const store = await getCurrentStore();
  const planId = effectivePlan(store);
  const planName = PLAN_META[planId].name;

  // POS sidebar three-state: "Included in Pro" (upgrade) → "Enable POS" → live.
  const posState = getPosState(store);

  // Locations appears only once it is useful: a single-location store has
  // nothing to decide there (docs/locations-ia.md §6.3). Shown on Pro once the
  // store either has a second location or has switched POS on — both are the
  // moment "which location?" starts being a real question.
  const locationCount = posState.posAvailable
    ? (await getStoreLocations(store.id)).length
    : 0;
  const showLocations =
    posState.posAvailable && (locationCount > 1 || posState.posEnabled);

  // Build the sidebar from the permission catalog: a section appears only when
  // the viewer can view it. The Dashboard home is always shown so everyone has
  // a landing page. Empty groups are dropped. The enquiries item gets a live
  // badge spliced in (without mutating the shared SECTIONS catalog).
  const navGroups = SECTION_GROUPS.map((group) => ({
    group,
    items: SECTIONS.filter(
      (s) =>
        s.group === group &&
        // Folded into another screen — key kept for roles, entry hidden here.
        !s.hiddenInNav &&
        (s.key !== "locations" || showLocations) &&
        (s.key === "dashboard" ||
          can(permissions, s.key, "view", isSuperadmin)),
    ).map((s) => {
      if (s.key === "enquiries" && newEnquiries > 0) {
        return {
          ...s,
          badge: String(newEnquiries),
          badgeTone: "amber" as const,
        };
      }
      if (s.key === "pos") {
        const rest = { ...s };
        if (!posState.posAvailable) {
          // free / basic → "Included in Pro" upgrade nudge; no sub-pages.
          rest.badge = "Pro";
          rest.badgeTone = "accent" as const;
          delete rest.children;
        } else if (!posState.posEnabled) {
          // pro, not switched on → overview shows the Enable POS screen.
          delete rest.badge;
          delete rest.badgeTone;
          delete rest.children;
        }
        return rest;
      }
      return s;
    }),
  })).filter((g) => g.items.length > 0) as {
    group: SectionGroup;
    items: typeof SECTIONS;
  }[];

  // Nest the sections that declare a `parent` (Categories/Colours/Inventory
  // under Products, the settings areas under Settings, …). Runs AFTER the
  // permission filter above, which is the whole point — see foldNestedSections.
  const nav = foldNestedSections(navGroups);

  return (
    <div
      // `dashboard-shell` is the design-system SCOPE (tokens + .dash-* rules) and
      // is now also worn by portalled dialogs; `dashboard-frame` is the page
      // frame (100vh, overflow hidden) that only this element should have.
      className={`dashboard-shell dashboard-frame ${dashFont.variable} ${dashMono.variable} flex flex-col`}
    >
      {/* Wraps everything so a running import survives route changes — the
          chunk loop belongs to whatever component owns it, and in the dialog
          that meant the import died the moment the merchant navigated. */}
      <ImportRunnerProvider>
        <ChatProvider>
          <MobileNavProvider>
            <DashboardTopbar
              email={profile.email}
              role={profile.role ?? ""}
              firstName={profile.first_name}
              lastName={profile.last_name}
              storeName={store.name}
              planId={planId}
              planName={planName}
            />
            <div className="flex flex-1 overflow-hidden">
              <DashboardSidebar groups={nav} />

              <div className="dash-main rounded-none md:rounded-tl-[16px] shadow-sm border-l-0 md:border-l border-t-0 md:border-t border-[#e5e5e5] overflow-hidden flex-1 relative flex flex-col mt-0 md:mt-2 ml-0 md:ml-2 mb-0 md:mb-2 mr-0 md:mr-2">
                <div className="dash-content flex-1 overflow-y-auto relative z-10">
                  {children}
                </div>
                {/* Full-view Mink AI takeover — overlays the content region only,
                  leaving the topbar + left nav visible (Shopify Sidekick). */}
                <DashboardChat variant="overlay" />
              </div>

              {/* Narrow side-panel Mink AI (topbar button). */}
              <DashboardChat variant="panel" />
            </div>
          </MobileNavProvider>
        </ChatProvider>
      </ImportRunnerProvider>

      <Toaster richColors />
    </div>
  );
}
