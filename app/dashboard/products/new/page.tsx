import { requireSectionAccess } from "../../lib/access";
import { getProductCreateData } from "../data";
import { ProductEditorPanel } from "../product-edit-panel";

// Full-page "New product" editor (Shopify-style) — the same panel as editing,
// with no product row yet. A static segment, so it takes precedence over the
// sibling [id] dynamic route (product ids are UUIDs, never "new"). Creating
// requires manage.
export default async function ProductCreatePage() {
  await requireSectionAccess("products", "manage");
  const data = await getProductCreateData();

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
