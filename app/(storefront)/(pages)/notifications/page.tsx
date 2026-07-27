import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth/server-user";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getMyCustomerNotifications } from "@/app/actions/customer-notification-actions";
import { CustomerNotificationsView } from "./notifications-view";

export const dynamic = "force-dynamic";

// The shopper's notification centre. These rows have been written by the event
// spine since it shipped (§22) — order confirmed, on the way, cancelled — but
// nothing rendered them, so they were reachable only by email.
export default async function CustomerNotificationsPage() {
  await requireStorefrontStoreId();

  const user = await getServerUser();
  if (!user) redirect("/");

  const { notifications, unread, error } = await getMyCustomerNotifications();
  return (
    <CustomerNotificationsView
      notifications={notifications}
      unread={unread}
      error={error}
    />
  );
}
