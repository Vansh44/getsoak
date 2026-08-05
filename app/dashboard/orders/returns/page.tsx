import { requireSectionAccess } from "../../lib/access";
import { getReturnQueue } from "@/app/actions/return-actions";
import { ReturnsQueueView } from "./returns-queue-view";

// The review queue (roadmap Step 3). Gated on `orders` rather than a new
// permission key: a return is an order operation, and anyone who can already
// refund an order can already do this by hand.
export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireSectionAccess("orders", "view");
  const sp = await searchParams;
  const status = typeof sp.status === "string" ? sp.status : "";

  const { rows, error } = await getReturnQueue(status || undefined);

  return (
    <ReturnsQueueView
      rows={rows}
      status={status}
      error={error}
      canManage={access.can("orders", "manage")}
    />
  );
}
