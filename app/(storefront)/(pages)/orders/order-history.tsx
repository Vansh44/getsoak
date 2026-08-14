"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight, Package, ShoppingBag, Store } from "lucide-react";
import type { MyOrderRow } from "@/app/actions/customer-order-actions";
import { isInStoreJourney } from "@/lib/orders/history-channels";
import styles from "./orders.module.css";
import { FulfilmentBadge, StatusPill, formatDate, money } from "./order-status";

type HistoryTab = "online" | "in_store";

function OrderCard({ order }: { order: MyOrderRow }) {
  // "Basmati Rice + 2 more" — the products are what a shopper recognises an
  // order by. The reference is a support handle, so it reads as metadata.
  const extra = order.item_count - 1;
  return (
    <li>
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
            {extra > 0 && <span className={styles.more}> + {extra} more</span>}
          </div>
          <div className={styles.meta}>
            <span className={styles.ref}>{order.order_ref}</span>
            <span className={styles.dot} aria-hidden>
              ·
            </span>
            {formatDate(order.created_at)}
            <FulfilmentBadge order={order} />
          </div>
        </div>

        <div className={styles.trailing}>
          <StatusPill order={order} />
          <div className={styles.total}>
            {money(order.total, order.currency)}
          </div>
        </div>

        <ChevronRight size={18} className={styles.chevron} />
      </Link>
    </li>
  );
}

function EmptyHistory({
  tab,
  supportsPos,
  supportsPickup,
}: {
  tab: HistoryTab;
  supportsPos: boolean;
  supportsPickup: boolean;
}) {
  const online = tab === "online";
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden>
        {online ? <ShoppingBag size={42} /> : <Store size={42} />}
      </span>
      <div className={styles.emptyTitle}>
        {online ? "No online orders yet" : "No in-store purchases yet"}
      </div>
      <p className={styles.emptyText}>
        {online
          ? "Shop online and your delivery orders will appear here."
          : supportsPos && supportsPickup
            ? "Counter purchases linked to your account and orders collected from a shop will appear here."
            : supportsPickup
              ? "Choose store pickup at checkout and your collection order will appear here."
              : supportsPos
                ? "Ask the cashier to attach your customer account so your store receipt appears here."
                : "Your earlier counter purchases and collection orders will stay available here."}
      </p>
      {(online || supportsPickup) && (
        <Link href="/shop" className={styles.cta}>
          {online ? "Start shopping" : "Shop for pickup"}
        </Link>
      )}
    </div>
  );
}

export function OrderHistory({
  orders,
  showInStoreTab,
  supportsPos,
  supportsPickup,
}: {
  orders: MyOrderRow[];
  showInStoreTab: boolean;
  supportsPos: boolean;
  supportsPickup: boolean;
}) {
  const [tab, setTab] = useState<HistoryTab>("online");

  // Stores with no physical-store journey keep the original, simpler list.
  // When the split is visible, a pickup belongs under In store because the
  // customer must visit the shop even though they placed it online.
  const visibleOrders = showInStoreTab
    ? orders.filter((order) =>
        tab === "in_store" ? isInStoreJourney(order) : !isInStoreJourney(order),
      )
    : orders;

  return (
    <>
      {showInStoreTab && (
        <div className={styles.tabs} role="tablist" aria-label="Order channel">
          <button
            id="orders-tab-online"
            type="button"
            role="tab"
            aria-selected={tab === "online"}
            aria-controls="orders-tab-panel"
            className={`${styles.tab} ${tab === "online" ? styles.tabActive : ""}`}
            onClick={() => setTab("online")}
          >
            Online
          </button>
          <button
            id="orders-tab-in-store"
            type="button"
            role="tab"
            aria-selected={tab === "in_store"}
            aria-controls="orders-tab-panel"
            className={`${styles.tab} ${tab === "in_store" ? styles.tabActive : ""}`}
            onClick={() => setTab("in_store")}
          >
            In store
          </button>
        </div>
      )}

      <div
        id={showInStoreTab ? "orders-tab-panel" : undefined}
        role={showInStoreTab ? "tabpanel" : undefined}
        aria-labelledby={
          showInStoreTab
            ? tab === "online"
              ? "orders-tab-online"
              : "orders-tab-in-store"
            : undefined
        }
      >
        {visibleOrders.length === 0 ? (
          <EmptyHistory
            tab={showInStoreTab ? tab : "online"}
            supportsPos={supportsPos}
            supportsPickup={supportsPickup}
          />
        ) : (
          <ul className={styles.list}>
            {visibleOrders.map((order) => (
              <OrderCard key={order.id} order={order} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
