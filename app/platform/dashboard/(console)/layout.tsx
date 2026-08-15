import { redirect } from "next/navigation";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { getPlatformViewer } from "@/app/actions/platform";
import { DashboardTopbar } from "@/app/dashboard/dashboard-topbar";
import { DashboardSidebar } from "@/app/dashboard/dashboard-sidebar";
import { MobileNavProvider } from "@/app/dashboard/dashboard-mobile-nav";
import type { SectionGroup } from "@/app/dashboard/lib/permissions";
import { PLATFORM_LOG_TYPES } from "./logs/log-types";
import "@/app/dashboard/dashboard.css";

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
  return {
    title: `StoreMink Admin`,
    icons: { icon: "/brand/storemink-mark.png" },
  };
}

export default async function PlatformDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await getPlatformViewer();

  if (!viewer) {
    redirect("/dashboard/login");
  }

  // ── ★ THE CONSOLE'S IA, AND WHY IT IS GROUPED THIS WAY ───────────────────
  //
  // It used to be three entries, with the stores table, the pricing editor and
  // the theme seeder all stacked on the HOME page — so "look at one store" and
  // "reprice the Pro plan" were the same screen, and the home page grew a new
  // panel every time the platform did. Each of those is now a destination.
  //
  // The split is by JOB, the same rule `app/dashboard/lib/permissions.ts`
  // applies to the merchant nav: OPERATIONS is what an operator watches and
  // acts on daily (the merchant estate, the people in it, what broke, what we
  // announced); ADMINISTRATION is what gets configured once and then left
  // alone. Logs is deliberately in Operations rather than filed under
  // Administration — it is the first place anyone looks when something is
  // wrong, not a setting.
  const navGroups = [
    {
      group: "OPERATIONS" as SectionGroup,
      items: [
        { href: "/dashboard", label: "Overview", icon: "home" as const },
        { href: "/dashboard/stores", label: "Stores", icon: "pos" as const },
        {
          // Store owners, delegated dashboard staff and till staff, across
          // every store. The operator's question is "who has access?", and
          // until now it had no answer short of SQL against production.
          href: "/dashboard/people",
          label: "People",
          icon: "users" as const,
        },
        {
          // Email, SMS and the cross-store failure feed, behind one entry.
          // They used to be two top-level items with no relationship shown, so
          // "where do I look?" had two answers and no list of the rest.
          // Operations rather than Administration: this is where you look when
          // something is wrong, not a setting.
          href: "/dashboard/logs",
          label: "Logs",
          icon: "activity" as const,
        },
      ],
    },
    {
      group: "ADMINISTRATION" as SectionGroup,
      items: [
        {
          href: "/dashboard/help",
          label: "Help Centre",
          icon: "faq" as const,
        },
        {
          href: "/dashboard/themes",
          label: "Themes",
          icon: "homepage" as const,
        },
        {
          href: "/dashboard/pricing",
          label: "Pricing",
          icon: "plans" as const,
        },
        {
          href: "/dashboard/operators",
          label: "Operators",
          icon: "roles" as const,
        },
        {
          // StoreMink's OWN tax identity — what its subscription invoices say
          // and whether they charge GST. Administration rather than Operations:
          // it is configured once and then left alone.
          href: "/dashboard/billing",
          label: "Billing & tax",
          icon: "billing" as const,
        },
      ],
    },
  ];

  return (
    <div
      // See app/dashboard/layout.tsx: `dashboard-shell` is the token/component
      // scope, `dashboard-frame` is the 100vh page frame.
      className={`dashboard-shell dashboard-frame ${dashFont.variable} ${dashMono.variable} flex flex-col`}
    >
      <MobileNavProvider>
        <DashboardTopbar
          email={viewer.email}
          role={viewer.role}
          firstName=""
          lastName=""
        />
        <div className="flex flex-1 overflow-hidden">
          {/* The operator log registry, not the merchant one: this console has
              no import/export jobs and no per-store activity feed, and its
              failure feed spans every store. */}
          <DashboardSidebar groups={navGroups} logTypes={PLATFORM_LOG_TYPES} />

          <div className="dash-main">
            <div className="dash-content">{children}</div>
          </div>
        </div>
      </MobileNavProvider>

      <Toaster richColors />
    </div>
  );
}
