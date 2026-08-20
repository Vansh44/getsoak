import { planAllows, type Plan } from "@/lib/plans";

// Platform-wide Analytics availability. These switches are controlled by a
// StoreMink operator; plan entitlement is evaluated separately so turning on a
// Pro module can never make it available to Free or Basic stores.
export const ANALYTICS_FEATURE_IDS = [
  "coreDashboard",
  "dashboardCustomization",
  "drilldownReports",
  "googleSearchConsole",
  "googleAnalytics4",
  "metaPixel",
  "storefrontConversion",
  "grossMargin",
] as const;

export type AnalyticsFeatureId = (typeof ANALYTICS_FEATURE_IDS)[number];

export interface AnalyticsFeatureMeta {
  id: AnalyticsFeatureId;
  label: string;
  description: string;
  minPlan?: Plan;
  status: "available" | "planned";
}

export const ANALYTICS_FEATURES: Record<
  AnalyticsFeatureId,
  AnalyticsFeatureMeta
> = {
  coreDashboard: {
    id: "coreDashboard",
    label: "Core analytics dashboard",
    description: "Sales, orders, customers, products and operations cards.",
    status: "available",
  },
  dashboardCustomization: {
    id: "dashboardCustomization",
    label: "Dashboard customization",
    description: "Add, remove, resize and reorder analytics cards.",
    status: "available",
  },
  drilldownReports: {
    id: "drilldownReports",
    label: "Drill-down reports and CSV",
    description: "Detailed reports for sales, products and search data.",
    status: "available",
  },
  googleSearchConsole: {
    id: "googleSearchConsole",
    label: "Google Search Console",
    description: "Google clicks, impressions, search terms and landing pages.",
    status: "available",
  },
  googleAnalytics4: {
    id: "googleAnalytics4",
    label: "Google Analytics 4",
    description: "Merchant GA4 Measurement ID and consent-aware tracking.",
    minPlan: "pro",
    status: "available",
  },
  metaPixel: {
    id: "metaPixel",
    label: "Meta Pixel",
    description: "Merchant Meta Pixel ID and consent-aware tracking.",
    minPlan: "pro",
    status: "available",
  },
  storefrontConversion: {
    id: "storefrontConversion",
    label: "Storefront conversion",
    description: "Visitors, sessions and the storefront conversion funnel.",
    minPlan: "pro",
    status: "available",
  },
  grossMargin: {
    id: "grossMargin",
    label: "Gross margin",
    description: "Product costs, gross profit and margin reporting.",
    minPlan: "pro",
    status: "planned",
  },
};

export type AnalyticsFeatureSettings = Record<AnalyticsFeatureId, boolean>;

export const DEFAULT_ANALYTICS_FEATURE_SETTINGS: AnalyticsFeatureSettings = {
  coreDashboard: true,
  dashboardCustomization: true,
  drilldownReports: true,
  googleSearchConsole: true,
  googleAnalytics4: false,
  metaPixel: false,
  storefrontConversion: false,
  grossMargin: false,
};

export function resolveAnalyticsFeatureSettings(
  raw: Partial<Record<AnalyticsFeatureId, unknown>> | null | undefined,
): AnalyticsFeatureSettings {
  return Object.fromEntries(
    ANALYTICS_FEATURE_IDS.map((id) => [
      id,
      typeof raw?.[id] === "boolean"
        ? raw[id]
        : DEFAULT_ANALYTICS_FEATURE_SETTINGS[id],
    ]),
  ) as AnalyticsFeatureSettings;
}

/** Global availability + merchant entitlement. */
export function analyticsFeatureAllowed(
  settings: AnalyticsFeatureSettings,
  feature: AnalyticsFeatureId,
  plan: Plan,
): boolean {
  return (
    settings[feature] && planAllows(plan, ANALYTICS_FEATURES[feature].minPlan)
  );
}
