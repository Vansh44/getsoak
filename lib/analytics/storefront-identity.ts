import "server-only";

import { createHmac } from "node:crypto";
import { normalizeAnalyticsTimeZone } from "./range";
import { clientIp } from "@/lib/rate-limit";

const BOT_UA =
  /bot|crawler|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp/i;

function businessTimeZone(settings: unknown): string {
  if (!settings || typeof settings !== "object") {
    return normalizeAnalyticsTimeZone(undefined);
  }
  const business = (settings as Record<string, unknown>).business;
  return normalizeAnalyticsTimeZone(
    business && typeof business === "object"
      ? (business as Record<string, unknown>).timeZone
      : undefined,
  );
}

export function storefrontBusinessDate(
  settings: unknown,
  now: Date = new Date(),
): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: businessTimeZone(settings),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function storefrontVisitorIdentity(
  store: { id: string; settings?: unknown },
  headers: Headers,
  now: Date = new Date(),
): { visitorKey: string; eventDate: string } | null {
  const ip = clientIp(headers);
  const userAgent = headers.get("user-agent")?.trim() ?? "";
  const secret =
    process.env.STOREFRONT_ANALYTICS_SECRET ?? process.env.CRON_SECRET;
  if (!secret || ip === "unknown" || !userAgent || BOT_UA.test(userAgent)) {
    return null;
  }
  const eventDate = storefrontBusinessDate(store.settings, now);
  const visitorKey = createHmac("sha256", secret)
    .update(`${store.id}\n${eventDate}\n${ip}\n${userAgent.slice(0, 512)}`)
    .digest("hex")
    .slice(0, 32);
  return { visitorKey, eventDate };
}
