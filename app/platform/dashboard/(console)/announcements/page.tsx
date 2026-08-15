import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { listAnnouncements } from "@/app/actions/announcement-actions";
import { CATEGORY_META, describeAudience } from "@/lib/announcements/audience";
import { requireOperator, canManage } from "../require-operator";

export const metadata = { title: "Announcements — StoreMink Admin" };

// Telling merchants something.
//
// ★ THE LIST IS ALSO THE LOG. There is no separate "sent history" screen: a
// draft and a sent announcement are the same row at different points, and
// splitting them would mean an operator checking "did we tell people about the
// price change?" has to know which of two screens to look on.

const STATUS_TONE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  sending: "bg-sky-50 text-sky-700",
  sent: "bg-emerald-50 text-emerald-700",
  partial: "bg-amber-50 text-amber-700",
  failed: "bg-red-50 text-red-700",
};

function date(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

export default async function AnnouncementsPage() {
  const viewer = await requireOperator();
  const announcements = await listAnnouncements();

  return (
    <div className="w-full max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
            Announcements
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Tell merchants and their staff about new features, or about
            something that affects their account.
          </p>
        </div>
        <Link
          href="/dashboard/announcements/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          <Plus className="h-4 w-4" /> New announcement
        </Link>
      </header>

      {announcements.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <Megaphone className="mx-auto h-8 w-8 text-slate-300" />
          <h2 className="mt-3 text-sm font-semibold text-slate-900">
            Nothing announced yet
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Draft a message, check who it reaches, send yourself a test, and
            then send it. Every recipient is recorded.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <ul className="divide-y divide-slate-100">
            {announcements.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/dashboard/announcements/${a.id}`}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition hover:bg-slate-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">
                        {a.title}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium capitalize ${
                          STATUS_TONE[a.status] ?? "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {a.status}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                        {CATEGORY_META[a.category].label}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-sm text-slate-500">
                      {a.subject || (
                        <span className="italic text-slate-400">
                          no subject yet
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-400">
                      {describeAudience(a.audience)}
                    </div>
                  </div>

                  <div className="shrink-0 text-right text-xs">
                    {a.status === "draft" ? (
                      <span className="text-slate-400">
                        Created {date(a.createdAt)}
                      </span>
                    ) : (
                      <>
                        <div className="font-medium tabular-nums text-slate-700">
                          {a.sent.toLocaleString("en-IN")} sent
                          {a.failed > 0 ? (
                            <span className="ml-1.5 text-red-600">
                              {a.failed} failed
                            </span>
                          ) : null}
                        </div>
                        <div className="text-slate-400">
                          {a.skipped > 0 ? `${a.skipped} skipped · ` : ""}
                          {date(a.sentAt ?? a.createdAt)}
                        </div>
                      </>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!canManage(viewer) ? (
        <p className="text-xs text-slate-400">
          You can draft and preview announcements. Sending one is restricted to
          a platform superadmin.
        </p>
      ) : null}
    </div>
  );
}
