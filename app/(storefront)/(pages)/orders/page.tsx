import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Package } from "lucide-react";
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
          <ul className={styles.list}>
            {orders.map((order) => {
              // "Basmati Rice + 2 more" — the products are what a shopper
              // recognises an order by, so they lead. The reference is a
              // support handle, not an identity, and reads as metadata.
              const extra = order.item_count - 1;
              return (
                <li key={order.id}>
                  <Link
                    href={`/orders/${order.id}`}
                    className={styles.card}
                    aria-label={`Order ${order.order_ref}, ${money(order.total, order.currency)}`}
                  >
                    <div className={styles.thumbs}>
                      {order.thumbnails.length > 0 ? (
                        order.thumbnails.map((src, i) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={`${order.id}-${i}`}
                            src={src}
                            alt=""
                            className={styles.thumb}
                            loading="lazy"
                          />
                        ))
                      ) : (
                        <span className={styles.thumbFallback} aria-hidden>
                          <Package size={20} />
                        </span>
                      )}
                    </div>

                    <div className={styles.info}>
                      <div className={styles.itemName}>
                        {order.first_item ?? "Order"}
                        {extra > 0 && (
                          <span className={styles.more}> + {extra} more</span>
                        )}
                      </div>
                      <div className={styles.meta}>
                        <span className={styles.ref}>{order.order_ref}</span>
                        <span className={styles.dot} aria-hidden>
                          ·
                        </span>
                        {formatDate(order.created_at)}
                      </div>
                    </div>

                    <div className={styles.trailing}>
                      <StatusPill status={order.status} />
                      <div className={styles.total}>
                        {money(order.total, order.currency)}
                      </div>
                    </div>

                    <ChevronRight size={18} className={styles.chevron} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
