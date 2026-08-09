import { requireSectionAccess } from "../../lib/access";
import { getCancellationRequests } from "@/app/actions/order-actions";
import { CancellationQueueView } from "./cancellation-queue-view";

// The cancellation review queue (roadmap Step 2).
//
// Gated on `orders` rather than a new permission key — the returns-queue
// precedent, for the same reason: cancelling is an order operation, and anyone
// who can already manage orders can already do this by hand.
export default async function CancellationsPage() {
  const access = await requireSectionAccess("orders", "view");
  const { requests, error } = await getCancellationRequests();

  return (
    <CancellationQueueView
      requests={requests}
      error={error}
      canManage={access.can("orders", "manage")}
    />
  );
}
