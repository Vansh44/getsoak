import type { Metadata } from "next";
import { requireStorefrontStoreId } from "@/lib/store/resolve";

// profile/page.tsx is a client component, so the host guard and metadata live
// here. A customer's own profile is personal and signed-in-only — noindex, not
// just Disallow, since the footer links it from every page.
export const metadata: Metadata = {
  title: "Your profile",
  robots: { index: false, follow: false },
};

export default async function ProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireStorefrontStoreId();
  return children;
}
