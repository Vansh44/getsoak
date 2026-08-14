import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import {
  getMyOrderHistoryCapabilities,
  getMyOrders,
} from "@/app/actions/customer-order-actions";
import { shouldShowInStoreHistory } from "@/lib/orders/history-channels";
import styles from "./orders.module.css";
import { OrderHistory } from "./order-history";

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

  const [{ orders, error }, capabilities] = await Promise.all([
    getMyOrders(),
    getMyOrderHistoryCapabilities(),
  ]);
  const showInStoreTab = shouldShowInStoreHistory({
    orders,
    ...capabilities,
  });

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
        ) : (
          <OrderHistory
            orders={orders}
            showInStoreTab={showInStoreTab}
            supportsPos={capabilities.supportsPos}
            supportsPickup={capabilities.supportsPickup}
          />
        )}
      </div>
    </div>
  );
}
