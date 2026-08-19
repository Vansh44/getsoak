import type { CommerceBreakdown as CommerceBreakdownItem } from "../analytics/data";

export function CommerceBreakdown({
  title,
  subtitle,
  items,
}: {
  title: string;
  subtitle: string;
  items: CommerceBreakdownItem[];
}) {
  const max = items.reduce((value, item) => Math.max(value, item.amount), 0);
  return (
    <div className="dash-card h-full">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">{title}</div>
          <div className="dash-card-sub">{subtitle}</div>
        </div>
      </div>
      <div className="dash-card-body">
        {items.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-[var(--dash-text-3)]">
            No recognized sales in this range.
          </div>
        ) : (
          <div className="dash-cat-list">
            {items.map((item) => (
              <div key={item.key} className="dash-progress-row">
                <div className="dash-progress-label">
                  <span className="truncate">{item.name}</span>
                  <span className="tabular-nums text-[var(--dash-text-2)]">
                    ₹{Math.round(item.amount).toLocaleString("en-IN")}
                  </span>
                </div>
                <div className="dash-progress-track">
                  <div
                    className="dash-progress-fill"
                    style={{
                      width: `${Math.max(0, item.share)}%`,
                      opacity:
                        max > 0
                          ? 0.4 + 0.6 * Math.max(0, item.amount / max)
                          : 0.3,
                    }}
                  />
                </div>
                <div className="dash-breakdown-meta">
                  {item.orders.toLocaleString("en-IN")} orders · {item.share}%
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
