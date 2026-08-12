import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, Package } from "lucide-react";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getMyOrder } from "@/app/actions/customer-order-actions";
import { getStoreSetting } from "@/lib/settings/resolve";
import { getReturnableOrder } from "@/app/actions/return-actions";
import { locationAddressLines } from "@/lib/locations/address";
import { CancelOrderButton } from "./cancel-order";
import { ReturnRequest } from "./return-request";
import styles from "../orders.module.css";
import {
  FulfilmentBadge,
  PAYMENT_LABEL,
  StatusPill,
  formatDate,
  isPickup,
  money,
  orderProgress,
  pickupNote,
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
  // Server-side, so the button simply isn't there for a store that doesn't
  // offer this. The action re-checks the same setting — a rendered control is
  // not a permission (roadmap invariant 5).
  const selfCancel = Boolean(
    await getStoreSetting("orders.allowCustomerCancellation"),
  );
  // Returns. Only fetched when the store both accepts them AND lets shoppers
  // start one — otherwise the card would be an invitation to a form that the
  // server refuses (`returns.selfServe` is re-checked in requestReturn).
  const returnsOn =
    Boolean(await getStoreSetting("returns.enabled")) &&
    Boolean(await getStoreSetting("returns.selfServe"));
  const returnView = returnsOn
    ? (await getReturnableOrder(order.id)).view
    : undefined;
  // Pickup gets its own vocabulary — a collection order never "ships", so the
  // delivery track could not advance past step two for the rest of its life.
  const progress = orderProgress(order);
  const pickup = isPickup(order);
  // Nothing left to stop once the goods are physically with them.
  const handedOver =
    order.status === "delivered" ||
    order.status === "completed" ||
    order.pickup_status === "collected";

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
            <div className={styles.headerBadges}>
              <FulfilmentBadge order={order} />
              <StatusPill order={order} />
            </div>
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
                  {order.pickup_status === "expired"
                    ? "This order wasn't collected in time, so it was cancelled and the items went back on the shelf."
                    : "This order was cancelled."}{" "}
                  If you paid online, any refund goes back to your original
                  payment method.
                </p>
              ) : (
                <ol className={styles.track}>
                  {progress.steps.map((label, i) => {
                    const done = i <= progress.reached;
                    return (
                      <li
                        key={label}
                        className={`${styles.trackStep} ${done ? styles.trackStepDone : ""}`}
                      >
                        <span className={styles.trackDot} />
                        <span className={styles.trackLabel}>{label}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {/* Not for an order already handed over: there is nothing left
                  to stop, and at that point it's a return. `completed` is what
                  the till writes when a collection is picked up, so without it
                  a collected order still offered to cancel itself. */}
              {selfCancel && !cancelled && !handedOver && (
                <CancelOrderButton orderId={order.id} />
              )}
            </div>

            {!pickup && order.shipments.length > 0 && (
              <div className={styles.card}>
                <div className={styles.sectionTitle}>Shipment tracking</div>
                {order.shipments.map((shipment) => (
                  <div key={shipment.id}>
                    <p className={styles.summary}>
                      <strong>{shipment.status_label}</strong>
                      {shipment.courier_name
                        ? ` · ${shipment.courier_name}`
                        : ""}
                      {shipment.awb ? ` · AWB ${shipment.awb}` : ""}
                    </p>
                    {shipment.tracking_url && (
                      <a
                        href={shipment.tracking_url}
                        target="_blank"
                        rel="noreferrer"
                        className={styles.invoiceBtn}
                      >
                        Track with courier
                      </a>
                    )}
                    {shipment.events.length > 0 && (
                      <ol className={styles.track} style={{ marginTop: 18 }}>
                        {shipment.events.slice(0, 6).map((event, index) => (
                          <li
                            key={event.id}
                            className={`${styles.trackStep} ${index === 0 ? styles.trackStepDone : ""}`}
                          >
                            <span className={styles.trackDot} />
                            <span className={styles.trackLabel}>
                              {event.description ??
                                event.status.replaceAll("_", " ")}
                              <small
                                style={{ display: "block", fontWeight: 400 }}
                              >
                                {formatDate(event.occurred_at)}
                                {event.location ? ` · ${event.location}` : ""}
                              </small>
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            )}

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

            {/* Returns sit under the items, because that's what they're about
                — and only when the store actually offers them. */}
            {returnView && <ReturnRequest view={returnView} />}
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

            {pickup && (
              <div className={styles.card}>
                <div className={styles.sectionTitle}>
                  {order.pickup_status === "collected"
                    ? "Collected from"
                    : "Collect from"}
                </div>
                <div className={styles.address}>
                  <div>
                    <strong>{order.pickup_location_name ?? "Our shop"}</strong>
                  </div>
                  {/* A LOCATION address, not a customer one — different keys
                      entirely (line1 vs addressLine1). Reading it with
                      `addressLines` silently dropped every shop's street. */}
                  {locationAddressLines(order.pickup_location_address).map(
                    (line, i) => (
                      <div key={i}>{line}</div>
                    ),
                  )}
                </div>
                <p className={styles.summary} style={{ marginTop: 14 }}>
                  {pickupNote(order)}
                </p>
              </div>
            )}

            <div className={styles.card}>
              <div className={styles.sectionTitle}>
                {order.fulfilment_type === "pickup"
                  ? "Contact details"
                  : "Delivery address"}
              </div>
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
