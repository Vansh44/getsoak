import { requireSectionAccess } from "../../lib/access";
import { getProductCreateData } from "../data";
import { ProductEditorPanel } from "../product-edit-panel";
import Link from "next/link";

// Full-page "New product" editor (Shopify-style) — the same panel as editing,
// with no product row yet. A static segment, so it takes precedence over the
// sibling [id] dynamic route (product ids are UUIDs, never "new"). Creating
// requires manage.
export default async function ProductCreatePage() {
  await requireSectionAccess("products", "manage");
  const data = await getProductCreateData();

  if (!data.canCreateProduct) {
    return (
      <div className="dash-page-enter max-w-2xl">
        <div className="dash-card p-6">
          <h1 className="text-xl font-semibold">Product limit reached</h1>
          <p className="mt-2 text-sm text-[var(--dash-muted)]">
            Your {data.plan === "free" ? "Free" : "Basic"} plan includes up to{" "}
            {data.productLimit} products. Your {data.productCount} existing
            products are safe and remain editable. Upgrade to add another.
          </p>
          <div className="mt-5 flex gap-2">
            <Link href="/dashboard/plans" className="dash-btn dash-btn-primary">
              View plans
            </Link>
            <Link href="/dashboard/products" className="dash-btn">
              Back to products
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dash-page-enter">
      <ProductEditorPanel
        product={null}
        categories={data.categories}
        colors={data.colors}
        taxClasses={data.taxClasses}
        defaultTrackInventory={data.defaultTrackInventory}
        canUseGrossMargin={data.canUseGrossMargin}
      />
    </div>
  );
}
