import { requireSectionAccess } from "../../../lib/access";
import { getMyNotificationPreferences } from "@/app/actions/notification-actions";
import { MyNotificationsView } from "./my-notifications-view";

// A staff member's OWN opt-outs. Deliberately not gated on the `notifications`
// permission: this page can only say "not me", never "them instead", so
// everyone with a dashboard gets to manage their own inbox.
export default async function MyNotificationsPage() {
  await requireSectionAccess("settings", "view");
  const { rows, error } = await getMyNotificationPreferences();
  return <MyNotificationsView rows={rows} error={error} />;
}
