// Everything a POS screen polls to stay fresh, over ONE authenticated GET.
//
// ★★ WHY THIS IS A ROUTE AND NOT THE SERVER ACTIONS IT REPLACED. Next.js
// "dispatches Server Actions one at a time per client" (docs/01-app/02-guides/
// server-actions.md) — a queue in the CLIENT dispatcher, not on the server. So a
// background refresh in flight sits IN FRONT OF the cashier's next tap: tender a
// sale while the badge is polling and `placePosSale` waits for the poll to
// finish before it is even dispatched. On a shop's wifi that is a visible stall
// on a money action, caused by a refresh nobody asked for, and it is invisible
// in testing because it only shows up under a slow network. The same docs say
// what to do about it: "use a Route Handler for non-mutation requests."
//
// Reads only. Nothing here writes, so nothing here needs the action protocol,
// the RSC re-render machinery, or a POST.
//
// ★ ONE ROUTE, NOT THREE. The auth gate, the cache headers and the failure
// shape are identical for every poller, and three copies is three places for
// them to drift — the registry instinct the rest of the codebase already
// follows. `need` selects the payload; the OPERATOR selects the scope, always.

import { NextResponse, type NextRequest } from "next/server";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { countPickupsWaiting } from "@/lib/pos/pickup-count";
import { getPickupQueue } from "@/app/actions/pos-pickup-actions";
import { getPosInventory } from "@/app/actions/pos-inventory-actions";

/** A poll must never be answered from a cache — that is the whole point of it. */
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(req: NextRequest) {
  const op = await resolvePosOperator();
  // 401, not an error body: the client treats "we could not tell" as "keep what
  // you had" rather than blanking a count to zero, which reads as work
  // vanishing. An expired session is the ordinary cause.
  if (!op) {
    return NextResponse.json(
      { error: "signed-out" },
      { status: 401, headers: NO_STORE },
    );
  }

  const need = req.nextUrl.searchParams.get("need");

  try {
    switch (need) {
      case "pickups": {
        if (!posCan(op.role, "sell")) {
          return NextResponse.json({ count: 0 }, { headers: NO_STORE });
        }
        // Straight to the counter rather than through `getPickupQueue`: this
        // runs on EVERY POS screen including /pos/sell, and the queue read is
        // two queries returning up to 100 rows with their line-item counts to
        // answer a question that is one indexed COUNT.
        const count = await countPickupsWaiting(op.storeId, op.locationId);
        return NextResponse.json({ count }, { headers: NO_STORE });
      }

      case "queue": {
        // Delegates to the action rather than re-querying: a second copy of the
        // queue's predicate is exactly how a badge ends up disagreeing with the
        // list under it. `resolvePosOperator` is React-cached per request, so
        // the re-resolve inside it costs nothing here.
        const res = await getPickupQueue();
        return NextResponse.json(res, { headers: NO_STORE });
      }

      case "stock": {
        const params = req.nextUrl.searchParams;
        const res = await getPosInventory({
          query: params.get("q") ?? "",
          lowOnly: params.get("low") === "1",
        });
        return NextResponse.json(res, { headers: NO_STORE });
      }

      default:
        return NextResponse.json(
          { error: "unknown need" },
          { status: 400, headers: NO_STORE },
        );
    }
  } catch {
    // A polled endpoint failing is not an incident the till should hear about;
    // the client keeps what it had and tries again. 503 rather than 500 so it
    // reads as transient in the logs.
    return NextResponse.json(
      { error: "unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}
