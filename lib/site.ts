// Origins for the multi-tenant platform.
//
// PLATFORM_URL is the Storemink platform's own origin (the apex) — used as the
// default/fallback and as the base for the email-worker's internal self-call.
// getStoreUrl() returns the CURRENT request's store canonical origin (its custom
// domain if set, else {slug}.storemink.com) — use it for per-store SEO/canonical.
import { ROOT_DOMAIN } from "@/lib/store/host";
import { getCurrentStore } from "@/lib/store/resolve";

function resolvePlatformUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL;
  const raw = fromEnv
    ? fromEnv.startsWith("http")
      ? fromEnv
      : `https://${fromEnv}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `https://${ROOT_DOMAIN}`;
  return raw.replace(/\/+$/, "");
}

export const PLATFORM_URL = resolvePlatformUrl();

// Canonical origin of the help centre (help.{root}). Used for help-article
// canonicals, OG urls, JSON-LD and the help branch of sitemap.ts/robots.ts.
export const HELP_URL = `https://help.${ROOT_DOMAIN}`;

// Canonical origin of the current request's store.
export async function getStoreUrl(): Promise<string> {
  const store = await getCurrentStore();
  const host = store.custom_domain ?? `${store.slug}.${ROOT_DOMAIN}`;
  return `https://${host}`;
}
