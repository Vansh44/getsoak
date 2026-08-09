import { requireSectionAccess } from "../lib/access";
import { pickPage, pickParam } from "../lib/list-params";
import { getActivityFeed } from "@/app/actions/notification-actions";
import { EVENT_GROUPS } from "@/lib/notifications/events";
import { RealtimeRefresher } from "../components/realtime-refresher";
import { ActivityFeedView } from "./activity-feed-view";

// The store's audit trail. This route has been in the permission catalog
// (SECTIONS → "activity") since roles shipped, but the page never existed —
// the sidebar link 404'd. It is now backed by activity_events, the same log
// the notification system fans out from, so every notification has a
// permanent, filterable record behind it.
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSectionAccess("activity", "view");

  const sp = await searchParams;
  const page = pickPage(sp.page);
  const groupParam = pickParam(sp.group);
  const group = (EVENT_GROUPS as readonly string[]).includes(groupParam)
    ? groupParam
    : "";
  const dateRange = pickParam(sp.range);

  const { events, total, error } = await getActivityFeed({
    page,
    group: group || undefined,
    dateRange,
  });

  return (
    <>
      <RealtimeRefresher tables={["activity_events"]} intervalMs={60_000} />
      <ActivityFeedView
        events={events}
        total={total}
        page={page}
        group={group}
        dateRange={dateRange}
        error={error}
      />
    </>
  );
}
