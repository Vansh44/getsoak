import { ROOT_DOMAIN } from "@/lib/store/host";

export type GoogleIndexingHealthState =
  | "unavailable"
  | "not_launched"
  | "waiting"
  | "ready"
  | "error";

export interface GoogleIndexingHealth {
  state: GoogleIndexingHealthState;
  origin: string | null;
  verification: "platform" | "pending" | "verified";
  verifiedAt: string | null;
  sitemap: "pending" | "submitted";
  sitemapSubmittedAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean || null;
}

function isPlatformOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`);
  } catch {
    return false;
  }
}

/** Turn the seven persisted Google keys into one stable merchant/operator
 * contract. Old status from a previous origin is never shown as current. */
export function deriveGoogleIndexingHealth(
  settings: Record<string, unknown>,
  origin: string | null,
  enabled: boolean,
): GoogleIndexingHealth {
  const launched = settings.launched !== false && settings.demo !== true;
  const platform = origin ? isPlatformOrigin(origin) : false;
  const verifiedAt = iso(settings.google_site_verified_at);
  const verifiedForOrigin =
    !platform &&
    settings.google_site_verification_domain === origin &&
    verifiedAt !== null;
  const sitemapSubmittedAt = iso(settings.google_sitemap_submitted_at);
  const sitemapForOrigin =
    settings.google_sitemap_submitted_origin === origin &&
    sitemapSubmittedAt !== null;
  const error = text(settings.google_indexing_error);

  const state: GoogleIndexingHealthState =
    !enabled || !origin
      ? "unavailable"
      : !launched
        ? "not_launched"
        : error
          ? "error"
          : sitemapForOrigin
            ? "ready"
            : "waiting";

  return {
    state,
    origin,
    verification: platform
      ? "platform"
      : verifiedForOrigin
        ? "verified"
        : "pending",
    verifiedAt: verifiedForOrigin ? verifiedAt : null,
    sitemap: sitemapForOrigin ? "submitted" : "pending",
    sitemapSubmittedAt: sitemapForOrigin ? sitemapSubmittedAt : null,
    lastAttemptAt: iso(settings.google_indexing_attempted_at),
    error,
  };
}
