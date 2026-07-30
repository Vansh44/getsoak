import type { Metadata } from "next";
import { requireStorefrontStoreId } from "@/lib/store/resolve";

// page.tsx and success/page.tsx are client components, so the host guard and the
// metadata both live here — and a layout covers the whole /checkout subtree,
// including the invoice route, which sets its own noindex as well.
//
// noindex matters independently of robots.txt: a Disallow stops the fetch but
// not the indexing of a URL discovered through links, and a checkout URL in
// search results is both useless and a trust problem.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function CheckoutLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The (storefront) layout guards too, but its notFound() does not abort a
  // concurrently-rendering child — so an unclaimed subdomain could render a
  // working checkout against the fallback store. See CODEBASE.md §3.
  await requireStorefrontStoreId();
  return children;
}
