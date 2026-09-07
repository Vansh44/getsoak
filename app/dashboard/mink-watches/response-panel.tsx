"use client";
import { useCallback, useEffect, useState } from "react";
import type { listProactiveResponses } from "@/lib/mink/proactive-responses";
import { MinkWorkflowCard } from "../mink-workflow-card";
type Data = Awaited<ReturnType<typeof listProactiveResponses>>;
export function MinkResponsePanel({ watchId }: { watchId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<string | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(
        `/api/mink/watch-responses?watchId=${encodeURIComponent(watchId)}`,
        { cache: "no-store", signal },
      );
      const body = await response.json();
      if (!response.ok) {
        setData(null);
        throw new Error(body.error ?? "Could not load responses.");
      }
      setData(body);
      setConsent(null);
    },
    [watchId],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch((e) => {
      if (!abort.signal.aborted) setError(e.message);
    });
    return () => abort.abort();
  }, [load]);
  async function decide(
    p: Data["plans"][number],
    action: "approve" | "dismiss",
  ) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/mink/watch-responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          watchId,
          sourceRunId: p.sourceRunId,
          signal: p.signal,
          planHash: p.planHash,
          confirmed: action === "approve" && consent === p.planHash,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error ?? "Response request failed.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3" aria-label="Suggested watch responses">
      <h4 className="font-semibold">Suggested responses</h4>
      <button
        className="rounded-lg border px-3 py-2"
        disabled={busy}
        onClick={() => {
          setError("");
          void load().catch((e) => setError(e.message));
        }}
      >
        Refresh responses
      </button>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Loading responses…</p>}
      {data && (
        <>
          <p className="text-xs text-muted-foreground">{data.ranking}</p>
          {!data.plans.length && (
            <p>
              No actionable response from the latest completed check. This is
              not an all-clear.
            </p>
          )}
          {data.plans.map((p) => (
            <article
              key={p.planHash}
              className="space-y-3 rounded-xl border p-4"
            >
              <h5 className="font-semibold">
                {p.rank}. {p.title}
              </h5>
              <p>{p.evidence}</p>
              <p className="text-sm">{p.impact}</p>
              <p className="text-xs">
                {p.locationLabel} · {p.rangeLabel} · {p.timeZone} · Evidence
                collected {new Date(p.dataAsOf).toLocaleString()}
              </p>
              <p className="text-sm">{p.limits}</p>
              <p className="text-xs">
                Plan expires {new Date(p.expiresAt).toLocaleString()}. Approval
                rechecks evidence using the latest completed daily/weekly period
                and current inventory.
              </p>
              {p.status === "proposed" ? (
                <>
                  <label className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={consent === p.planHash}
                      disabled={busy || !data.active}
                      onChange={(e) =>
                        setConsent(e.target.checked ? p.planHash : null)
                      }
                    />
                    I approve this one read-only investigation, not any business
                    changes.
                  </label>
                  <div className="flex gap-2">
                    <button
                      className="rounded-lg border px-3 py-2 disabled:opacity-50"
                      disabled={
                        busy ||
                        !data.active ||
                        consent !== p.planHash ||
                        Date.parse(p.expiresAt) <= Date.now()
                      }
                      onClick={() => void decide(p, "approve")}
                    >
                      Approve investigation
                    </button>
                    <button
                      className="rounded-lg border px-3 py-2"
                      disabled={busy || !data.active}
                      onClick={() => void decide(p, "dismiss")}
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-sm">
                  {p.status === "dismissed"
                    ? "Dismissed for this evidence snapshot."
                    : "Investigation approved. No business change was authorized."}
                </p>
              )}
              {p.workflowId && (
                <MinkWorkflowCard
                  artifact={{
                    type: "workflow",
                    runId: p.workflowId,
                    template: "watch_response_review",
                    title: p.title,
                    description: p.limits,
                    status: "queued",
                    currentStep: 0,
                    totalSteps: 2,
                  }}
                />
              )}
            </article>
          ))}
          {data.investigations
            .filter(
              (i) => !data.plans.some((p) => p.workflowId === i.workflowId),
            )
            .map(
              (i) =>
                i.workflowId && (
                  <MinkWorkflowCard
                    key={i.workflowId}
                    artifact={{
                      type: "workflow",
                      runId: i.workflowId,
                      template: "watch_response_review",
                      title: "Previous approved investigation",
                      description: "Read-only; no business action authorized.",
                      status: "queued",
                      currentStep: 0,
                      totalSteps: 2,
                    }}
                  />
                ),
            )}
        </>
      )}
    </section>
  );
}
