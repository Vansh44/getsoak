import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireSectionAccess } from "../../../lib/access";
import { pickParam } from "../../../lib/list-params";
import { getImportExportJob } from "@/app/actions/import-export-actions";
import { getResource } from "@/lib/import-export/resources";
import { ISSUE_CAP } from "@/lib/import-export/jobs";
import { JobIssuesView } from "./job-issues-view";

// One job, row by row — the error log the whole feature exists to produce.
//
// A merchant arrives here from a failed import wanting one thing: WHICH rows,
// and WHY. So the page leads with the counts, then lists issues in file order
// with the line number their spreadsheet shows and the offending cell quoted
// back. Errors before warnings, because errors are why they clicked.
export default async function ImportExportJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSectionAccess("activity", "view");

  const { jobId } = await params;
  const sp = await searchParams;
  const severityParam = pickParam(sp.severity);
  const severity =
    severityParam === "error" || severityParam === "warning"
      ? severityParam
      : undefined;

  const result = await getImportExportJob(jobId, { severity });
  // A job id from another store resolves to nothing (getJob is store-scoped),
  // so this is also the cross-tenant answer.
  if (!result.data) notFound();

  const { job, issues } = result.data;
  const resource = getResource(job.resource);

  return (
    <div className="dash-page-enter flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <Link
            href="/dashboard/logs/import-export"
            className="mb-1 inline-flex items-center gap-1 text-[13px] text-[var(--dash-text-3)] hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Imports &amp; exports
          </Link>
          <h1>
            {job.kind === "import" ? "Import" : "Export"} ·{" "}
            {resource?.label ?? job.resource}
          </h1>
          <p>{job.filename ?? "No file name recorded"}</p>
        </div>
      </header>

      <JobIssuesView
        job={job}
        issues={issues}
        severity={severity ?? ""}
        issueCap={ISSUE_CAP}
      />
    </div>
  );
}
