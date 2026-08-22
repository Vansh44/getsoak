import type { InventoryVelocityItem } from "../analytics/data";

export function InventoryVelocity({
  items,
}: {
  items: InventoryVelocityItem[];
}) {
  const max = items.reduce((value, item) => Math.max(value, item.units), 0);
  return (
    <div className="dash-card h-full">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">Inventory velocity</div>
          <div className="dash-card-sub">Tracked units sold from stock</div>
        </div>
      </div>
      <div className="dash-card-body">
        {items.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-[var(--dash-text-3)]">
            No tracked stock moved through recognized sales in this range.
          </div>
        ) : (
          <div className="dash-cat-list">
            {items.map((item) => (
              <div key={item.id} className="dash-progress-row">
                <div className="dash-progress-label">
                  <span className="truncate">{item.name}</span>
                  <span className="tabular-nums text-[var(--dash-text-2)]">
                    {item.units.toLocaleString("en-IN")} units
                  </span>
                </div>
                <div className="dash-progress-track">
                  <div
                    className="dash-progress-fill"
                    style={{
                      width: `${max > 0 ? Math.round((item.units / max) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="dash-cat-note">
          Tracked inventory only; untracked products have no stock ledger move.
        </p>
      </div>
    </div>
  );
}
