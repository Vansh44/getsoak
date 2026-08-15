import { getSmsLogs } from "@/app/actions/sms-log-actions";
import { SmsLogsView } from "@/app/dashboard/logs/sms-logs/sms-logs-view";
import { pickPage, pickParam } from "@/app/dashboard/lib/list-params";
import { requireOperator } from "../../require-operator";

export const metadata = { title: "SMS logs — StoreMink Admin" };

// Platform SMS.
//
// ⚠ THIS IS EMPTY TODAY, AND THAT IS THE HONEST STATE. `sms_logs` rows with
// `store_id IS NULL` are platform sends, and nothing writes one yet: SMS is
// BYO-per-store (§37) and StoreMink has no Twilio account of its own. The page
// exists because the alternative — adding it at the same moment the first
// message goes out — is how a send with no log gets shipped.
export default async function PlatformSmsLogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();

  const sp = await searchParams;
  const page = pickPage(sp.page);
  const status = pickParam(sp.status);
  const q = pickParam(sp.q);
  const days = Number(pickParam(sp.days)) || 0;

  const result = await getSmsLogs({ page, status, q, days });

  // No basePath prop: `SmsLogsView` navigates to `/dashboard/logs/sms-logs`,
  // which is this route on BOTH consoles — the operator hub deliberately
  // mirrors the merchant path rather than inventing a second one.
  //
  // `platform` IS needed, though: without it the page told an operator about
  // "every text this store has sent", which on a store_id IS NULL view names
  // nothing, and offered "No messages yet" to someone who had just received a
  // StoreMink SMS during signup — which reads as a bug rather than as the
  // designed state.
  return (
    <SmsLogsView
      {...result}
      page={page}
      status={status}
      q={q}
      days={days}
      platform
    />
  );
}
