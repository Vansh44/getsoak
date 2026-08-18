import { getActingStoreId, requireSectionAccess } from "../../lib/access";
import { getReturnQueue } from "@/app/actions/return-actions";
import {
  defaultRestockLocation,
  listRestockLocations,
} from "@/lib/returns/restock-location";
import { ReturnsQueueView } from "./returns-queue-view";

// The review queue (roadmap Step 3). Gated on `orders` rather than a new
// permission key: a return is an order operation, and anyone who can already
// refund an order can already do this by hand.
//
// The restock locations are read HERE rather than through a server action
// (Step 13): everything exported from a "use server" file is a public
// endpoint, and this is a plain server-component read that needs no second
// gate beyond the one above (the §32 rule that put lib/retention/prune.ts and
// lib/domains/reconcile.ts outside app/actions).
export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireSectionAccess("orders", "view");
  const sp = await searchParams;
  const status = typeof sp.status === "string" ? sp.status : "";

  const storeId = await getActingStoreId();
  const [{ rows, error }, locations] = await Promise.all([
    getReturnQueue(status || undefined),
    listRestockLocations(storeId),
  ]);

  return (
    <ReturnsQueueView
      rows={rows}
      status={status}
      error={error}
      canManage={access.can("orders", "manage")}
      locations={locations}
      defaultLocationId={defaultRestockLocation(locations)}
    />
  );
}
