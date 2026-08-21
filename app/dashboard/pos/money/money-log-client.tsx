"use client";

// The POS money log (roadmap Step 14).
//
// ── What this page is for ──────────────────────────────────────────────────
// The AMOUNTS were never missing — orders, order_items and order_refunds all
// carry them. What was missing is who performed the act and, above all, WHO
// APPROVED it. So the approver is a column here, not a detail-string aside: it
// is the reason the page exists.
//
// ★ ONE FEED FOR FOUR EVENTS. A discount, a price override, a till refund and
// cash out of the drawer are the four ways money leaves without goods leaving
// with it. Reading them together is how "what happened to the money today" is
// answerable without joining three tables.

import { useMemo, useState } from "react";
import { formatPrice } from "@/lib/pricing";
import type { PosActivityRow } from "@/app/actions/pos-auth-actions";

const EVENT_META: Record<string, { label: string; tone: string }> = {
  sale_discount: { label: "Discount", tone: "bg-amber-50 text-amber-700" },
  price_override: {
    label: "Price override",
    tone: "bg-violet-50 text-violet-700",
  },
  refund_issued: { label: "Refund", tone: "bg-rose-50 text-rose-700" },
  cash_movement: { label: "Cash", tone: "bg-sky-50 text-sky-700" },
};

const FILTERS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "sale_discount", label: "Discounts" },
  { key: "price_override", label: "Overrides" },
  { key: "refund_issued", label: "Refunds" },
  { key: "cash_movement", label: "Cash" },
];

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      });
}

export function MoneyLogClient({
  events,
  error,
  locations,
}: {
  events: PosActivityRow[];
  error?: string;
  locations: { id: string; name: string }[];
}) {
  const [filter, setFilter] = useState("");
  const locName = (id: string | null) =>
    locations.find((l) => l.id === id)?.name ?? "";

  const rows = useMemo(
    () => (filter ? events.filter((e) => e.event === filter) : events),
    [events, filter],
  );

  // ★ Given away MINUS taken in. A paid-in carries a negative amount, so this
  // is the shop's net exposure for the period rather than a gross that reads
  // alarmingly high the moment anyone banks the float.
  const net = useMemo(
    () => rows.reduce((sum, e) => sum + (e.amount ?? 0), 0),
    [rows],
  );

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Money log</h1>
          <p>Who discounted, overrode a price, refunded or moved cash</p>
        </div>
      </header>

      <div className="dash-card flex flex-col">
        <div className="dash-toolbar flex flex-wrap items-center gap-3 border-b border-[var(--dash-border)] px-5 pt-4 pb-2">
          <div className="dash-filter-tabs">
            {FILTERS.map((f) => (
              <button
                key={f.key || "all"}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`dash-filter-tab${filter === f.key ? " active" : ""}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {rows.length > 0 && (
            <span className="ml-auto text-sm text-muted-foreground">
              Net out:{" "}
              <span className="font-medium tabular-nums text-foreground">
                {formatPrice(net)}
              </span>
            </span>
          )}
        </div>

        {error ? (
          <p className="p-6 text-sm text-muted-foreground">{error}</p>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">
            {/* Empty is the GOOD state here, and it should read that way rather
                than as a broken page. */}
            Nothing yet. Discounts, price overrides, refunds and cash movements
            at the till appear here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Amount</th>
                  <th>By</th>
                  <th>Approved by</th>
                  <th>Location</th>
                  <th>Detail</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const meta = EVENT_META[e.event] ?? {
                    label: e.event,
                    tone: "bg-gray-100 text-gray-700",
                  };
                  const amount = e.amount ?? 0;
                  return (
                    <tr key={e.id}>
                      <td>
                        <span
                          className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${meta.tone}`}
                        >
                          {meta.label}
                        </span>
                      </td>
                      <td className="tabular-nums font-medium">
                        {/* A negative amount came IN — cash paid into the
                            drawer, or a price revised upward. Shown as such
                            rather than hidden behind an absolute value. */}
                        {amount < 0
                          ? `+${formatPrice(Math.abs(amount))}`
                          : formatPrice(amount)}
                      </td>
                      <td>{e.actor ?? "—"}</td>
                      <td>
                        {e.approver ? (
                          <span className="font-medium">{e.approver}</span>
                        ) : (
                          // Not a gap: most acts need no second person. Saying
                          // so beats an empty cell that reads as missing data.
                          <span className="text-muted-foreground">
                            Not required
                          </span>
                        )}
                      </td>
                      <td className="text-muted-foreground">
                        {locName(e.locationId) || "—"}
                      </td>
                      <td className="max-w-[22rem] truncate text-muted-foreground">
                        {e.detail ?? "—"}
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground">
                        {when(e.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
