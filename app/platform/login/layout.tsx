import type { Metadata } from "next";

// The platform-operator sign-in screen. It has no search value, and it was
// inheriting the platform layout's metadata — serving the homepage's exact title
// and og:url from a third URL. robots.txt disallows it (lib/seo/disallow.ts), but
// a Disallow only stops crawling: a linked URL can still be indexed from its
// anchors alone. The noindex here is what actually keeps it out.
export const metadata: Metadata = {
  title: "Sign in — StoreMink",
  robots: { index: false, follow: false },
  alternates: { canonical: "/login" },
};

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
