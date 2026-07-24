import { redirect } from "next/navigation";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { getPlatformViewer } from "@/app/actions/platform";
import { DashboardTopbar } from "@/app/dashboard/dashboard-topbar";
import { DashboardSidebar } from "@/app/dashboard/dashboard-sidebar";
import { MobileNavProvider } from "@/app/dashboard/dashboard-mobile-nav";
import type { SectionGroup } from "@/app/dashboard/lib/permissions";
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

  const navGroups = [
    {
      group: "WORKSPACE" as SectionGroup,
      items: [
        { href: "/dashboard", label: "Stores", icon: "dashboard" as const },
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
          href: "/dashboard/operators",
          label: "Operators",
          icon: "users" as const,
        },
      ],
    },
  ];

  return (
    <div
      className={`dashboard-shell ${dashFont.variable} ${dashMono.variable} flex flex-col`}
    >
      <MobileNavProvider>
        <DashboardTopbar
          email={viewer.email}
          role={viewer.role}
          firstName=""
          lastName=""
        />
        <div className="flex flex-1 overflow-hidden">
          <DashboardSidebar groups={navGroups} />

          <div className="dash-main">
            <div className="dash-content">{children}</div>
          </div>
        </div>
      </MobileNavProvider>

      <Toaster richColors />
    </div>
  );
}
