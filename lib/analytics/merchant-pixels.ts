// Pure merchant-pixel settings contract. IDs live in stores.settings.marketing
// because they configure the public storefront, while platform availability
// and plan entitlement remain separate gates in lib/analytics/features.ts.

export const MERCHANT_MARKETING_SETTINGS_KEY = "marketing";

export interface MerchantPixelSettings {
  ga4MeasurementId: string;
  ga4Enabled: boolean;
  metaPixelId: string;
  metaPixelEnabled: boolean;
}

export const EMPTY_MERCHANT_PIXEL_SETTINGS: MerchantPixelSettings = {
  ga4MeasurementId: "",
  ga4Enabled: false,
  metaPixelId: "",
  metaPixelEnabled: false,
};

// GA4 web-stream Measurement IDs use G- followed by uppercase letters/numbers.
// Meta Pixel/dataset IDs are numeric. Bounds reject obvious scripts, pasted
// snippets and account URLs while allowing the providers' current ID lengths.
export const GA4_MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;
export const META_PIXEL_ID_PATTERN = /^\d{5,25}$/;

export function normalizeGa4MeasurementId(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function normalizeMetaPixelId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isValidGa4MeasurementId(value: string): boolean {
  return GA4_MEASUREMENT_ID_PATTERN.test(value);
}

export function isValidMetaPixelId(value: string): boolean {
  return META_PIXEL_ID_PATTERN.test(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Invalid legacy values resolve disabled and are never rendered into scripts. */
export function resolveMerchantPixelSettings(
  storeSettings: Record<string, unknown> | null | undefined,
): MerchantPixelSettings {
  const marketing = record(storeSettings?.[MERCHANT_MARKETING_SETTINGS_KEY]);
  const ga4MeasurementId = normalizeGa4MeasurementId(
    marketing.ga4MeasurementId,
  );
  const metaPixelId = normalizeMetaPixelId(marketing.metaPixelId);
  const validGa4 = isValidGa4MeasurementId(ga4MeasurementId);
  const validMeta = isValidMetaPixelId(metaPixelId);

  return {
    ga4MeasurementId: validGa4 ? ga4MeasurementId : "",
    ga4Enabled: validGa4 && marketing.ga4Enabled === true,
    metaPixelId: validMeta ? metaPixelId : "",
    metaPixelEnabled: validMeta && marketing.metaPixelEnabled === true,
  };
}
