"use client";

// The shopper's notification list. Clicking a row marks it read and follows its
// link (usually to the order it's about) — the same interaction as the staff
// bell, so the two behave alike even though they look nothing alike.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import {
  markAllMyCustomerNotificationsRead,
  markMyCustomerNotificationRead,
  type CustomerNotification,
} from "@/app/actions/customer-notification-actions";
import styles from "./notifications.module.css";

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function CustomerNotificationsView({
  notifications,
  unread,
  error,
}: {
  notifications: CustomerNotification[];
  unread: number;
  error?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [items, setItems] = useState(notifications);
  const [unreadCount, setUnreadCount] = useState(unread);

  const open = (item: CustomerNotification) => {
    if (!item.read_at) {
      // Optimistic: the row settles immediately, the write follows.
      setItems((prev) =>
        prev.map((n) =>
          n.id === item.id ? { ...n, read_at: new Date().toISOString() } : n,
        ),
      );
      setUnreadCount((n) => Math.max(0, n - 1));
      void markMyCustomerNotificationRead(item.id);
    }
    if (item.url) startTransition(() => router.push(item.url as string));
  };

  const markAll = async () => {
    setItems((prev) =>
      prev.map((n) => ({
        ...n,
        read_at: n.read_at ?? new Date().toISOString(),
      })),
    );
    setUnreadCount(0);
    await markAllMyCustomerNotificationsRead();
    router.refresh();
  };

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.row}>
            <div>
              <h1 className={styles.title}>Notifications</h1>
              <p className={styles.subtitle}>
                Updates about your orders and account.
              </p>
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAll}
                className={styles.markAll}
              >
                Mark all as read
              </button>
            )}
          </div>
        </header>

        {error ? (
          <div className={styles.card}>
            <p className={styles.summary}>{error}</p>
          </div>
        ) : items.length === 0 ? (
          <div className={styles.empty}>
            <Bell size={26} style={{ opacity: 0.35 }} />
            <div className={styles.emptyTitle} style={{ marginTop: 12 }}>
              Nothing yet
            </div>
            <p className={styles.emptyText}>
              We&apos;ll let you know here when there&apos;s news about an
              order.
            </p>
          </div>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => open(item)}
              className={`${styles.notification} ${item.read_at ? styles.notificationRead : ""}`}
            >
              <span
                className={`${styles.dot} ${item.read_at ? styles.dotRead : ""}`}
                aria-hidden
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className={styles.notificationTitle}>{item.title}</span>
                {item.body && (
                  <span className={styles.notificationBody}>{item.body}</span>
                )}
                <span className={styles.notificationTime}>
                  {timeAgo(item.created_at)}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
