import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth/server-user";
import { outstandingDocs } from "@/lib/legal/store";
import { getLegalDoc } from "@/lib/legal/documents";
import { PLATFORM_URL } from "@/lib/site";
import { AcceptForm } from "./accept-form";

// The re-acceptance screen: shown when a policy has been published at a new
// version since this person last agreed.
//
// WHY IT LIVES UNDER /auth AND NOT /dashboard. The dashboard layout is what
// redirects here — a route inside /dashboard would be wrapped by that same
// layout and redirect to itself forever. /auth is also where the analogous
// force_password_reset screen lives (/auth/set-password), and proxy.ts already
// treats these paths as "authenticated, but not yet allowed onward".
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Updated policies",
  robots: { index: false, follow: false },
};

export default async function PolicyUpdatePage() {
  const user = await getServerUser();
  if (!user) redirect("/auth/login");

  const outstanding = await outstandingDocs(user.id);

  // Nothing pending — they arrived by typing the URL, or accepted in another
  // tab. Don't show a consent screen for something already consented to.
  if (outstanding.length === 0) redirect("/dashboard");

  const docs = outstanding.map((doc) => {
    const def = getLegalDoc(doc.kind);
    return {
      kind: doc.kind,
      title: doc.title,
      version: doc.version,
      // Policies are platform-global and live on the platform host, so the
      // link out of a store subdomain has to be absolute.
      href: `${PLATFORM_URL}/legal/${def?.slug ?? doc.kind}`,
    };
  });

  return <AcceptForm docs={docs} email={user.email ?? null} />;
}
