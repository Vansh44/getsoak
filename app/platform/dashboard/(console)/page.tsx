import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerUser } from "@/lib/auth/server-user";
import { getPlatformViewer, listAllStores } from "@/app/actions/platform";
import { THEME_META } from "@/lib/themes/meta";
import { StoresConsole } from "./stores-console";
import { ThemesPanel } from "./themes-panel";
import { PricingPanel } from "./pricing-panel";
import { getPlanPricingLive } from "@/lib/plans/pricing";

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
  const stores = await listAllStores(q);

  // Which theme demo stores already exist (for the Themes panel).
  const demoSlugs = new Set(THEME_META.map((t) => t.demo.slug));
  const demoSlugsLive = stores
    .filter((s) => demoSlugs.has(s.slug))
    .map((s) => s.slug);

  return (
    <div className="w-full max-w-6xl space-y-8">
      <StoresConsole
        stores={stores}
        canManage={viewer.role === "superadmin"}
        email={viewer.email}
        q={q ?? ""}
        rootDomain={ROOT_DOMAIN}
      />
      {viewer.role === "superadmin" && (
        <>
          <PricingPanel pricing={await getPlanPricingLive()} />
          <ThemesPanel rootDomain={ROOT_DOMAIN} demoSlugsLive={demoSlugsLive} />
        </>
      )}
    </div>
  );
}
