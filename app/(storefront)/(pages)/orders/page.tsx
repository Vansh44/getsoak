import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getMyOrders } from "@/app/actions/customer-order-actions";
import styles from "./orders.module.css";
import { StatusPill, formatDate, money } from "./order-status";

export const dynamic = "force-dynamic";

// A shopper's order history. Until now the storefront had no such page: an
// order could only be seen on the checkout success screen, which is gone the
// moment you navigate away — and the order notifications the spine sends have
// been linking here (§22), so this is where they land.
export default async function MyOrdersPage() {
  // Guards the host itself: an unclaimed subdomain must 404 rather than serve
  // the fallback store's chrome (the require* rule in lib/store/resolve.ts).
  await requireStorefrontStoreId();

  const user = await getServerUser();
  if (!user) redirect("/");

  const { orders, error } = await getMyOrders();

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <header className={styles.header}>
          <h1 className={styles.title}>My orders</h1>
          <p className={styles.subtitle}>
            Everything you&apos;ve ordered from us, newest first.
          </p>
        </header>

        {error ? (
          <div className={styles.card}>
            <p className={styles.summary}>{error}</p>
          </div>
        ) : orders.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>No orders yet</div>
            <p className={styles.emptyText}>
              When you place an order it&apos;ll show up here, with its status
              and a receipt.
            </p>
            <Link href="/shop" className={styles.cta}>
              Start shopping
            </Link>
          </div>
        ) : (
          orders.map((order) => (
            <Link
              key={order.id}
              href={`/orders/${order.id}`}
              className={styles.card}
            >
              <div className={styles.row}>
                <div>
                  <div className={styles.ref}>{order.order_ref}</div>
                  <div className={styles.meta}>
                    {formatDate(order.created_at)} · {order.item_count}{" "}
                    {order.item_count === 1 ? "item" : "items"}
                  </div>
                  {order.first_item && (
                    <div className={styles.summary}>
                      {order.first_item}
                      {order.item_count > 1 ? " and more" : ""}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right" }}>
                  <StatusPill status={order.status} />
                  <div className={styles.total} style={{ marginTop: 8 }}>
                    {money(order.total, order.currency)}
                  </div>
                  <ChevronRight
                    size={16}
                    style={{ marginTop: 6, opacity: 0.4 }}
                  />
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
