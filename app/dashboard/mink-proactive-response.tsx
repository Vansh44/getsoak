import type { ProactiveResponseResult } from "@/lib/mink/proactive-response-types";
import { RESPONSE_TITLES } from "@/lib/mink/proactive-response-types";
export function MinkProactiveResponse({
  result,
}: {
  result: ProactiveResponseResult;
}) {
  return (
    <section
      aria-label="Approved investigation results"
      className="space-y-3 text-sm"
    >
      <h3 className="font-semibold">{RESPONSE_TITLES[result.signal]}</h3>
      <p>{result.evidence.evidence}</p>
      <p className="text-xs">
        {result.locationLabel} · {result.timeZone} · {result.rangeLabel} ·{" "}
        {result.dataAsOf}
      </p>
      {result.rows.map((r, i) => (
        <div key={i} className="rounded-lg border p-3">
          <p className="font-medium">{r.label}</p>
          <p>{r.detail}</p>
          <a className="underline" href={safePath(r.path)}>
            Review in dashboard
          </a>
        </div>
      ))}
      {result.truncated && (
        <p>
          Showing a limited sample, not every affected record. Open the
          dashboard to review the full scope.
        </p>
      )}
      <h4 className="font-medium">Suggested next steps—not executed</h4>
      <ul className="list-disc space-y-2 pl-5">
        {result.nextSteps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <details>
        <summary>Scope and limitations</summary>
        <ul className="list-disc pl-5">
          {result.limitations.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
function safePath(path: string) {
  return /^\/dashboard\/(inventory\?location=[a-f0-9-]+|orders\/[a-f0-9-]+|orders\/returns|analytics)$/.test(
    path,
  )
    ? path
    : "/dashboard";
}
