import "server-only";
import crypto from "node:crypto";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { SEARCH_INDEXABLE } from "@/lib/store/host";

// Search-engine notification: tell crawlers about new/changed URLs so a store
// is discovered and re-indexed quickly, instead of waiting for organic crawl.
//
// Two independent, best-effort channels — each no-ops safely until its config
// is present, and NEITHER ever throws (a failure must never break the store
// action that triggered it). Callers fire these via `after()` so the user's
// response isn't blocked. BOTH are gated on SEARCH_INDEXABLE, so staging /
// previews (which run as NODE_ENV=production on Cloud Run) never ping with
// non-production URLs.
//
//   • IndexNow  → Bing, Yandex, Naver, Seznam (NOT Google). No account/setup
//                 beyond the public key file at /{key}.txt (public/). Active in
//                 production out of the box.
//   • Google    → Search Console `sitemaps.submit`, scoped to
//                 GOOGLE_SEARCH_CONSOLE_PROPERTY (e.g. "sc-domain:storemink.com").
//                 Auth is either the runtime service account via Application
//                 Default Credentials (Cloud Run — nothing to store; just grant
//                 that SA access to the property in Search Console) OR an
//                 explicit service-account key in GOOGLE_SEARCH_CONSOLE_CREDENTIALS
//                 (JSON, for local/non-GCP hosts). Dormant until the property is set.

// Public IndexNow key. Served verbatim at public/<key>.txt so the search engine
// can confirm ownership. Overridable via env, but the file must match.
export const INDEXNOW_KEY =
  process.env.INDEXNOW_KEY ?? "3b7d8ad31a67d0ae436d04d13a099b6c";

const TIMEOUT_MS = 5000;

export type SearchEngineResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string; skipped?: boolean };

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── IndexNow ───────────────────────────────────────────────────────────────

// The IndexNow POST body. All urlList entries must share one host, which is
// declared as `host` + `keyLocation`. Pure so it can be unit-tested.
export function indexNowPayload(host: string, urls: string[]) {
  return {
    host,
    key: INDEXNOW_KEY,
    keyLocation: `https://${host}/${INDEXNOW_KEY}.txt`,
    urlList: urls,
  };
}

// Notify IndexNow that these URLs changed. Best-effort, bounded, never throws.
// Skipped unless the build is the indexable production platform (staging /
// preview / dev hosts aren't meant to be indexed), so it never pings with
// non-production URLs; set INDEXNOW_FORCE=1 to override for local testing.
export async function pingIndexNow(urls: string[]): Promise<void> {
  const https = [...new Set(urls.filter((u) => u.startsWith("https://")))];
  if (!https.length) return;
  if (!SEARCH_INDEXABLE && !process.env.INDEXNOW_FORCE) {
    return;
  }
  // IndexNow accepts URLs for exactly one host per payload. Callers normally
  // pass one store, but grouping here prevents a future batch/reconciliation
  // caller from silently dropping every host after the first one.
  const byHost = new Map<string, string[]>();
  for (const url of https) {
    try {
      const host = new URL(url).host;
      byHost.set(host, [...(byHost.get(host) ?? []), url]);
    } catch {
      // Invalid URLs are ignored; one malformed entry must not drop the batch.
    }
  }
  await Promise.allSettled(
    [...byHost].map(async ([host, hostUrls]) => {
      try {
        const res = await fetchWithTimeout(
          "https://api.indexnow.org/indexnow",
          {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify(indexNowPayload(host, hostUrls)),
          },
        );
        if (!res.ok) {
          logWarn("pingIndexNow rejected", { host, status: res.status });
        }
      } catch (err) {
        logError("pingIndexNow failed", err, { host });
      }
    }),
  );
}

// ── Google Search Console ────────────────────────────────────────────────────

interface GoogleCreds {
  client_email: string;
  private_key: string;
}

function loadGoogleCreds(): GoogleCreds | null {
  const raw = process.env.GOOGLE_SEARCH_CONSOLE_CREDENTIALS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.client_email === "string" &&
      typeof parsed.private_key === "string"
    ) {
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

// The Search Console sitemaps.submit endpoint (PUT, empty body) for a sitemap
// under a verified property. Pure so it can be unit-tested.
export function googleSitemapEndpoint(
  property: string,
  sitemapUrl: string,
): string {
  return `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
    property,
  )}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
}

export const WEBMASTERS_SCOPE = "https://www.googleapis.com/auth/webmasters";
export const SITE_VERIFICATION_SCOPE =
  "https://www.googleapis.com/auth/siteverification";

const googleTokenCache = new Map<
  string,
  { token: string; expiresAt: number }
>();

// Mint a Search Console access token. Two paths:
//   • creds present → JWT-bearer grant (RS256) from that service-account key
//     (local / non-GCP hosts).
//   • creds null → Application Default Credentials — on Cloud Run this is the
//     runtime service account (no key to store; grant it access to the property
//     in Search Console). Uses google-auth-library, already a dependency (Vertex).
// Returns null on any failure.
export async function googleAccessToken(
  scopes: readonly string[] = [WEBMASTERS_SCOPE],
): Promise<string | null> {
  const scope = [...new Set(scopes)].sort().join(" ");
  const cached = googleTokenCache.get(scope);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const creds = loadGoogleCreds();
  if (!creds) {
    try {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: scope.split(" ") });
      const client = await auth.getClient();
      const { token } = await client.getAccessToken();
      if (token) {
        // Access tokens normally live for an hour. Refresh five minutes early;
        // the exact expiry is not exposed consistently by all ADC clients.
        googleTokenCache.set(scope, {
          token,
          expiresAt: Date.now() + 55 * 60 * 1000,
        });
      }
      return token ?? null;
    } catch (err) {
      console.error("googleAccessToken (ADC) failed:", (err as Error).message);
      return null;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: creds.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  // JSON in an env var may keep \n literally escaped — normalize to real ones.
  const key = creds.private_key.replace(/\\n/g, "\n");
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .sign(key, "base64url");

  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  if (data.access_token) {
    googleTokenCache.set(scope, {
      token: data.access_token,
      expiresAt: Date.now() + 55 * 60 * 1000,
    });
  }
  return data.access_token ?? null;
}

// Submit a store's sitemap to Google Search Console. Dormant (no-op) until
// GOOGLE_SEARCH_CONSOLE_PROPERTY is set (auth is then ADC on Cloud Run, or an
// explicit key via GOOGLE_SEARCH_CONSOLE_CREDENTIALS). Best-effort, never throws.
export async function submitSitemapToGoogle(
  sitemapUrl: string,
  propertyOverride?: string,
): Promise<SearchEngineResult> {
  if (!SEARCH_INDEXABLE) {
    return { ok: false, error: "search indexing disabled", skipped: true };
  }
  const property =
    propertyOverride ?? process.env.GOOGLE_SEARCH_CONSOLE_PROPERTY;
  // This is the ONLY Google-facing notification in the codebase, and it used to
  // `return` here in silence. A prod deploy that lost the substitution, or a
  // service account never granted access to the property, therefore looked
  // exactly like a healthy one — nothing was ever submitted and nothing said so.
  // Both failure modes now leave a line in Cloud Logging.
  if (!property) {
    logWarn("submitSitemapToGoogle skipped: no property configured", {
      sitemapUrl,
      hint: "set GOOGLE_SEARCH_CONSOLE_PROPERTY (e.g. sc-domain:storemink.com)",
    });
    return { ok: false, error: "no Search Console property", skipped: true };
  }
  try {
    const token = await googleAccessToken();
    if (!token) {
      logWarn("submitSitemapToGoogle skipped: no access token", {
        sitemapUrl,
        property,
      });
      return { ok: false, error: "no Google access token", skipped: true };
    }
    const res = await fetchWithTimeout(
      googleSitemapEndpoint(property, sitemapUrl),
      { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      // 403 here almost always means the runtime service account was never
      // added as a user on the Search Console property.
      logError("submitSitemapToGoogle rejected", undefined, {
        sitemapUrl,
        property,
        status: res.status,
        body: await res.text().catch(() => ""),
      });
      return {
        ok: false,
        status: res.status,
        error: `Search Console rejected sitemap (${res.status})`,
      };
    }
    logInfo("submitSitemapToGoogle ok", { sitemapUrl, property });
    return { ok: true, status: res.status };
  } catch (err) {
    logError("submitSitemapToGoogle failed", err, { sitemapUrl, property });
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Google sitemap submit failed",
    };
  }
}

/** Add a URL-prefix property to the authenticated account after ownership has
 * been established through the Site Verification API. */
export async function addGoogleSearchConsoleSite(
  siteUrl: string,
): Promise<SearchEngineResult> {
  if (!SEARCH_INDEXABLE) {
    return { ok: false, error: "search indexing disabled", skipped: true };
  }
  try {
    const token = await googleAccessToken();
    if (!token) return { ok: false, error: "no Google access token" };
    const res = await fetchWithTimeout(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logError("addGoogleSearchConsoleSite rejected", undefined, {
        siteUrl,
        status: res.status,
        body,
      });
      return {
        ok: false,
        status: res.status,
        error: `Search Console rejected property (${res.status})`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Google property add failed",
    };
  }
}

export async function requestGoogleSiteVerificationToken(
  siteUrl: string,
): Promise<{ result: SearchEngineResult; token?: string }> {
  if (!SEARCH_INDEXABLE) {
    return {
      result: { ok: false, error: "search indexing disabled", skipped: true },
    };
  }
  try {
    const token = await googleAccessToken([
      WEBMASTERS_SCOPE,
      SITE_VERIFICATION_SCOPE,
    ]);
    if (!token) {
      return { result: { ok: false, error: "no Google access token" } };
    }
    const res = await fetchWithTimeout(
      "https://www.googleapis.com/siteVerification/v1/token",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          site: { type: "SITE", identifier: siteUrl },
          verificationMethod: "META",
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logError("requestGoogleSiteVerificationToken rejected", undefined, {
        siteUrl,
        status: res.status,
        body,
      });
      return {
        result: {
          ok: false,
          status: res.status,
          error: `Site Verification token rejected (${res.status})`,
        },
      };
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      return {
        result: { ok: false, error: "Site Verification returned no token" },
      };
    }
    return { result: { ok: true, status: res.status }, token: data.token };
  } catch (err) {
    return {
      result: {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Google verification token failed",
      },
    };
  }
}

/** Ask Google to verify the META token currently served on siteUrl. */
export async function verifyGoogleSite(
  siteUrl: string,
): Promise<SearchEngineResult> {
  if (!SEARCH_INDEXABLE) {
    return { ok: false, error: "search indexing disabled", skipped: true };
  }
  try {
    const token = await googleAccessToken([
      WEBMASTERS_SCOPE,
      SITE_VERIFICATION_SCOPE,
    ]);
    if (!token) return { ok: false, error: "no Google access token" };
    const res = await fetchWithTimeout(
      "https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=META",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          site: { type: "SITE", identifier: siteUrl },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logError("verifyGoogleSite rejected", undefined, {
        siteUrl,
        status: res.status,
        body,
      });
      return {
        ok: false,
        status: res.status,
        error: `Site Verification rejected token (${res.status})`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Google site verification failed",
    };
  }
}
