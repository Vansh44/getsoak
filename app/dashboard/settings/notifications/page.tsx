import { requireSectionAccess } from "../../lib/access";
import { pickParam } from "../../lib/list-params";
import { getNotificationConsole } from "@/app/actions/notification-actions";
import { NotificationConsole } from "./notification-console";

// The notification console. Gated on the `notifications` permission section —
// superadmin has it by default and an owner grants it to any role from Roles &
// Permissions (the role editor renders SECTIONS, so it appears there with no
// extra wiring).
//
// Notifications are cross-cutting — they belong to no single feature — so
// unlike the per-feature settings pages (convention #9) they live under
// /dashboard/settings alongside Account and Domain.
export default async function NotificationConsolePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSectionAccess("notifications", "view");

  const sp = await searchParams;
  const category = pickParam(sp.category);
  const audience = pickParam(sp.audience);
  const channel = pickParam(sp.channel);
  const q = pickParam(sp.q);

  const { rows, counts, total, canManage, error } =
    await getNotificationConsole({ category, audience, channel, q });

  return (
    <NotificationConsole
      rows={rows}
      counts={counts}
      total={total}
      canManage={canManage}
      category={category}
      audience={audience}
      channel={channel}
      query={q}
      error={error}
    />
  );
}
