import { getEmailLogs } from "@/app/actions/email-log-actions";
import { EmailLogsView } from "@/app/dashboard/logs/email-logs/email-logs-view";
import { pickPage, pickParam } from "@/app/dashboard/lib/list-params";

export const metadata = { title: "Email logs — StoreMink Admin" };

export default async function PlatformEmailLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const page = pickPage(sp.page);
  const status = pickParam(sp.status);
  const mailer = pickParam(sp.mailer);
  const q = pickParam(sp.q);
  const days = Number(pickParam(sp.days)) || 0;
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
      basePath="/dashboard/logs/email-logs"
      platform
    />
  );
}
