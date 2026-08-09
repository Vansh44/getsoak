import { requireSectionAccess } from "../../lib/access";
import { pickPage, pickParam } from "../../lib/list-params";
import { getImportExportJobs } from "@/app/actions/import-export-actions";
import { JobsView } from "./jobs-view";

// Imports & exports — the third log, beside Activity and Email logs.
//
// Same `activity` permission as its siblings, for the reason stated in
// permissions.ts: these answer different questions but they are the same class
// of data, and splitting them into separate permission sections would only give
// an owner a distinction they don't want to think about.
//
// It is also the ONLY central import/export destination, deliberately. Running
// an import belongs on the page whose data it changes; asking what happened
// last Tuesday belongs here.
export default async function ImportExportLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSectionAccess("activity", "view");

  const sp = await searchParams;
  const page = pickPage(sp.page);
  const kindParam = pickParam(sp.kind);
  const kind =
    kindParam === "import" || kindParam === "export" ? kindParam : undefined;
  const resource = pickParam(sp.resource);

  // Every filter is re-validated in the action — these are a convenience.
  const result = await getImportExportJobs({ kind, resource, page });

  return (
    <JobsView
      rows={result.data?.rows ?? []}
      total={result.data?.total ?? 0}
      page={page}
      kind={kind ?? ""}
      resource={resource}
      error={result.error}
    />
  );
}
