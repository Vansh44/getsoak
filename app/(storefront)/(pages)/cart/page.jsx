import CartClient from "./cart-client";
import { getStorefrontLayout } from "@/lib/store/storefront-layout";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import "./cart.css";

// Layout templates the title as "%s | {brand}", so keep it brand-neutral.
// noindex: a cart is per-visitor and empty to a crawler. robots.txt disallows it
// too (lib/seo/disallow.ts), but a Disallow only stops fetching — a URL linked
// from every page can still be indexed on its anchors alone.
export const metadata = {
  title: "Cart",
  robots: { index: false, follow: true },
};

export default async function Cart() {
  // See the note in enquiries/page.jsx — the layout guard does not abort a
  // concurrently-rendering child, so each page guards its own host.
  await requireStorefrontStoreId();
  const layout = await getStorefrontLayout();
  return <CartClient grocery={layout.cart === "grocery"} />;
}
