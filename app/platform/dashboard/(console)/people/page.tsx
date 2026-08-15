import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { pickPage, pickParam } from "@/app/dashboard/lib/list-params";
import { listPlatformPeople, type PersonKind } from "@/lib/platform/people";
import { peopleHref } from "@/lib/platform/people-links";
import { requireOperator } from "../require-operator";
import { PeopleSearch } from "./people-search";

export const metadata = { title: "People — StoreMink Admin" };

// ---------------------------------------------------------------------------
// Who can sign in to a merchant store — across every store.
//
// ★ THE QUESTION HAD NO ANSWER SHORT OF SQL. `admins` and `pos_staff` were
// each reachable only from inside the store that owned them, so "which stores
// is this person on?" and "who else has a dashboard login here?" were queries
// somebody ran by hand against production.
// ---------------------------------------------------------------------------

const KIND_CHIPS: { id: PersonKind | ""; label: string }[] = [
  { id: "", label: "Everyone" },
  { id: "admin", label: "Dashboard" },
  { id: "pos", label: "Till" },
];

function date(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  suspended: "bg-red-50 text-red-700",
  inactive: "bg-slate-100 text-slate-500",
  invited: "bg-amber-50 text-amber-700",
};

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOperator();

  const sp = await searchParams;
  const q = pickParam(sp.q);
  const rawKind = pickParam(sp.kind);
  const kind: PersonKind | "" =
    rawKind === "admin" || rawKind === "pos" ? rawKind : "";
  const storeId = pickParam(sp.store);
  const page = pickPage(sp.page);

  const result = await listPlatformPeople({ q, kind, storeId, page });
  const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));

  // Every link on this page goes through the one builder (tested in
  // lib/platform/people-links.test.ts) so paging and chip-switching can never
  // silently drop the search.
  const filters = { q, kind, store: storeId, page };

  return (
    <div className="w-full max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
            People
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Everyone who can sign in to a merchant store — dashboard admins and
            till staff.
          </p>
        </div>
        <PeopleSearch initial={q} kind={kind} storeId={storeId} />
      </header>

      {!result.ok ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Couldn&apos;t read the directory — the database query failed.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {KIND_CHIPS.map((chip) => {
          const count =
            chip.id === "" ? result.counts.all : result.counts[chip.id];
          const active = chip.id === kind;
          return (
            <Link
              key={chip.id || "all"}
              href={peopleHref(filters, { kind: chip.id, page: 1 })}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-slate-900 text-white"
                  : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {chip.label}
              <span
                className={`tabular-nums ${active ? "text-slate-300" : "text-slate-400"}`}
              >
                {count.toLocaleString("en-IN")}
              </span>
            </Link>
          );
        })}
        {storeId ? (
          <Link
            href="/dashboard/people"
            className="inline-flex items-center rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100"
          >
            Filtered to one store — clear
          </Link>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-5 py-3 font-medium text-slate-500">Person</th>
                <th className="px-5 py-3 font-medium text-slate-500">Store</th>
                <th className="px-5 py-3 font-medium text-slate-500">Access</th>
                <th className="px-5 py-3 font-medium text-slate-500">Role</th>
                <th className="px-5 py-3 font-medium text-slate-500">Status</th>
                <th className="px-5 py-3 font-medium text-slate-500">Added</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-5 py-12 text-center text-slate-500"
                  >
                    {q
                      ? `Nobody matches “${q}”.`
                      : "No one has access to any store yet."}
                  </td>
                </tr>
              ) : (
                result.rows.map((person) => (
                  <tr
                    key={`${person.kind}-${person.id}`}
                    className="transition-colors hover:bg-slate-50"
                  >
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-slate-900">
                        {person.name || (
                          <span className="text-slate-400">—</span>
                        )}
                      </div>
                      <div className="text-slate-500">{person.email}</div>
                    </td>
                    <td className="px-5 py-3.5">
                      <Link
                        href={`/dashboard/stores/${person.storeId}`}
                        className="font-medium text-slate-700 hover:text-indigo-700 hover:underline"
                      >
                        {person.storeName}
                      </Link>
                      <div className="text-xs text-slate-400">
                        {person.storeSlug}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      {/* Kind, never collapsed into role: a dashboard login and
                          a till PIN are different access with different reach. */}
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${
                          person.kind === "pos"
                            ? "bg-sky-50 text-sky-700"
                            : "bg-indigo-50 text-indigo-700"
                        }`}
                      >
                        {person.kind === "pos" ? "Till" : "Dashboard"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 capitalize text-slate-600">
                      {person.role}
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium capitalize ${
                          STATUS_TONE[person.status] ??
                          "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {person.status}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-slate-500">
                      {date(person.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {lastPage > 1 ? (
          <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm">
            <span className="text-slate-500">
              Page {result.page} of {lastPage} ·{" "}
              {result.total.toLocaleString("en-IN")} total
            </span>
            <div className="flex gap-2">
              {result.page > 1 ? (
                <Link
                  href={peopleHref(filters, { page: result.page - 1 })}
                  className="rounded-md border border-slate-200 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                >
                  Previous
                </Link>
              ) : null}
              {result.page < lastPage ? (
                <Link
                  href={peopleHref(filters, { page: result.page + 1 })}
                  className="rounded-md border border-slate-200 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
                >
                  Next
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
