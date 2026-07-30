import type { Metadata } from "next";
import Link from "next/link";
import { Inter } from "next/font/google";
import { HELP_URL } from "@/lib/site";
import { platformOrganizationSchema } from "@/lib/seo/brand-identity";
import { SEARCH_INDEXABLE } from "@/lib/store/host";
import "./help.css";

const helpFont = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dash",
});

export const metadata: Metadata = {
  metadataBase: new URL(HELP_URL),
  title: {
    default: "StoreMink Help Centre",
    template: "%s | StoreMink Help",
  },
  description:
    "Guides and answers for setting up and growing your online store on StoreMink — products, payments, domains, orders and more.",
  alternates: { canonical: "/help" },
  // Only production (storemink.com) is ever indexed — staging/dev help pages
  // are explicitly noindex, matching the SEARCH_INDEXABLE gate used by
  // robots.ts / sitemap.ts.
  ...(SEARCH_INDEXABLE ? {} : { robots: { index: false, follow: false } }),
};

// The help centre had NO Organization or WebSite node anywhere — only the
// category and article routes emitted JSON-LD. So every help article declared a
// publisher that resolved to nothing on this host, and a whole subdomain of
// first-party content contributed nothing to the StoreMink entity. Same @id as
// the apex (lib/seo/brand-identity.ts), so the two describe one entity rather
// than two.
const HELP_GRAPH = {
  "@context": "https://schema.org",
  "@graph": [
    platformOrganizationSchema(),
    {
      "@type": "WebSite",
      "@id": `${HELP_URL}/#website`,
      name: "StoreMink Help Centre",
      url: HELP_URL,
      publisher: { "@id": platformOrganizationSchema()["@id"] },
    },
  ],
};

export default function HelpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className={`hc ${helpFont.variable}`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(HELP_GRAPH) }}
      />
      <header className="hc-topbar">
        <div className="hc-wrap hc-topbar-inner">
          <Link href="/help" className="hc-logo">
            Store<span>Mink</span> Help
          </Link>
          <a
            href="https://storemink.com/signup"
            className="hc-topbar-cta"
            rel="noopener"
          >
            Create your store
          </a>
        </div>
      </header>

      {children}

      <footer className="hc-footer">
        <div className="hc-wrap">
          Can&apos;t find what you need? Email{" "}
          <a href="mailto:support@storemink.com">support@storemink.com</a>
          {" · "}
          <a href="https://storemink.com">storemink.com</a>
        </div>
      </footer>
    </div>
  );
}
