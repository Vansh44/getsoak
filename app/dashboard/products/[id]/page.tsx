import { notFound } from "next/navigation";
import { requireSectionAccess } from "../../lib/access";
import { getProductEditData } from "../data";
import { ProductEditorPanel } from "../product-edit-panel";

// Full-page product editor (Shopify-style) — the only edit surface; the list
// navigates here directly. Editing requires manage.
export default async function ProductEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSectionAccess("products", "manage");
  const { id } = await params;
  const data = await getProductEditData(id);
  if (!data) notFound();

  return (
    <div className="dash-page-enter">
      <ProductEditorPanel
        product={data.product}
        categories={data.categories}
        colors={data.colors}
        taxClasses={data.taxClasses}
        canUseGrossMargin={data.canUseGrossMargin}
      />
    </div>
  );
}
