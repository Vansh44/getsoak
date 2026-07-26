import { requireSectionAccess } from "../../lib/access";
import { getNotificationConsole } from "@/app/actions/notification-actions";
import { NotificationOverview } from "./notification-overview";

// The notification landing page.
//
// ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════
// The full matrix (27 notifications × 2 audiences × 5 channels × recipients)
// is the honest shape of the engine, but it is NOT the shape of a merchant's
// intent. Opening a settings page to a 27-row grid answers a question nobody
// asked.
//
// In practice a store wants two things:
//   1. "What does the email my customer receives say?"
//   2. "Who on my team gets told when an order comes in?"
//
// So this page leads with exactly those two jobs — the split Shopify's admin
// uses, and for the same reason — and puts the complete list one click away at
// /all for when someone genuinely needs it.
export default async function NotificationsOverviewPage() {
  await requireSectionAccess("notifications", "view");

  // One unfiltered read; the overview groups it by audience. A notification
  // that reaches BOTH (a new order) appears in both sections, each showing
  // only that audience's configuration — which is how a merchant thinks about
  // it, rather than making them pick one home for it.
  const { rows, total, canManage, error } = await getNotificationConsole();

  return (
    <NotificationOverview
      rows={rows}
      total={total}
      canManage={canManage}
      error={error}
    />
  );
}
