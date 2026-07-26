"use server";

// ---------------------------------------------------------------------------
// A shopper's own notifications — the storefront counterpart to the dashboard
// bell (app/actions/notification-actions.ts).
//
// It reads the SAME `notifications` table the staff inbox does. The fan-out has
// been writing customer rows since the spine shipped (order confirmed, shipped,
// cancelled, refunded, blog approved/rejected); until now nothing rendered
// them, so they were only reachable by email.
//
// SCOPE IS DOUBLE-LOCKED, as with orders: `withUser` puts the RLS policy
// (`auth.uid() = recipient_id`) underneath, and every query also filters by the
// HOST store — one person shopping at two StoreMink stores must not see store
// A's notifications while browsing store B.
// ---------------------------------------------------------------------------

import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { withUser } from "@/lib/db/client";
import { notifications } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { logError } from "@/lib/observability/logger";

export interface CustomerNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  severity: string;
  read_at: string | null;
  created_at: string;
}

const PAGE_SIZE = 30;

/** This shopper's notifications on THIS store, newest first. */
export async function getMyCustomerNotifications(limit = PAGE_SIZE): Promise<{
  notifications: CustomerNotification[];
  unread: number;
  error?: string;
}> {
  const user = await getServerUser();
  if (!user) return { notifications: [], unread: 0 };
  const storeId = await requireStorefrontStoreId();
  const take = Math.min(Math.max(1, limit), 50);

  try {
    return await withUser(
      { uid: user.id, email: user.email ?? null },
      async (db) => {
        const base = and(
          eq(notifications.recipientId, user.id),
          eq(notifications.recipientType, "customer"),
          eq(notifications.storeId, storeId),
          isNull(notifications.archivedAt),
        );

        // Sequential: one pooled connection per scoped transaction.
        const rows = await db
          .select({
            id: notifications.id,
            type: notifications.type,
            title: notifications.title,
            body: notifications.body,
            url: notifications.url,
            severity: notifications.severity,
            read_at: notifications.readAt,
            created_at: notifications.createdAt,
          })
          .from(notifications)
          .where(base)
          .orderBy(desc(notifications.createdAt))
          .limit(take);
        const unreadRows = await db
          .select({ n: count() })
          .from(notifications)
          .where(and(base, isNull(notifications.readAt)));

        return { notifications: rows, unread: unreadRows[0]?.n ?? 0 };
      },
    );
  } catch (error) {
    logError("customer notifications: list failed", error);
    return {
      notifications: [],
      unread: 0,
      error: "Couldn't load your notifications.",
    };
  }
}

/** Badge count only — what the storefront bell polls. */
export async function getMyCustomerUnreadCount(): Promise<number> {
  const user = await getServerUser();
  if (!user) return 0;

  try {
    const storeId = await requireStorefrontStoreId();
    return await withUser(
      { uid: user.id, email: user.email ?? null },
      async (db) => {
        const rows = await db
          .select({ n: count() })
          .from(notifications)
          .where(
            and(
              eq(notifications.recipientId, user.id),
              eq(notifications.recipientType, "customer"),
              eq(notifications.storeId, storeId),
              isNull(notifications.archivedAt),
              isNull(notifications.readAt),
            ),
          );
        return rows[0]?.n ?? 0;
      },
    );
  } catch (error) {
    logError("customer notifications: unread count failed", error);
    return 0;
  }
}

export async function markMyCustomerNotificationRead(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const user = await getServerUser();
  if (!user) return { error: "Not signed in." };
  if (!id) return { error: "Missing notification." };

  try {
    await withUser({ uid: user.id, email: user.email ?? null }, (db) =>
      db
        .update(notifications)
        .set({ readAt: sql`NOW()` })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.recipientId, user.id),
            eq(notifications.recipientType, "customer"),
            isNull(notifications.readAt),
          ),
        ),
    );
    return { success: true };
  } catch (error) {
    logError("customer notifications: mark read failed", error);
    return { error: "Couldn't update that notification." };
  }
}

export async function markAllMyCustomerNotificationsRead(): Promise<{
  success?: boolean;
  error?: string;
}> {
  const user = await getServerUser();
  if (!user) return { error: "Not signed in." };

  try {
    const storeId = await requireStorefrontStoreId();
    await withUser({ uid: user.id, email: user.email ?? null }, (db) =>
      db
        .update(notifications)
        .set({ readAt: sql`NOW()` })
        .where(
          and(
            eq(notifications.recipientId, user.id),
            eq(notifications.recipientType, "customer"),
            eq(notifications.storeId, storeId),
            isNull(notifications.readAt),
          ),
        ),
    );
    return { success: true };
  } catch (error) {
    logError("customer notifications: mark all read failed", error);
    return { error: "Couldn't update your notifications." };
  }
}
