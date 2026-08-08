import { requireSectionAccess } from "../../lib/access";
import { pickPage, pickParam } from "../../lib/list-params";
import { getEmailLogs } from "@/app/actions/email-log-actions";
import { EmailLogsView } from "./email-logs-view";

// Email Logs — every message this store has sent.
//
// Sits under Activity because that's what it is: an audit trail, gated on the
// same `activity` section rather than a second permission for the same class of
// data. The sibling to /dashboard/logs, which logs what HAPPENED; this logs
// what was SENT about it.
export default async function EmailLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSectionAccess("activity", "view");

  const sp = await searchParams;
  const page = pickPage(sp.page);
  const status = pickParam(sp.status);
  const mailer = pickParam(sp.mailer);
  const q = pickParam(sp.q);
  const days = Number(pickParam(sp.days)) || 0;

  // Every filter is re-validated server-side in the action — these are only a
  // convenience, not the guard.
  const { rows, total, pageSize, counts, error } = await getEmailLogs({
    page,
    status,
    mailer,
    q,
    days,
  });

  return (
    <EmailLogsView
      rows={rows}
      total={total}
      counts={counts}
      page={page}
      pageSize={pageSize}
      status={status}
      mailer={mailer}
      q={q}
      days={days}
      error={error}
    />
  );
}
