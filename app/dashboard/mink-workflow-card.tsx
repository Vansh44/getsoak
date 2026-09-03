"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Ban,
  CheckCircle2,
  LoaderCircle,
  Play,
  RotateCcw,
} from "lucide-react";
import type { MinkArtifact } from "@/lib/mink/types";
import type { MinkWorkflowView } from "@/lib/mink/workflow-types";

type WorkflowArtifact = Extract<MinkArtifact, { type: "workflow" }>;

export function MinkWorkflowCard({ artifact }: { artifact: WorkflowArtifact }) {
  const [workflow, setWorkflow] = useState<MinkWorkflowView>(() =>
    initialWorkflow(artifact),
  );
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const active = workflow.status === "queued" || workflow.status === "running";

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(`/api/mink/workflows/${artifact.runId}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        workflow?: MinkWorkflowView;
        error?: string;
      };
      if (!response.ok || !body.workflow) {
        throw new Error(body.error ?? "Mink couldn't refresh this workflow.");
      }
      setWorkflow(body.workflow);
      setError(null);
    },
    [artifact.runId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((nextError) => {
      if (controller.signal.aborted) return;
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Mink couldn't refresh this workflow.",
      );
    });
    if (!active) return () => controller.abort();
    const timer = window.setInterval(() => {
      void refresh(controller.signal).catch((nextError) => {
        if (!controller.signal.aborted) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Mink couldn't refresh this workflow.",
          );
        }
      });
    }, 3_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [active, refresh]);

  const mutate = useCallback(
    async (action: "cancel" | "resume") => {
      setMutating(true);
      setError(null);
      try {
        const response = await fetch(`/api/mink/workflows/${artifact.runId}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          workflow?: MinkWorkflowView;
          error?: string;
        };
        if (!response.ok || !body.workflow) {
          throw new Error(body.error ?? "Mink couldn't update this workflow.");
        }
        setWorkflow(body.workflow);
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Mink couldn't update this workflow.",
        );
      } finally {
        setMutating(false);
      }
    },
    [artifact.runId],
  );

  const progress = useMemo(
    () =>
      workflow.totalSteps > 0
        ? Math.min(
            100,
            Math.round((workflow.currentStep / workflow.totalSteps) * 100),
          )
        : 0,
    [workflow.currentStep, workflow.totalSteps],
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-[#ded8f4] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-start justify-between gap-3 border-b border-[#ece9f2] bg-[#faf8ff] px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#352666]">
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            {artifact.title}
          </div>
          <p className="mt-0.5 text-[10px] leading-4 text-[#716c7a]">
            {artifact.description}
          </p>
        </div>
        <StatusBadge status={workflow.status} />
      </div>

      <div className="p-3">
        {active ? (
          <div aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-[10px] text-[#66616e]">
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                {workflow.cancelRequested
                  ? "Stopping safely after the current read"
                  : workflow.status === "queued"
                    ? "Queued for background processing"
                    : "Building your report"}
              </span>
              <span className="tabular-nums">
                {workflow.currentStep}/{workflow.totalSteps} steps
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#eeeaf7]">
              <div
                className="h-full rounded-full bg-[#7652e8] transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : null}

        {workflow.result ? <WeeklyReport result={workflow.result} /> : null}

        {workflow.status === "failed" ? (
          <p className="rounded-xl bg-[#fff7ed] px-3 py-2 text-[10px] leading-4 text-[#8a4a08]">
            {workflow.errorDetail ??
              "Mink could not finish this report after safe retries."}
          </p>
        ) : null}
        {workflow.status === "cancelled" ? (
          <p className="rounded-xl bg-[#f5f5f5] px-3 py-2 text-[10px] leading-4 text-[#66616e]">
            This workflow was cancelled. Cancelled workflows cannot resume or
            continue changing state.
          </p>
        ) : null}
        {error ? (
          <p className="mt-2 text-[10px] leading-4 text-[#b42318]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-2 flex items-center justify-end gap-2">
          {active && !workflow.cancelRequested ? (
            <button
              type="button"
              disabled={mutating}
              onClick={() => void mutate("cancel")}
              className="inline-flex items-center gap-1 rounded-lg border border-[#e3dfe9] px-2.5 py-1.5 text-[10px] font-medium text-[#5d5864] hover:bg-[#f7f6f8] disabled:opacity-50"
            >
              <Ban className="h-3 w-3" /> Stop
            </button>
          ) : null}
          {workflow.status === "waiting_approval" ? (
            <button
              type="button"
              disabled={mutating}
              onClick={() => void mutate("resume")}
              className="inline-flex items-center gap-1 rounded-lg bg-[#6f4ce6] px-2.5 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3" /> Resume
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function WeeklyReport({
  result,
}: {
  result: NonNullable<MinkWorkflowView["result"]>;
}) {
  const metrics = [
    [
      "Net sales",
      money(result.netSales, result.currency),
      result.netSalesTrendPercent,
    ],
    [
      "Orders",
      result.orders.toLocaleString("en-IN"),
      result.ordersTrendPercent,
    ],
    [
      "Average order value",
      money(result.averageOrderValue, result.currency),
      result.averageOrderValueTrendPercent,
    ],
    [
      "Units sold",
      result.unitsSold.toLocaleString("en-IN"),
      result.unitsSoldTrendPercent,
    ],
  ] as const;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-xl bg-[#f4fff9] px-3 py-2 text-[10px] text-[#176b49]">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Completed for {result.rangeLabel} · {result.locationLabel} ·{" "}
          {result.timeZone}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {metrics.map(([label, value, trend]) => (
          <div
            key={label}
            className="rounded-xl border border-[#efedf2] bg-[#fafafa] px-2.5 py-2"
          >
            <div className="text-[9px] font-medium text-[#77727d]">{label}</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-[#18181b]">
              {value}
            </div>
            <div className="text-[9px] text-[#77727d]">{trendLabel(trend)}</div>
          </div>
        ))}
      </div>
      {result.highlights.length ? (
        <div>
          <h4 className="text-[10px] font-semibold text-[#302c35]">
            Highlights
          </h4>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-[10px] leading-4 text-[#5f5a66]">
            {result.highlights.map((highlight) => (
              <li key={highlight}>{highlight}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.topProducts.length ? (
        <div>
          <h4 className="text-[10px] font-semibold text-[#302c35]">
            Top products by units
          </h4>
          <div className="mt-1 divide-y divide-[#efedf2] rounded-xl border border-[#efedf2]">
            {result.topProducts.map((product) => (
              <a
                key={product.id}
                href={safeDashboardPath(product.dashboardPath)}
                className="flex items-center justify-between gap-3 px-2.5 py-2 text-[10px] hover:bg-[#faf8ff]"
              >
                <span className="truncate font-medium text-[#302c35]">
                  {product.name}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 tabular-nums text-[#6f4ce6]">
                  {product.units.toLocaleString("en-IN")} units{" "}
                  <ArrowUpRight className="h-3 w-3" />
                </span>
              </a>
            ))}
          </div>
        </div>
      ) : null}
      <a
        href={safeDashboardPath(result.analyticsPath)}
        className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#6841d9] hover:underline"
      >
        Open Analytics <ArrowUpRight className="h-3 w-3" />
      </a>
      <p className="text-[9px] text-[#8a858e]">
        Data as of {formatDate(result.dataAsOf)}. Top-product sales are
        merchandise line totals; headline net sales include completed refunds.
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: MinkWorkflowView["status"] }) {
  const label = status.replaceAll("_", " ");
  const tone =
    status === "completed"
      ? "bg-[#eafaf2] text-[#08784f]"
      : status === "failed"
        ? "bg-[#fff0ed] text-[#b42318]"
        : status === "cancelled"
          ? "bg-[#f0f0f0] text-[#68636d]"
          : "bg-[#eee8ff] text-[#613bc7]";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-semibold capitalize ${tone}`}
    >
      {label}
    </span>
  );
}

function initialWorkflow(artifact: WorkflowArtifact): MinkWorkflowView {
  const now = new Date().toISOString();
  return {
    id: artifact.runId,
    template: artifact.template,
    status: artifact.status,
    currentStep: artifact.currentStep,
    totalSteps: artifact.totalSteps,
    attemptCount: 0,
    errorCode: null,
    errorDetail: null,
    cancelRequested: false,
    result: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
}

function trendLabel(value: number | null): string {
  if (value == null) return "No comparison baseline";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-IN", { maximumFractionDigits: 1 })}% vs previous`;
}

function safeDashboardPath(value: string): string {
  return /^\/dashboard(?:[/?#]|$)/.test(value) ? value : "/dashboard";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "the latest completed step"
    : new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
