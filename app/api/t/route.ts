import { storefrontEvents } from "@/drizzle/schema";
import { analyticsFeatureAllowed } from "@/lib/analytics/features";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import { storefrontVisitorIdentity } from "@/lib/analytics/storefront-identity";
import { withService } from "@/lib/db/client";
import { effectivePlan } from "@/lib/plans";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BROWSER_EVENTS = new Set([
  "page_view",
  "product_view",
  "add_to_cart",
  "checkout_start",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0];
    const host = (forwarded ?? request.headers.get("host") ?? "")
      .trim()
      .toLowerCase();
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 4096) return new Response(null, { status: 413 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return new Response(null, { status: 400 });
  }
  const value = body as Record<string, unknown>;
  if (
    typeof value.eventId !== "string" ||
    !UUID.test(value.eventId) ||
    typeof value.type !== "string" ||
    !BROWSER_EVENTS.has(value.type)
  ) {
    return new Response(null, { status: 400 });
  }
  const path = typeof value.path === "string" ? value.path : null;
  if (path && (!path.startsWith("/") || path.length > 512)) {
    return new Response(null, { status: 400 });
  }
  const productId =
    typeof value.productId === "string" ? value.productId : null;
  if (productId && !UUID.test(productId)) {
    return new Response(null, { status: 400 });
  }

  const [store, features] = await Promise.all([
    getCurrentStoreOrNull(),
    getPlatformAnalyticsFeatures(),
  ]);
  if (
    !store ||
    !analyticsFeatureAllowed(
      features,
      "storefrontConversion",
      effectivePlan(store),
    )
  ) {
    return new Response(null, { status: 204 });
  }
  const identity = storefrontVisitorIdentity(store, request.headers);
  if (!identity) return new Response(null, { status: 204 });
  const limited = await rateLimit(
    `storefront:${store.id}:${identity.visitorKey}`,
    {
      max: 120,
      windowSeconds: 60,
    },
  );
  if (!limited.allowed) return new Response(null, { status: 429 });

  await withService((db) =>
    db
      .insert(storefrontEvents)
      .values({
        eventId: value.eventId as string,
        storeId: store.id,
        eventDate: identity.eventDate,
        visitorKey: identity.visitorKey,
        eventType: value.type as string,
        path,
        productId,
      })
      .onConflictDoNothing({
        target: [storefrontEvents.storeId, storefrontEvents.eventId],
      }),
  );
  return new Response(null, { status: 204 });
}
