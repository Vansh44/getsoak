import Link from "next/link";
import { notFound } from "next/navigation";
import { getMyOrder } from "@/app/actions/customer-order-actions";
import { locationAddressLines } from "@/lib/locations/address";
import { CollectionQr } from "./collection-qr";
import styles from "../../orders.module.css";

// The page a customer opens at the counter (roadmap Step 3).
//
// ★ NOINDEX, and owner-gated by getMyOrder — which scopes to the signed-in
// customer AND the host store, so this is no more reachable than the order
// page it hangs off. The collection code in the URL is a lookup key, not the
// thing granting access (CODEBASE §14).
export const metadata = {
  title: "Collect your order",
  robots: { index: false, follow: false },
};

function when(iso: string | null): string {
  if (!iso) return "";
  // Pinned to Asia/Kolkata: this renders on the server, where the zone is UTC
  // on Cloud Run, and a collection deadline three hours out is worse than none
  // (CODEBASE §24).
  return new Date(iso).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

export default async function CollectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { order, error } = await getMyOrder(id);
  if (error || !order) notFound();

  // A delivery has nothing to collect, and an order placed before collection
  // codes existed has no code to show — both send the shopper back to the
  // order, which explains itself.
  if (order.fulfilment_type !== "pickup" || !order.pickup_code) {
    notFound();
  }

  const addressLines = locationAddressLines(order.pickup_location_address);
  const collected = order.pickup_status === "collected";
  const ready = order.pickup_status === "ready";

  return (
    <main className={styles.collectPage}>
      <Link href={`/orders/${order.id}`} className={styles.collectBack}>
        ← Back to order
      </Link>

      <h1 className={styles.collectTitle}>
        {collected ? "Collected" : "Collect your order"}
      </h1>
      <p className={styles.collectRef}>Order {order.order_ref}</p>

      {collected ? (
        <p className={styles.collectNote}>
          This order has been handed over. Nothing more to do.
        </p>
      ) : (
        <>
          <CollectionQr code={order.pickup_code} />

          <p className={styles.collectStatus}>
            {ready
              ? "Ready now — come in whenever suits you."
              : order.pickup_ready_at
                ? `We'll have it ready by ${when(order.pickup_ready_at)}. We'll email you when it's waiting.`
                : "We'll email you as soon as it's ready."}
          </p>
        </>
      )}

      {order.pickup_location_name && (
        <section className={styles.collectShop}>
          <h2 className={styles.collectShopName}>
            {order.pickup_location_name}
          </h2>
          {addressLines.map((line) => (
            <p key={line} className={styles.collectShopLine}>
              {line}
            </p>
          ))}
        </section>
      )}

      {!collected && order.pickup_expires_at && (
        // Said plainly, because the consequence is the order being cancelled.
        <p className={styles.collectNote}>
          Please collect by <strong>{when(order.pickup_expires_at)}</strong>.
        </p>
      )}
    </main>
  );
}
