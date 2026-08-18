export interface AnalyticsSummaryItem {
  label: string;
  value: number;
  format?: "number" | "currency" | "percent";
}

function formatValue(item: AnalyticsSummaryItem): string {
  if (item.format === "percent") return `${item.value.toFixed(1)}%`;
  const value = Math.round(item.value).toLocaleString("en-IN");
  return item.format === "currency" ? `₹${value}` : value;
}

export function AnalyticsSummaryCard({
  title,
  subtitle,
  items,
  note,
}: {
  title: string;
  subtitle: string;
  items: AnalyticsSummaryItem[];
  note?: string;
}) {
  return (
    <div className="dash-card h-full">
      <div className="dash-card-header">
        <div>
          <div className="dash-card-title">{title}</div>
          <div className="dash-card-sub">{subtitle}</div>
        </div>
      </div>
      <div className="dash-card-body">
        <div className="dash-summary-grid">
          {items.map((item) => (
            <div key={item.label} className="dash-summary-item">
              <span>{item.label}</span>
              <strong>{formatValue(item)}</strong>
            </div>
          ))}
        </div>
        {note ? <p className="dash-cat-note">{note}</p> : null}
      </div>
    </div>
  );
}
