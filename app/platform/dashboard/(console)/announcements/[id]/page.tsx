import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  getAnnouncement,
  getAnnouncementRecipients,
} from "@/app/actions/announcement-actions";
import { describeAudience } from "@/lib/announcements/audience";
import { smsAvailability } from "@/lib/announcements/sms-availability";
import { canManage, requireOperator } from "../../require-operator";
import { AnnouncementComposer } from "../composer";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const announcement = await getAnnouncement(id);
  return {
    title: `${announcement?.title ?? "Announcement"} — StoreMink Admin`,
  };
}

const STATUS_TONE: Record<string, string> = {
  sent: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  skipped: "bg-slate-100 text-slate-500",
  pending: "bg-sky-50 text-sky-700",
  sending: "bg-sky-50 text-sky-700",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

// One announcement: the composer while it is a draft, the SEND LOG once it has
// gone out.
//
// ★ THE LOG IS THE POINT OF THE WHOLE FEATURE. "Did this merchant get the
// pricing notice?" is the question a broadcast system exists to answer, and it
// is unanswerable from a counter — so every recipient is a row, with what
// happened to them and why.
export default async function AnnouncementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireOperator();
  const { id } = await params;

  const announcement = await getAnnouncement(id);
  if (!announcement) notFound();

  const sent = announcement.status !== "draft";
  const recipients = sent ? await getAnnouncementRecipients(id) : [];

  return (
    <div className="w-full max-w-6xl space-y-6">
      <Link
        href="/dashboard/announcements"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" /> Announcements
      </Link>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
          {announcement.title}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {describeAudience(announcement.audience)}
        </p>
      </header>

      <AnnouncementComposer
        initial={announcement}
        canSend={canManage(viewer)}
        smsGate={smsAvailability(announcement.dltTemplateId)}
      />

      {sent ? (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">
              Who was told
            </h2>
            <div className="flex gap-3 text-xs text-slate-500">
              <span>{announcement.sent.toLocaleString("en-IN")} sent</span>
              {announcement.failed > 0 ? (
                <span className="text-red-600">
                  {announcement.failed.toLocaleString("en-IN")} failed
                </span>
              ) : null}
              {announcement.skipped > 0 ? (
                <span>
                  {announcement.skipped.toLocaleString("en-IN")} skipped
                </span>
              ) : null}
            </div>
          </header>

          {recipients.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">
              No recipient rows yet — the worker resolves them within a minute
              of sending.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-5 py-2.5 font-medium text-slate-500">
                      Recipient
                    </th>
                    <th className="px-5 py-2.5 font-medium text-slate-500">
                      Channel
                    </th>
                    <th className="px-5 py-2.5 font-medium text-slate-500">
                      Status
                    </th>
                    <th className="px-5 py-2.5 font-medium text-slate-500">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recipients.map((r) => (
                    <tr key={r.id}>
                      <td className="px-5 py-2.5">
                        <div className="text-slate-900">
                          {r.name || r.email}
                        </div>
                        {r.name ? (
                          <div className="text-xs text-slate-500">
                            {r.email}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-5 py-2.5 capitalize text-slate-600">
                        {r.channel}
                      </td>
                      <td className="px-5 py-2.5">
                        <span
                          className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium capitalize ${
                            STATUS_TONE[r.status] ??
                            "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {r.status}
                        </span>
                        {r.error ? (
                          <div
                            className="mt-0.5 max-w-xs truncate text-xs text-slate-400"
                            title={r.error}
                          >
                            {r.error}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-5 py-2.5 text-slate-500">
                        {when(r.sentAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {recipients.length === 500 ? (
            <p className="border-t border-slate-100 px-5 py-2.5 text-xs text-slate-400">
              Showing the 500 most recent. The full record is in Logs → Email
              logs, filtered to the announcement mailer.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
