import { notFound } from "next/navigation";
import { requireSectionAccess } from "../../../lib/access";
import { getNotificationDetail } from "@/app/actions/notification-actions";
import { eventFromSlug } from "@/lib/notifications/events";
import { NotificationDetailView } from "./notification-detail-view";

export default async function NotificationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSectionAccess("notifications", "view");
  const { key } = await params;

  // The URL carries the SLUG form (`order-placed`); dots are kept out of
  // dashboard paths on purpose — see the note in lib/notifications/events.ts.
  const def = eventFromSlug(decodeURIComponent(key));
  if (!def) notFound();

  // `?audience=` scopes the page: arriving from the "Customer emails" tab means
  // that question is already answered, so the switcher is hidden and only that
  // audience's settings are shown. Without the param (e.g. from /all) the page
  // shows both, with a switcher.
  const sp = await searchParams;
  const audienceParam = Array.isArray(sp.audience)
    ? sp.audience[0]
    : sp.audience;
  const scoped =
    audienceParam === "team" || audienceParam === "customer"
      ? audienceParam
      : undefined;

  const detail = await getNotificationDetail(def.key);
  if ("error" in detail) {
    // An unknown key is a 404, not an error banner — the URL is wrong.
    if (detail.error === "Unknown notification.") notFound();
    return (
      <div className="dash-page-enter">
        <section className="dash-card">
          <div className="dash-card-body">
            <div className="dash-empty">
              <div className="dash-empty-title">
                Couldn&apos;t load that notification
              </div>
              <p className="dash-empty-text">{detail.error}</p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return <NotificationDetailView detail={detail} scopedAudience={scoped} />;
}
