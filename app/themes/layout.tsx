import type { Metadata } from "next";
import { THEMES_URL } from "@/lib/site";
import "./themes.css";

const DESCRIPTION =
  "Explore professionally designed StoreMink themes for distinctive online stores. Every published theme is commerce-tested, responsive, and fully editable.";

export const metadata: Metadata = {
  metadataBase: new URL(THEMES_URL),
  title: "StoreMink Themes — Professional storefronts, ready to make yours",
  description: DESCRIPTION,
  applicationName: "StoreMink Themes",
  alternates: { canonical: "/" },
  openGraph: {
    title: "StoreMink Themes",
    description: DESCRIPTION,
    url: "/",
    siteName: "StoreMink Themes",
    type: "website",
    images: [
      {
        url: "/themes/catalog-og.png",
        width: 1200,
        height: 630,
        alt: "StoreMink Themes — Make your store feel like your brand.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "StoreMink Themes",
    description: DESCRIPTION,
    images: ["/themes/catalog-og.png"],
  },
};

export default function ThemesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="sm-themes">{children}</div>;
}
