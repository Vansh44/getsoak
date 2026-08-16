import { getPlanPricingLive } from "@/lib/plans/pricing";
import { logError } from "@/lib/observability/logger";

/**
 * The signup wizard is intentionally a client flow, but a price is server
 * state. Read it through a GET (not a Server Action) so this one-off query does
 * not enter Next's per-client mutation queue and can never delay a signup tap.
 */
export async function GET() {
  try {
    const pricing = await getPlanPricingLive();
    return Response.json(pricing, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logError("signup pricing: live read failed", error);
    return Response.json(
      { error: "Current plan pricing is temporarily unavailable." },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
