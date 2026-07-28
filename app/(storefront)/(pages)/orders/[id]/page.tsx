import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, Package } from "lucide-react";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getMyOrder } from "@/app/actions/customer-order-actions";
import styles from "../orders.module.css";
import {
  CUSTOMER_STATUS_LABEL,
  ORDER_FLOW,
  PAYMENT_LABEL,
  StatusPill,
  formatDate,
  money,
} from "../order-status";

export const dynamic = "force-dynamic";

function addressLines(address: Record<string, unknown>): string[] {
  const get = (key: string) =>
    typeof address[key] === "string" ? (address[key] as string) : "";
  return [
    [get("firstName"), get("lastName")].filter(Boolean).join(" "),
    get("addressLine1"),
    get("addressLine2"),
    [get("city"), get("state"), get("postalCode")].filter(Boolean).join(", "),
    get("country"),
    get("phone"),
  ].filter(Boolean);
}

export default async function MyOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireStorefrontStoreId();

  const user = await getServerUser();
  if (!user) redirect("/");

  const { id } = await params;
  const { order, error } = await getMyOrder(id);
  // Not theirs, not this store's, or not a real id — all the same answer, so a
  // guessed UUID reveals nothing about whether an order exists.
  if (!order) {
    if (error === "Not found.") notFound();
    return (
      <div className={styles.container}>
        <div className={styles.content}>
          <div className={styles.card}>
            <p className={styles.summary}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const cancelled = order.status === "cancelled";
  const reachedIndex = ORDER_FLOW.indexOf(
    order.status as (typeof ORDER_FLOW)[number],
  );

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <Link href="/orders" className={styles.back}>
          <ChevronLeft size={16} />
          All orders
        </Link>

        <header className={styles.header}>
          <div className={styles.row}>
            <div>
              <h1 className={styles.title}>{order.order_ref}</h1>
              <p className={styles.subtitle}>
                Placed {formatDate(order.created_at)} ·{" "}
                {PAYMENT_LABEL[order.payment_method] ?? order.payment_method}
              </p>
            </div>
            <StatusPill status={order.status} />
          </div>
        </header>

        {/* Two columns on desktop: what's happening + what you bought on the
            left, the money and where it's going on the right. Three stacked
            full-width cards made a four-line order scroll like a document. */}
        <div className={styles.layout}>
          <div className={styles.main}>
            {/* A cancelled order gets its own line rather than a half-filled
                track implying it's still on its way. */}
            <div className={styles.card}>
              <div className={styles.sectionTitle}>Progress</div>
              {cancelled ? (
                <p className={styles.summary}>
                  This order was cancelled. If you paid online, any refund goes
                  back to your original payment method.
                </p>
              ) : (
                <ol className={styles.track}>
                  {ORDER_FLOW.map((step, i) => {
                    const done = i <= reachedIndex;
                    return (
                      <li
                        key={step}
                        className={`${styles.trackStep} ${done ? styles.trackStepDone : ""}`}
                      >
                        <span className={styles.trackDot} />
                        <span className={styles.trackLabel}>
                          {CUSTOMER_STATUS_LABEL[step]}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>

            <div className={styles.card}>
              <div className={styles.sectionTitle}>
                {order.item_count} {order.item_count === 1 ? "item" : "items"}
              </div>
              <ul className={styles.itemList}>
                {order.items.map((item) => (
                  <li key={item.id} className={styles.item}>
                    {item.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.image}
                        alt=""
                        className={styles.itemThumb}
                        loading="lazy"
                      />
                    ) : (
                      <span className={styles.itemThumbFallback} aria-hidden>
                        <Package size={18} />
                      </span>
                    )}
                    <div className={styles.itemInfo}>
                      <div className={styles.itemName}>{item.name}</div>
                      <div className={styles.itemMeta}>
                        {item.variant_name ? `${item.variant_name} · ` : ""}
                        {money(item.price, order.currency)} × {item.quantity}
                      </div>
                    </div>
                    <div className={styles.itemTotal}>
                      {money(item.total, order.currency)}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <aside className={styles.side}>
            <div className={styles.card}>
              <div className={styles.sectionTitle}>Summary</div>
              <div className={styles.totalsRow}>
                <span>Subtotal</span>
                <span>{money(order.subtotal, order.currency)}</span>
              </div>
              {order.discount > 0 && (
                <div className={styles.totalsRow}>
                  <span>
                    Discount
                    {order.applied_coupon_code
                      ? ` (${order.applied_coupon_code})`
                      : ""}
                  </span>
                  <span>−{money(order.discount, order.currency)}</span>
                </div>
              )}
              {order.shipping > 0 && (
                <div className={styles.totalsRow}>
                  <span>Shipping</span>
                  <span>{money(order.shipping, order.currency)}</span>
                </div>
              )}
              {order.tax > 0 && (
                <div className={styles.totalsRow}>
                  <span>Tax</span>
                  <span>{money(order.tax, order.currency)}</span>
                </div>
              )}
              <div className={`${styles.totalsRow} ${styles.totalsGrand}`}>
                <span>Total</span>
                <span>{money(order.total, order.currency)}</span>
              </div>
              <Link
                href={`/checkout/invoice/${order.id}`}
                className={styles.invoiceBtn}
              >
                View invoice
              </Link>
            </div>

            <div className={styles.card}>
              <div className={styles.sectionTitle}>Delivery address</div>
              <div className={styles.address}>
                {addressLines(order.shipping_address).map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
              {order.notes && (
                <p className={styles.summary} style={{ marginTop: 14 }}>
                  <strong>Note:</strong> {order.notes}
                </p>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
