import type { Metadata } from "next";

// page.tsx is a client component (the signup wizard), so its metadata lives
// here. Without this it inherited the platform layout's metadata wholesale and
// served the homepage's exact title + og:url — two URLs claiming to be the same
// page, one of which app/sitemap.ts submits.
export const metadata: Metadata = {
  title: "Create your store — StoreMink",
  description:
    "Set up your online store on StoreMink in minutes. Pick a template, add products, and start selling. Free plan available, no transaction fees.",
  alternates: { canonical: "/signup" },
  openGraph: {
    title: "Create your store — StoreMink",
    description:
      "Set up your online store on StoreMink in minutes. Free plan available, no transaction fees.",
    url: "/signup",
  },
};

export default function SignupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
