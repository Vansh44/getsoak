export const MINK_WORKFLOW_TEMPLATES = ["weekly_trading_report"] as const;
export type MinkWorkflowTemplate = (typeof MINK_WORKFLOW_TEMPLATES)[number];

export const MINK_WORKFLOW_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export type MinkWorkflowStatus = (typeof MINK_WORKFLOW_STATUSES)[number];

export interface WeeklyTradingReportInput {
  timeZone: string;
  currency: string;
  locationIds: string[];
  /** True when locationIds came from an explicit admin-location restriction. */
  restrictedLocationScope: boolean;
  includeUnassigned: boolean;
  locationLabel: string;
  /** Used only to re-check platform-operator access when a worker executes. */
  requesterEmail: string | null;
  requestedAt: string;
}

export interface WeeklyTradingReportSnapshot {
  rangeLabel: string;
  comparisonLabel: string | null;
  fromInclusive: string;
  toExclusive: string;
  timeZone: string;
  currency: string;
  locationLabel: string;
  netSales: number;
  netSalesTrendPercent: number | null;
  orders: number;
  ordersTrendPercent: number | null;
  averageOrderValue: number;
  averageOrderValueTrendPercent: number | null;
  unitsSold: number;
  unitsSoldTrendPercent: number | null;
  topProducts: Array<{
    id: string;
    name: string;
    units: number;
    amount: number;
    dashboardPath: string;
  }>;
  channels: Array<{
    key: string;
    name: string;
    amount: number;
    orders: number;
    share: number;
  }>;
  dataAsOf: string;
}

export interface WeeklyTradingReportResult extends WeeklyTradingReportSnapshot {
  highlights: string[];
  analyticsPath: string;
}

export interface MinkWorkflowEventView {
  id: string;
  type: string;
  stepKey: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface MinkWorkflowView {
  id: string;
  template: MinkWorkflowTemplate;
  status: MinkWorkflowStatus;
  currentStep: number;
  totalSteps: number;
  attemptCount: number;
  errorCode: string | null;
  errorDetail: string | null;
  cancelRequested: boolean;
  result: WeeklyTradingReportResult | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  events?: MinkWorkflowEventView[];
}

export function buildWeeklyTradingReportResult(
  snapshot: WeeklyTradingReportSnapshot,
): WeeklyTradingReportResult {
  const highlights: string[] = [];
  if (snapshot.orders === 0) {
    highlights.push("No recognized orders were recorded in this period.");
  } else if (snapshot.netSalesTrendPercent == null) {
    highlights.push(
      "Net-sales change is unavailable because the comparison period had no recognized sales.",
    );
  } else if (snapshot.netSalesTrendPercent <= -10) {
    highlights.push(
      `Net sales fell ${formatPercent(Math.abs(snapshot.netSalesTrendPercent))} versus the previous period.`,
    );
  } else if (snapshot.netSalesTrendPercent >= 10) {
    highlights.push(
      `Net sales grew ${formatPercent(snapshot.netSalesTrendPercent)} versus the previous period.`,
    );
  } else {
    highlights.push(
      `Net sales were broadly steady (${signedPercent(snapshot.netSalesTrendPercent)}) versus the previous period.`,
    );
  }

  const leader = snapshot.topProducts[0];
  if (leader) {
    highlights.push(
      `${leader.name} led unit sales with ${leader.units.toLocaleString("en-IN")} sold.`,
    );
  }
  const channel = snapshot.channels[0];
  if (channel && snapshot.channels.length > 1) {
    highlights.push(
      `${channel.name} was the largest sales channel at ${channel.share.toLocaleString("en-IN")}% of recognized net sales.`,
    );
  }

  return {
    ...snapshot,
    highlights: highlights.slice(0, 4),
    analyticsPath: "/dashboard/analytics?range=7d&compare=previous",
  };
}

export function isMinkWorkflowStatus(
  value: unknown,
): value is MinkWorkflowStatus {
  return MINK_WORKFLOW_STATUSES.includes(value as MinkWorkflowStatus);
}

function formatPercent(value: number): string {
  return `${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}

function signedPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}
