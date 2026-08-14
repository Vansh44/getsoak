import { requireSectionAccess } from "../../lib/access";
import { pickPage, pickParam } from "../../lib/list-params";
import { getSmsLogs } from "@/app/actions/sms-log-actions";
import { SmsLogsView } from "./sms-logs-view";

// SMS Logs — every text this store has sent (§37).
//
// The sibling of Email logs, on the SAME `activity` section: it is the same
// class of data, and a second permission for it is a grant somebody forgets to
// give. What it adds over the email log is `segments` — one non-GSM-7 character
// re-prices a whole message from 160 characters to 70, so without the number
// here a merchant cannot tell why a month cost triple.
export const metadata = { title: "SMS logs" };

export default async function SmsLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSectionAccess("activity", "view");

  const sp = await searchParams;
  const page = pickPage(sp.page);
  const status = pickParam(sp.status);
  const q = pickParam(sp.q);
  const days = Number(pickParam(sp.days)) || 0;

  // Every filter is re-validated in the action — these are a convenience, not
  // the guard.
  const result = await getSmsLogs({ page, status, q, days });

  return (
    <SmsLogsView {...result} page={page} status={status} q={q} days={days} />
  );
}
