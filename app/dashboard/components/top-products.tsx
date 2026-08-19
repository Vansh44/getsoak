import type { TopProduct } from "../analytics/data";

export function TopProducts({ items }: { items: TopProduct[] }) {
  return (
    <div className="dash-card h-full">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">Top products</div>
          <div className="dash-card-sub">Ranked by units sold</div>
        </div>
      </div>
      <div className="dash-card-body">
        {items.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-[var(--dash-text-3)]">
            No products sold in this range.
          </div>
        ) : (
          <div className="dash-product-list">
            {items.map((item, index) => (
              <div key={item.id} className="dash-product-row">
                <span className="dash-product-rank">{index + 1}</span>
                <span className="dash-product-name">{item.name}</span>
                <span className="dash-product-units">
                  {item.units.toLocaleString("en-IN")} units
                </span>
                <span className="dash-product-sales">
                  ₹{Math.round(item.amount).toLocaleString("en-IN")}
                </span>
              </div>
            ))}
          </div>
        )}
        {items.length > 0 ? (
          <p className="dash-cat-note">
            Merchandise totals before order-level discounts, tax, and refunds.
          </p>
        ) : null}
      </div>
    </div>
  );
}
