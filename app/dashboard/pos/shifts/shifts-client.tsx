"use client";

// Shift history + the Z-report, for the dashboard (roadmap Step 17).
//
// ★ VARIANCE IS THE COLUMN PEOPLE COME FOR. A shift list sorted by date with
// the money buried is a list nobody scans; over/short is the reason an owner
// opens this at all, so it is coloured and never truncated.

import { useState, useTransition } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { formatPrice } from "@/lib/pricing";
import {
  getShiftReport,
  type ShiftListRow,
} from "@/app/actions/pos-shift-actions";
import type { ShiftReport } from "@/app/actions/pos-shift-actions";

const VARIANCE_TONE: Record<string, string> = {
  over: "text-amber-700",
  short: "text-rose-700",
  ok: "text-emerald-700",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Kolkata",
      });
}

export function ShiftsClient({
  shifts,
  error,
}: {
  shifts: ShiftListRow[];
  error?: string;
}) {
  const [open, setOpen] = useState<ShiftReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const view = (id: string) => {
    setBusy(id);
    setDetailError(null);
    startTransition(async () => {
      try {
        const res = await getShiftReport(id);
        if (res.error) setDetailError(res.error);
        else setOpen(res.report ?? null);
      } catch {
        setDetailError("Couldn't load that shift.");
      } finally {
        setBusy(null);
      }
    });
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Shifts</h1>
          <p>Every drawer, across the shops you can see</p>
        </div>
      </header>

      <div className="dash-card flex flex-col">
        {error ? (
          <p className="p-6 text-sm text-muted-foreground">{error}</p>
        ) : shifts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-12 text-center text-muted-foreground">
            <RotateCcw className="h-6 w-6" />
            {/* Empty is ordinary for a store that has not opened a drawer yet,
                and should read that way rather than as a failure. */}
            <p className="text-sm">
              No shifts yet. They appear here once a till opens one.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Shop</th>
                  <th>Opened</th>
                  <th>Closed</th>
                  <th>Sales</th>
                  <th>Expected</th>
                  <th>Counted</th>
                  <th>Variance</th>
                  <th className="dash-col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.id}>
                    <td className="font-medium">{s.locationName}</td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {when(s.openedAt)}
                      {s.openedByName ? ` · ${s.openedByName}` : ""}
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {s.status === "open" ? (
                        <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                          Open now
                        </span>
                      ) : (
                        when(s.closedAt)
                      )}
                    </td>
                    <td className="tabular-nums">
                      {s.saleCount} · {formatPrice(s.grossSales)}
                    </td>
                    <td className="tabular-nums">
                      {formatPrice(s.expectedCash)}
                    </td>
                    <td className="tabular-nums">
                      {/* Null until close — an open drawer has not been
                          counted, which is not the same as counting zero. */}
                      {s.countedCash === null
                        ? "—"
                        : formatPrice(s.countedCash)}
                    </td>
                    <td
                      className={`tabular-nums font-medium ${
                        s.varianceState
                          ? (VARIANCE_TONE[s.varianceState] ?? "")
                          : ""
                      }`}
                    >
                      {s.variance === null ? "—" : formatPrice(s.variance)}
                    </td>
                    <td className="dash-col-actions">
                      <button
                        type="button"
                        disabled={busy === s.id}
                        onClick={() => view(s.id)}
                        className="dash-btn dash-btn-ghost"
                      >
                        {busy === s.id && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                        Z-report
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {detailError && (
          <p className="px-5 pb-4 text-sm text-rose-600">{detailError}</p>
        )}
      </div>

      {open && <ZReport report={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ZReport({
  report,
  onClose,
}: {
  report: ShiftReport;
  onClose: () => void;
}) {
  const rows: [string, number][] = [
    ["Opening float", report.openingFloat],
    ["Cash sales", report.cashSales],
    ["Cash refunds", -report.cashRefunds],
    ["Paid in", report.paidIn],
    ["Payouts", -report.payouts],
    ["Drops", -report.drops],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="dashboard-shell max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5">
        <header className="mb-3">
          <h2 className="text-base font-semibold">
            {report.locationName} ·{" "}
            {report.status === "open" ? "Open" : "Z-report"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {when(report.openedAt)} → {when(report.closedAt)}
            {report.closedByName ? ` · closed by ${report.closedByName}` : ""}
          </p>
        </header>

        {/* ★ THE WHOLE EQUATION, not just the answer. "Expected ₹1,895" is only
            trustworthy if you can see what fed it — the same reason /pos/shift
            shows it this way. */}
        <div className="rounded-lg border border-[var(--dash-border)]">
          {rows.map(([label, value], i) => (
            <div
              key={label}
              className={`flex justify-between px-3 py-2 text-sm ${
                i > 0 ? "border-t border-[var(--dash-border)]" : ""
              }`}
            >
              <span className="text-muted-foreground">{label}</span>
              <span className="tabular-nums">{formatPrice(value)}</span>
            </div>
          ))}
          <div className="flex justify-between border-t border-[var(--dash-border)] px-3 py-2 text-sm font-semibold">
            <span>Expected in drawer</span>
            <span className="tabular-nums">
              {formatPrice(report.expectedCash)}
            </span>
          </div>
          {report.countedCash !== null && (
            <>
              <div className="flex justify-between border-t border-[var(--dash-border)] px-3 py-2 text-sm">
                <span className="text-muted-foreground">Counted</span>
                <span className="tabular-nums">
                  {formatPrice(report.countedCash)}
                </span>
              </div>
              <div
                className={`flex justify-between border-t border-[var(--dash-border)] px-3 py-2 text-sm font-semibold ${
                  report.varianceState
                    ? (VARIANCE_TONE[report.varianceState] ?? "")
                    : ""
                }`}
              >
                <span>Variance</span>
                <span className="tabular-nums">
                  {formatPrice(report.variance ?? 0)}
                </span>
              </div>
            </>
          )}
        </div>

        {Object.keys(report.byMethod).length > 0 && (
          <div className="mt-4">
            <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
              Takings by method
            </h3>
            <div className="rounded-lg border border-[var(--dash-border)]">
              {Object.entries(report.byMethod).map(([method, amount], i) => (
                <div
                  key={method}
                  className={`flex justify-between px-3 py-2 text-sm ${
                    i > 0 ? "border-t border-[var(--dash-border)]" : ""
                  }`}
                >
                  <span className="capitalize text-muted-foreground">
                    {method.replace("_", " ")}
                  </span>
                  <span className="tabular-nums">{formatPrice(amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.movements.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
              Cash movements
            </h3>
            <div className="rounded-lg border border-[var(--dash-border)]">
              {report.movements.map((m, i) => (
                <div
                  key={m.id}
                  className={`flex justify-between px-3 py-2 text-sm ${
                    i > 0 ? "border-t border-[var(--dash-border)]" : ""
                  }`}
                >
                  <span className="text-muted-foreground">
                    <span className="capitalize">
                      {m.type.replace("_", " ")}
                    </span>
                    {m.reason ? ` · ${m.reason}` : ""}
                    {m.byName ? ` · ${m.byName}` : ""}
                  </span>
                  <span className="tabular-nums">{formatPrice(m.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {report.note && (
          <p className="mt-3 text-sm text-muted-foreground">{report.note}</p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="dash-btn dash-btn-primary mt-4 w-full"
        >
          Close
        </button>
      </div>
    </div>
  );
}
