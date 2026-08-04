import "server-only";

import { eq, sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import {
  addGoogleSearchConsoleSite,
  pingIndexNow,
  requestGoogleSiteVerificationToken,
  submitSitemapToGoogle,
  verifyGoogleSite,
} from "@/lib/seo/search-engines";
import { storeOrigin } from "@/lib/site";
import { ROOT_DOMAIN, SEARCH_INDEXABLE } from "@/lib/store/host";
import { isStoreLaunched, markStoreLaunched } from "@/lib/store/launch";
import { STORE_TAG, type Store } from "@/lib/store/resolve";

// Public verification/status data lives in stores.settings. The Google meta
// token is intentionally public (Google must read it from <head>); none of
// these values are credentials.
export const GOOGLE_VERIFICATION_TOKEN_KEY = "google_site_verification_token";
const GOOGLE_VERIFICATION_DOMAIN_KEY = "google_site_verification_domain";
const GOOGLE_VERIFIED_AT_KEY = "google_site_verified_at";
const GOOGLE_SITEMAP_SUBMITTED_AT_KEY = "google_sitemap_submitted_at";
const GOOGLE_SITEMAP_SUBMITTED_ORIGIN_KEY = "google_sitemap_submitted_origin";
const GOOGLE_INDEXING_ATTEMPTED_AT_KEY = "google_indexing_attempted_at";
const GOOGLE_INDEXING_ERROR_KEY = "google_indexing_error";

export const GOOGLE_INDEXING_SETTINGS_KEYS = [
  GOOGLE_VERIFICATION_TOKEN_KEY,
  GOOGLE_VERIFICATION_DOMAIN_KEY,
  GOOGLE_VERIFIED_AT_KEY,
  GOOGLE_SITEMAP_SUBMITTED_AT_KEY,
  GOOGLE_SITEMAP_SUBMITTED_ORIGIN_KEY,
  GOOGLE_INDEXING_ATTEMPTED_AT_KEY,
  GOOGLE_INDEXING_ERROR_KEY,
] as const;

type StoreIndexingRow = Store;

export interface StoreIndexingResult {
  ok: boolean;
  skipped?: boolean;
  origin?: string;
  error?: string;
}

async function readStore(storeId: string): Promise<StoreIndexingRow | null> {
  const rows = await withService((db) =>
    db
      .select({
        id: stores.id,
        slug: stores.slug,
        name: stores.name,
        status: stores.status,
        plan: stores.plan,
        plan_expires_at: stores.planExpiresAt,
        custom_domain: stores.customDomain,
        settings: stores.settings,
      })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  return (rows[0] as StoreIndexingRow | undefined) ?? null;
}

/** Merge only the indexing keys into settings so concurrent branding/domain
 * writes cannot be overwritten by an old read-modify-write snapshot. */
async function patchIndexingSettings(
  storeId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  await withService((db) =>
    db
      .update(stores)
      .set({
        settings: sql`COALESCE(${stores.settings}, '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb`,
      })
      .where(eq(stores.id, storeId)),
  );
  revalidateTag(STORE_TAG, "max");
}

function errorText(error: string): string {
  return error.replace(/\s+/g, " ").slice(0, 500);
}

function isPlatformSubdomain(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`);
}

function isRecentIso(value: unknown, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp < maxAgeMs;
}

/**
 * Make one launched store manageable by Google Search Console and register its
 * sitemap. Idempotent and safe to call after every first publish plus from the
 * daily reconciliation job.
 *
 * StoreMink subdomains are already owned by the platform Domain property.
 * Custom domains are different sites, so they get an official META ownership
 * token, a URL-prefix property, and their own sitemap submission.
 */
export async function ensureGoogleCoverageForStore(
  storeId: string,
): Promise<StoreIndexingResult> {
  if (!SEARCH_INDEXABLE) return { ok: true, skipped: true };

  const attemptedAt = new Date().toISOString();
  try {
    const store = await readStore(storeId);
    if (
      !store ||
      store.status !== "active" ||
      !isStoreLaunched(store) ||
      store.settings?.demo === true
    ) {
      return { ok: true, skipped: true };
    }

    const origin = storeOrigin(store);
    const sitemapUrl = `${origin}/sitemap.xml`;
    const settings = store.settings ?? {};

    // The verified sc-domain:storemink.com property covers every tenant
    // subdomain. No per-subdomain ownership flow or property is needed.
    if (isPlatformSubdomain(origin)) {
      if (
        settings[GOOGLE_SITEMAP_SUBMITTED_ORIGIN_KEY] === origin &&
        isRecentIso(settings[GOOGLE_SITEMAP_SUBMITTED_AT_KEY])
      ) {
        return { ok: true, origin };
      }
      const result = await submitSitemapToGoogle(sitemapUrl);
      await patchIndexingSettings(storeId, {
        [GOOGLE_INDEXING_ATTEMPTED_AT_KEY]: attemptedAt,
        [GOOGLE_SITEMAP_SUBMITTED_AT_KEY]: result.ok
          ? attemptedAt
          : store.settings?.[GOOGLE_SITEMAP_SUBMITTED_AT_KEY],
        [GOOGLE_SITEMAP_SUBMITTED_ORIGIN_KEY]: result.ok
          ? origin
          : store.settings?.[GOOGLE_SITEMAP_SUBMITTED_ORIGIN_KEY],
        [GOOGLE_INDEXING_ERROR_KEY]: result.ok ? null : errorText(result.error),
      });
      return result.ok
        ? { ok: true, origin }
        : { ok: false, origin, error: result.error };
    }

    // URL-prefix properties require a trailing slash and match one protocol.
    const property = `${origin}/`;
    const tokenMatchesDomain =
      settings[GOOGLE_VERIFICATION_DOMAIN_KEY] === origin &&
      typeof settings[GOOGLE_VERIFICATION_TOKEN_KEY] === "string";
    if (
      tokenMatchesDomain &&
      typeof settings[GOOGLE_VERIFIED_AT_KEY] === "string" &&
      settings[GOOGLE_SITEMAP_SUBMITTED_ORIGIN_KEY] === origin &&
      isRecentIso(settings[GOOGLE_SITEMAP_SUBMITTED_AT_KEY])
    ) {
      return { ok: true, origin };
    }

    if (!tokenMatchesDomain) {
      const requested = await requestGoogleSiteVerificationToken(property);
      if (!requested.result.ok || !requested.token) {
        const error = requested.result.ok
          ? "Site Verification returned no token"
          : requested.result.error;
        await patchIndexingSettings(storeId, {
          [GOOGLE_INDEXING_ATTEMPTED_AT_KEY]: attemptedAt,
          [GOOGLE_INDEXING_ERROR_KEY]: errorText(error),
        });
        return { ok: false, origin, error };
      }

      // Persist before asking Google to verify: the storefront metadata reads
      // this value and emits <meta name="google-site-verification">.
      await patchIndexingSettings(storeId, {
        [GOOGLE_VERIFICATION_TOKEN_KEY]: requested.token,
        [GOOGLE_VERIFICATION_DOMAIN_KEY]: origin,
        [GOOGLE_VERIFIED_AT_KEY]: null,
        [GOOGLE_INDEXING_ATTEMPTED_AT_KEY]: attemptedAt,
        [GOOGLE_INDEXING_ERROR_KEY]: null,
      });
    }

    const alreadyVerified =
      settings[GOOGLE_VERIFICATION_DOMAIN_KEY] === origin &&
      typeof settings[GOOGLE_VERIFIED_AT_KEY] === "string";
    if (!alreadyVerified) {
      const verified = await verifyGoogleSite(property);
      if (!verified.ok) {
        await patchIndexingSettings(storeId, {
          [GOOGLE_INDEXING_ATTEMPTED_AT_KEY]: attemptedAt,
          [GOOGLE_INDEXING_ERROR_KEY]: errorText(verified.error),
        });
        return { ok: false, origin, error: verified.error };
      }
      await patchIndexingSettings(storeId, {
        [GOOGLE_VERIFIED_AT_KEY]: attemptedAt,
        [GOOGLE_INDEXING_ERROR_KEY]: null,
      });
    }

    const added = await addGoogleSearchConsoleSite(property);
    if (!added.ok) {
      await patchIndexingSettings(storeId, {
        [GOOGLE_INDEXING_ATTEMPTED_AT_KEY]: attemptedAt,
        [GOOGLE_INDEXING_ERROR_KEY]: errorText(added.error),
        [GOOGLE_VERIFIED_AT_KEY]:
          added.status === 401 || added.status === 403
            ? null
            : settings[GOOGLE_VERIFIED_AT_KEY],
      });
      return { ok: false, origin, error: added.error };
    }

    const submitted = await submitSitemapToGoogle(sitemapUrl, property);
    await patchIndexingSettings(storeId, {
      [GOOGLE_INDEXING_ATTEMPTED_AT_KEY]: attemptedAt,
      [GOOGLE_SITEMAP_SUBMITTED_AT_KEY]: submitted.ok
        ? attemptedAt
        : settings[GOOGLE_SITEMAP_SUBMITTED_AT_KEY],
      [GOOGLE_SITEMAP_SUBMITTED_ORIGIN_KEY]: submitted.ok
        ? origin
        : settings[GOOGLE_SITEMAP_SUBMITTED_ORIGIN_KEY],
      [GOOGLE_INDEXING_ERROR_KEY]: submitted.ok
        ? null
        : errorText(submitted.error),
      [GOOGLE_VERIFIED_AT_KEY]:
        !submitted.ok && (submitted.status === 401 || submitted.status === 403)
          ? null
          : (settings[GOOGLE_VERIFIED_AT_KEY] ?? attemptedAt),
    });
    if (!submitted.ok) {
      return { ok: false, origin, error: submitted.error };
    }

    logInfo("Google coverage ready for store", { storeId, origin });
    return { ok: true, origin };
  } catch (err) {
    const error =
      err instanceof Error
        ? err.message
        : "Store indexing reconciliation failed";
    logError("ensureGoogleCoverageForStore failed", err, { storeId });
    await patchIndexingSettings(storeId, {
      [GOOGLE_INDEXING_ATTEMPTED_AT_KEY]: attemptedAt,
      [GOOGLE_INDEXING_ERROR_KEY]: errorText(error),
    }).catch((patchErr) =>
      logWarn("Failed to persist Google indexing error", {
        storeId,
        error: patchErr instanceof Error ? patchErr.message : String(patchErr),
      }),
    );
    return { ok: false, error };
  }
}

/** One publish hook for products, blogs, and builder pages. The database write
 * has already committed, so all discovery work is best-effort and retryable. */
export async function notifyStoreContentPublished(input: {
  storeId: string;
  paths: string[];
}): Promise<void> {
  await markStoreLaunched(input.storeId);
  const store = await readStore(input.storeId).catch(() => null);
  if (!store) return;
  const origin = storeOrigin(store);
  const urls = [...new Set(input.paths)].map((path) => {
    const normalized = path === "/" ? "/" : `/${path.replace(/^\/+/, "")}`;
    return `${origin}${normalized}`;
  });
  await Promise.allSettled([
    pingIndexNow(urls),
    ensureGoogleCoverageForStore(input.storeId),
  ]);
}
