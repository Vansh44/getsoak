"use client";

import {
  ArrowRight,
  Check,
  ExternalLink,
  Eye,
  History,
  LoaderCircle,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  MINK_DRAFT_CONFIG,
  INVENTORY_ADJUSTMENT_REASONS,
  MAX_MINK_BULK_INVENTORY_LINES,
  type MinkBulkInventoryDraftLine,
  type MinkDraftContent,
  type MinkDraftCreditSource,
  type MinkDraftKind,
  type MinkDraftVersionSummary,
} from "@/lib/mink/draft-types";
import {
  MINK_DOMAIN_FIELD_LABELS,
  domainActionFields,
  domainActionToolForDraftKind,
  isCreateDomainTool,
  type MinkDomainActionApproval,
  type MinkDomainActionResult,
} from "@/lib/mink/domain-action-types";
import type {
  MinkProductActionApproval,
  MinkProductActionResult,
} from "@/lib/mink/product-action-types";
import {
  MINK_INVENTORY_ACTION_FIELDS,
  MINK_INVENTORY_FIELD_LABELS,
  type MinkInventoryActionApproval,
  type MinkInventoryActionResult,
} from "@/lib/mink/inventory-action-types";
import type {
  MinkBulkInventoryActionApproval,
  MinkBulkInventoryActionResult,
  MinkBulkInventoryValidationDetail,
} from "@/lib/mink/bulk-inventory-action-types";
import {
  MINK_ORDER_STATUS_ACTION_FIELDS,
  MINK_ORDER_STATUS_FIELD_LABELS,
  type MinkOrderStatusActionApproval,
  type MinkOrderStatusActionResult,
} from "@/lib/mink/order-status-action-types";
import type { MinkArtifact } from "@/lib/mink/types";

type Proposal = Extract<MinkArtifact, { type: "proposal" }>;
type MinkActionApproval =
  | MinkProductActionApproval
  | MinkDomainActionApproval
  | MinkInventoryActionApproval
  | MinkBulkInventoryActionApproval
  | MinkOrderStatusActionApproval;
type MinkActionResult =
  | MinkProductActionResult
  | MinkDomainActionResult
  | MinkInventoryActionResult
  | MinkBulkInventoryActionResult
  | MinkOrderStatusActionResult;
type DraftResponse = {
  id: string;
  kind: MinkDraftKind;
  title: string;
  status: "proposed" | "draft";
  destinationLabel: string;
  destinationPath: string;
  before: MinkDraftContent;
  content: MinkDraftContent;
  currentVersion: number;
  expectedCredits: number;
  chargedCredits: number;
  creditSource: MinkDraftCreditSource;
  versions: MinkDraftVersionSummary[];
  lastProductAction: MinkProductActionResult | null;
  lastDomainAction: MinkDomainActionResult | null;
  lastInventoryAction: MinkInventoryActionResult | null;
  lastBulkInventoryAction: MinkBulkInventoryActionResult | null;
  lastOrderStatusAction: MinkOrderStatusActionResult | null;
};

export function MinkProposalCard({ proposal }: { proposal: Proposal }) {
  const [draft, setDraft] = useState<DraftResponse>(() =>
    fromProposal(proposal),
  );
  const [content, setContent] = useState<MinkDraftContent>(proposal.content);
  const [busy, setBusy] = useState<"load" | "save" | "rollback" | null>("load");
  const [actionBusy, setActionBusy] = useState<
    "preview" | "execute" | "rollback" | null
  >(null);
  const [approval, setApproval] = useState<MinkActionApproval | null>(null);
  const [actionResult, setActionResult] = useState<MinkActionResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const fields = MINK_DRAFT_CONFIG[draft.kind].fields;
  const dirty = useMemo(
    () =>
      fields.some((field) => content[field.key] !== draft.content[field.key]),
    [content, draft.content, fields],
  );
  const supportsProductAction =
    draft.kind === "product_description" || draft.kind === "product_seo";
  const supportsDomainAction =
    domainActionToolForDraftKind(draft.kind) !== null;
  const supportsInventoryAction = draft.kind === "inventory_adjustment";
  const supportsBulkInventoryAction =
    draft.kind === "bulk_inventory_adjustment";
  const supportsOrderStatusAction = draft.kind === "order_status_transition";
  const supportsLiveAction =
    supportsProductAction ||
    supportsDomainAction ||
    supportsInventoryAction ||
    supportsBulkInventoryAction ||
    supportsOrderStatusAction;

  useEffect(() => {
    const controller = new AbortController();
    void requestDraft(proposal.draftId, { signal: controller.signal })
      .then((next) => {
        setDraft(next);
        setContent(next.content);
        setApproval(null);
        setActionResult(
          next.lastProductAction ??
            next.lastDomainAction ??
            next.lastInventoryAction ??
            next.lastBulkInventoryAction ??
            next.lastOrderStatusAction,
        );
        setError(null);
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "This private draft could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [proposal.draftId]);

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const next = await requestDraft(proposal.draftId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          expectedVersion: draft.currentVersion,
          content,
        }),
      });
      setDraft(next);
      setContent(next.content);
      setApproval(null);
      setActionResult(
        next.lastProductAction ??
          next.lastDomainAction ??
          next.lastInventoryAction ??
          next.lastBulkInventoryAction ??
          next.lastOrderStatusAction,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The private draft could not be saved.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function rollback(targetVersion: number) {
    setBusy("rollback");
    setError(null);
    try {
      const next = await requestDraft(proposal.draftId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "rollback",
          expectedVersion: draft.currentVersion,
          targetVersion,
        }),
      });
      setDraft(next);
      setContent(next.content);
      setApproval(null);
      setActionResult(
        next.lastProductAction ??
          next.lastDomainAction ??
          next.lastInventoryAction ??
          next.lastBulkInventoryAction ??
          next.lastOrderStatusAction,
      );
    } catch (rollbackError) {
      setError(
        rollbackError instanceof Error
          ? rollbackError.message
          : "That version could not be restored.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function reviewLiveAction() {
    setActionBusy("preview");
    setError(null);
    try {
      const next = await requestLiveAction(
        proposal.draftId,
        supportsBulkInventoryAction
          ? "bulk_inventory"
          : supportsOrderStatusAction
            ? "order_status"
            : supportsInventoryAction
              ? "inventory"
              : supportsDomainAction
                ? "domain"
                : "product",
        {
          action: "preview",
          expectedDraftVersion: draft.currentVersion,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setApproval(next.approval ?? null);
      setActionResult(null);
    } catch (reviewError) {
      setError(
        reviewError instanceof Error
          ? reviewError.message
          : "The dashboard change could not be reviewed.",
      );
    } finally {
      setActionBusy(null);
    }
  }

  async function executeLiveAction() {
    if (!approval) return;
    setActionBusy("execute");
    setError(null);
    try {
      const next = await requestLiveAction(
        proposal.draftId,
        supportsBulkInventoryAction
          ? "bulk_inventory"
          : supportsOrderStatusAction
            ? "order_status"
            : supportsInventoryAction
              ? "inventory"
              : supportsDomainAction
                ? "domain"
                : "product",
        {
          action: "execute",
          approvalId: approval.id,
        },
      );
      if (!next.result) throw new Error("The action result is unavailable.");
      setApproval(next.result.approval);
      setActionResult(next.result);
    } catch (executeError) {
      setApproval(null);
      setError(
        executeError instanceof Error
          ? executeError.message
          : "The dashboard change was not applied.",
      );
    } finally {
      setActionBusy(null);
    }
  }

  async function reviewLiveRollback() {
    if (
      !actionResult ||
      supportsInventoryAction ||
      supportsBulkInventoryAction ||
      supportsOrderStatusAction
    )
      return;
    setActionBusy("rollback");
    setError(null);
    try {
      const next = await requestLiveAction(
        proposal.draftId,
        supportsDomainAction ? "domain" : "product",
        {
          action: "preview_rollback",
          sourceApprovalId: actionResult.approval.id,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      setApproval(next.approval ?? null);
      setActionResult(null);
    } catch (rollbackError) {
      setError(
        rollbackError instanceof Error
          ? rollbackError.message
          : "A safe rollback preview is not available.",
      );
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-[#ddd6f5] bg-white shadow-sm">
      <header className="border-b border-[#eeeaf8] bg-[#faf8ff] px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[#6d4dff]">
              Private proposal · {MINK_DRAFT_CONFIG[draft.kind].label}
            </div>
            <h4 className="truncate text-xs font-semibold text-[#292235]">
              {draft.title}
            </h4>
          </div>
          <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[10px] font-medium text-[#665c75] ring-1 ring-[#ddd6f5]">
            {draft.currentVersion > 0
              ? `Draft v${draft.currentVersion}`
              : "Not saved"}
          </span>
        </div>
        <a
          href={draft.destinationPath}
          className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-[#5b3fd0] hover:underline"
        >
          {draft.destinationLabel} <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </header>

      <div className="space-y-3 p-3">
        {draft.kind === "bulk_inventory_adjustment" ? (
          <BulkInventoryDraftEditor
            value={content.lines_json ?? "[]"}
            disabled={busy !== null || actionBusy !== null}
            onChange={(lines) =>
              changeContent("lines_json", JSON.stringify(lines))
            }
          />
        ) : (
          fields.map((field) => (
            <label key={field.key} className="block">
              <span className="mb-1 block text-[10px] font-semibold text-[#5f5868]">
                {field.label}
              </span>
              {draft.before[field.key] ? (
                <details className="mb-1.5 rounded-lg bg-[#f6f6f7] px-2.5 py-2 text-[10px] text-[#77717d]">
                  <summary className="cursor-pointer font-medium">
                    Current text
                  </summary>
                  <div className="mt-1 whitespace-pre-wrap break-words">
                    {draft.before[field.key]}
                  </div>
                </details>
              ) : null}
              {draft.kind === "order_status_transition" &&
              field.key === "target_status" ? (
                <select
                  value={content[field.key] ?? ""}
                  onChange={(event) =>
                    changeContent(field.key, event.target.value)
                  }
                  className="h-9 w-full rounded-lg border border-[#dfdce5] bg-white px-2.5 text-xs text-[#252228] outline-none focus:border-[#6d4dff] focus:ring-1 focus:ring-[#6d4dff]"
                >
                  <option value="processing">Processing</option>
                  <option value="shipped">Shipped</option>
                  <option value="delivered">Delivered</option>
                </select>
              ) : field.multiline ? (
                <textarea
                  value={content[field.key] ?? ""}
                  maxLength={field.maxLength}
                  rows={field.key === "content" ? 8 : 4}
                  onChange={(event) =>
                    changeContent(field.key, event.target.value)
                  }
                  className="w-full resize-y rounded-lg border border-[#dfdce5] bg-white px-2.5 py-2 text-xs leading-5 text-[#252228] outline-none focus:border-[#6d4dff] focus:ring-1 focus:ring-[#6d4dff]"
                />
              ) : (
                <input
                  value={content[field.key] ?? ""}
                  maxLength={field.maxLength}
                  onChange={(event) =>
                    changeContent(field.key, event.target.value)
                  }
                  className="h-9 w-full rounded-lg border border-[#dfdce5] bg-white px-2.5 text-xs text-[#252228] outline-none focus:border-[#6d4dff] focus:ring-1 focus:ring-[#6d4dff]"
                />
              )}
              <span className="mt-0.5 block text-right text-[9px] text-[#99939f]">
                {(content[field.key] ?? "").length.toLocaleString("en-IN")} /{" "}
                {field.maxLength.toLocaleString("en-IN")}
              </span>
            </label>
          ))
        )}

        {error ? (
          <p
            role="alert"
            className="whitespace-pre-wrap rounded-lg bg-[#fff3f2] p-2 text-[10px] leading-4 text-[#9a2c20]"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1 text-[10px] text-[#6c6573]">
            {draft.chargedCredits > 0 ? (
              <Check className="h-3 w-3 text-emerald-600" />
            ) : (
              <ShieldCheck className="h-3 w-3 text-emerald-600" />
            )}
            {draft.chargedCredits > 0
              ? `${draft.chargedCredits} credits charged at proposal creation`
              : "Included in unlimited plan"}
          </span>
          <button
            type="button"
            onClick={save}
            disabled={busy !== null || (draft.currentVersion > 0 && !dirty)}
            className="inline-flex items-center gap-1 rounded-lg bg-[#6d4dff] px-3 py-2 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy === "save" ? (
              <LoaderCircle className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            {draft.currentVersion > 0
              ? "Save new version"
              : "Save private draft"}
          </button>
        </div>

        {draft.versions.length ? (
          <details className="rounded-lg border border-[#eeeaf1] p-2.5">
            <summary className="flex cursor-pointer items-center gap-1 text-[10px] font-semibold text-[#5f5868]">
              <History className="h-3 w-3" /> Version history
            </summary>
            <div className="mt-2 space-y-1">
              {draft.versions.map((version) => (
                <div
                  key={version.version}
                  className="flex items-center justify-between gap-2 rounded-md bg-[#f8f7f9] px-2 py-1.5 text-[10px] text-[#6c6573]"
                >
                  <span>
                    v{version.version} · {version.action}
                  </span>
                  {version.version < draft.currentVersion ? (
                    <button
                      type="button"
                      onClick={() => rollback(version.version)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 font-semibold text-[#5b3fd0] hover:underline disabled:opacity-50"
                    >
                      <RotateCcw className="h-2.5 w-2.5" /> Restore
                    </button>
                  ) : (
                    <span className="font-medium text-emerald-700">
                      Current
                    </span>
                  )}
                </div>
              ))}
            </div>
          </details>
        ) : null}

        {supportsLiveAction && draft.currentVersion > 0 ? (
          <div className="space-y-2 rounded-lg border border-[#ddd6f5] bg-[#fcfbff] p-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-[10px] font-semibold text-[#3d3155]">
                  {actionHeading(draft.kind)}
                </div>
                <p className="mt-0.5 text-[9px] leading-4 text-[#746c7d]">
                  {actionScope(draft.kind)}
                </p>
              </div>
              {!approval && !actionResult ? (
                <button
                  type="button"
                  onClick={reviewLiveAction}
                  disabled={busy !== null || actionBusy !== null || dirty}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#6d4dff] bg-white px-2.5 py-1.5 text-[10px] font-semibold text-[#5b3fd0] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {actionBusy === "preview" ? (
                    <LoaderCircle className="h-3 w-3 animate-spin" />
                  ) : (
                    <Eye className="h-3 w-3" />
                  )}
                  Review exact change
                </button>
              ) : null}
            </div>

            {dirty ? (
              <p className="text-[9px] font-medium text-amber-700">
                Save this draft version before reviewing a live change.
              </p>
            ) : null}

            {approval?.status === "pending" ? (
              <div className="space-y-2 rounded-lg border border-[#d8cef8] bg-white p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold text-[#44365f]">
                    Exact{" "}
                    {approval.operation === "apply" ? "change" : "rollback"}{" "}
                    preview
                  </span>
                  <span className="text-[9px] text-[#82798d]">
                    Expires {formatActionTime(approval.expiresAt)}
                  </span>
                </div>
                {isBulkInventoryApproval(approval) ? (
                  <BulkInventoryActionPreview lines={approval.lines} />
                ) : (
                  actionPreviewFields(approval, fields).map((field) => (
                    <div key={field.key} className="space-y-1">
                      <div className="text-[9px] font-semibold text-[#5f5868]">
                        {field.label}
                      </div>
                      <div className="grid gap-1.5 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                        <ActionValue value={approval.before[field.key]} />
                        <ArrowRight className="mx-auto h-3 w-3 text-[#8a8194]" />
                        <ActionValue
                          value={approval.after[field.key]}
                          proposed
                        />
                      </div>
                    </div>
                  ))
                )}
                <div className="flex flex-wrap justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setApproval(null)}
                    disabled={actionBusy !== null}
                    className="rounded-lg px-2.5 py-1.5 text-[10px] font-semibold text-[#665c75] hover:bg-[#f3f1f6] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={executeLiveAction}
                    disabled={actionBusy !== null}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#6d4dff] px-2.5 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50"
                  >
                    {actionBusy === "execute" ? (
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3 w-3" />
                    )}
                    Approve and{" "}
                    {approval.operation === "apply" ? "apply" : "roll back"}
                  </button>
                </div>
              </div>
            ) : null}

            {actionResult?.approval.status === "executed" ? (
              <div className="rounded-lg bg-[#ecfdf3] p-2.5 text-[10px] text-[#166534]">
                <div className="flex items-start gap-1.5">
                  <Check className="mt-0.5 h-3 w-3 shrink-0" />
                  <div>
                    <div className="font-semibold">
                      {actionSuccessMessage(actionResult.approval)}
                    </div>
                    {!actionRemovedResource(actionResult.approval) ? (
                      <a
                        href={
                          actionResource(actionResult.approval).dashboardPath
                        }
                        className="mt-1 inline-flex items-center gap-1 font-semibold underline"
                      >
                        Open {actionResource(actionResult.approval).label}
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    ) : (
                      <div className="mt-1">The unused record was removed.</div>
                    )}
                  </div>
                </div>
                {actionResult.approval.operation === "apply" &&
                !isAnyNonRollbackApproval(actionResult.approval) ? (
                  <button
                    type="button"
                    onClick={reviewLiveRollback}
                    disabled={actionBusy !== null}
                    className="mt-2 inline-flex items-center gap-1 font-semibold underline disabled:opacity-50"
                  >
                    {actionBusy === "rollback" ? (
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Review safe rollback
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <p className="rounded-lg bg-[#fff9e8] px-2.5 py-2 text-[10px] leading-4 text-[#735b17]">
          Saving this private draft never changes a dashboard record, publishes
          content or contacts a customer. A separately enabled product-text
          action changes only the exact fields shown after you approve its
          preview. Product creation stays draft-only, coupon actions stay
          disabled and hidden, and customer-group membership is never changed.
          Single-SKU inventory proposals affect one exact tracked item and
          location. Bulk proposals are separately gated, capped at 20 lines,
          reviewed line by line and applied atomically only after approval.
          Order-status proposals are one exact delivery order and one forward
          step; they never cancel, refund, alter payment or contact a customer.
        </p>
      </div>
    </section>
  );

  function changeContent(field: string, value: string) {
    setContent((current) => ({ ...current, [field]: value }));
    setApproval(null);
    setActionResult(null);
  }
}

function ActionValue({
  value,
  proposed = false,
}: {
  value: string | null | undefined;
  proposed?: boolean;
}) {
  return (
    <div
      className={`max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md p-2 text-[9px] leading-4 ${
        proposed ? "bg-[#f2edff] text-[#3d2b73]" : "bg-[#f5f5f6] text-[#5f5868]"
      }`}
    >
      {value || <span className="italic text-[#99939f]">Empty</span>}
    </div>
  );
}

function formatActionTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "soon"
    : date.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
      });
}

function fromProposal(proposal: Proposal): DraftResponse {
  return {
    id: proposal.draftId,
    kind: proposal.draftKind,
    title: proposal.title,
    status: proposal.status,
    destinationLabel: proposal.destinationLabel,
    destinationPath: proposal.destinationPath,
    before: Object.fromEntries(
      proposal.before.map((field) => [field.key, field.value]),
    ),
    content: proposal.content,
    currentVersion: proposal.currentVersion,
    expectedCredits: proposal.expectedCredits,
    chargedCredits: proposal.chargedCredits,
    creditSource: proposal.creditSource,
    versions: [],
    lastProductAction: null,
    lastDomainAction: null,
    lastInventoryAction: null,
    lastBulkInventoryAction: null,
    lastOrderStatusAction: null,
  };
}

async function requestDraft(
  draftId: string,
  init?: RequestInit,
): Promise<DraftResponse> {
  const response = await fetch(`/api/mink/drafts/${draftId}`, {
    cache: "no-store",
    ...init,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    draft?: DraftResponse;
    error?: string;
  };
  if (!response.ok || !payload.draft) {
    throw new Error(payload.error ?? "This private draft is unavailable.");
  }
  return payload.draft;
}

async function requestLiveAction(
  draftId: string,
  actionType:
    | "product"
    | "domain"
    | "inventory"
    | "bulk_inventory"
    | "order_status",
  body: Record<string, unknown>,
): Promise<{
  approval?: MinkActionApproval;
  result?: MinkActionResult;
}> {
  const endpoint =
    actionType === "bulk_inventory"
      ? "bulk-inventory-action"
      : actionType === "order_status"
        ? "order-status-action"
        : actionType === "inventory"
          ? "inventory-action"
          : actionType === "domain"
            ? "action"
            : "product-action";
  const response = await fetch(`/api/mink/drafts/${draftId}/${endpoint}`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    approval?: MinkActionApproval;
    result?: MinkActionResult;
    error?: string;
    lineErrors?: MinkBulkInventoryValidationDetail[];
  };
  if (!response.ok) {
    const lineDetail = payload.lineErrors
      ?.slice(0, MAX_MINK_BULK_INVENTORY_LINES)
      .map(
        (line) =>
          `Line ${line.line} (${line.sku} at ${line.location}): ${line.message}`,
      )
      .join("\n");
    throw new Error(
      [payload.error ?? "The Mink action is unavailable.", lineDetail]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return payload;
}

function actionPreviewFields(
  approval: MinkActionApproval,
  draftFields: Array<{ key: string; label: string }>,
) {
  if ("product" in approval) return draftFields;
  if (isSingleInventoryApproval(approval)) {
    return MINK_INVENTORY_ACTION_FIELDS.map((key) => ({
      key,
      label: MINK_INVENTORY_FIELD_LABELS[key] ?? key.replaceAll("_", " "),
    }));
  }
  if (isBulkInventoryApproval(approval)) return [];
  if (isOrderStatusApproval(approval)) {
    return MINK_ORDER_STATUS_ACTION_FIELDS.map((key) => ({
      key,
      label: MINK_ORDER_STATUS_FIELD_LABELS[key] ?? key.replaceAll("_", " "),
    }));
  }
  return domainActionFields(approval.toolName).map((key) => ({
    key,
    label: MINK_DOMAIN_FIELD_LABELS[key] ?? key.replaceAll("_", " "),
  }));
}

function actionResource(approval: MinkActionApproval) {
  if ("product" in approval) {
    return {
      label: approval.product.name,
      dashboardPath: approval.product.dashboardPath,
    };
  }
  return {
    label: approval.resource.label,
    dashboardPath: approval.resource.dashboardPath,
  };
}

function actionHeading(kind: MinkDraftKind) {
  if (kind === "product_create") return "Create an unpublished draft product";
  if (kind === "coupon_create") return "Create a disabled, hidden coupon";
  if (kind === "coupon_update") return "Update disabled coupon terms";
  if (kind === "customer_group_create") return "Create customer-group metadata";
  if (kind === "customer_group_update") return "Update customer-group metadata";
  if (kind === "inventory_adjustment") return "Adjust one SKU at one location";
  if (kind === "bulk_inventory_adjustment") {
    return "Adjust up to 20 SKU/location lines atomically";
  }
  if (kind === "order_status_transition") {
    return "Advance one delivery order by one status";
  }
  return "Apply to the linked product";
}

function actionScope(kind: MinkDraftKind) {
  if (kind === "product_create") {
    return "Requires Products Manage and its operator kill switch. The product stays draft, untracked and without variants, stock, images or category.";
  }
  if (kind === "coupon_create" || kind === "coupon_update") {
    return "Requires Marketing Manage and its operator kill switch. Activation, storefront visibility, usage and customer-group audience are outside this action.";
  }
  if (kind === "customer_group_create" || kind === "customer_group_update") {
    return "Requires Users Manage and its operator kill switch. Only name, description and colour can change; membership is outside this action.";
  }
  if (kind === "inventory_adjustment") {
    return "Requires Inventory Manage and its independent operator kill switch. SKU, active location, signed quantity, resulting stock, reason and note are rechecked at approval; bulk changes are outside this action.";
  }
  if (kind === "bulk_inventory_adjustment") {
    return "Requires Inventory Manage and a separate bulk-action kill switch. Every exact line is revalidated; one invalid or stale line prevents the entire batch from changing stock.";
  }
  if (kind === "order_status_transition") {
    return "Requires Orders Manage and its independent operator kill switch. Only pending → processing → shipped → delivered is supported, one exact step at a time; payment, cancellation, pickup, POS and customer contact stay outside this action.";
  }
  return "Requires Products Manage permission and a separate operator kill switch. Price, stock, status and publishing are outside this action.";
}

function actionSuccessMessage(approval: MinkActionApproval) {
  if (approval.operation === "rollback")
    return "Approved safe rollback completed.";
  if ("product" in approval) return "Approved text applied to the product.";
  if (isSingleInventoryApproval(approval)) {
    return "Approved inventory adjustment recorded for the exact SKU and location.";
  }
  if (isBulkInventoryApproval(approval)) {
    return `Approved atomic inventory batch recorded for ${approval.lines.length} lines.`;
  }
  if (isOrderStatusApproval(approval)) {
    return `Approved order status changed to ${approval.after.status}.`;
  }
  if (isCreateDomainTool(approval.toolName)) {
    return `Approved ${approval.resource.type.replace("_", " ")} created.`;
  }
  return `Approved ${approval.resource.type.replace("_", " ")} metadata updated.`;
}

function actionRemovedResource(approval: MinkActionApproval) {
  return (
    !("product" in approval) &&
    !isAnyInventoryApproval(approval) &&
    approval.operation === "rollback" &&
    isCreateDomainTool(approval.toolName)
  );
}

function isSingleInventoryApproval(
  approval: MinkActionApproval,
): approval is MinkInventoryActionApproval {
  return !("product" in approval) && approval.resource.type === "inventory";
}

function isBulkInventoryApproval(
  approval: MinkActionApproval,
): approval is MinkBulkInventoryActionApproval {
  return (
    !("product" in approval) && approval.resource.type === "inventory_bulk"
  );
}

function isAnyInventoryApproval(
  approval: MinkActionApproval,
): approval is MinkInventoryActionApproval | MinkBulkInventoryActionApproval {
  return (
    isSingleInventoryApproval(approval) || isBulkInventoryApproval(approval)
  );
}

function isOrderStatusApproval(
  approval: MinkActionApproval,
): approval is MinkOrderStatusActionApproval {
  return !("product" in approval) && approval.resource.type === "order";
}

function isAnyNonRollbackApproval(
  approval: MinkActionApproval,
): approval is
  | MinkInventoryActionApproval
  | MinkBulkInventoryActionApproval
  | MinkOrderStatusActionApproval {
  return isAnyInventoryApproval(approval) || isOrderStatusApproval(approval);
}

function BulkInventoryDraftEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (lines: MinkBulkInventoryDraftLine[]) => void;
}) {
  const lines = useMemo(() => {
    return readEditableBulkLines(value);
  }, [value]);

  function updateLine(
    index: number,
    patch: Partial<MinkBulkInventoryDraftLine>,
  ) {
    onChange(
      lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold text-[#5f5868]">
            Inventory lines
          </div>
          <p className="text-[9px] text-[#82798d]">
            {lines.length} / {MAX_MINK_BULK_INVENTORY_LINES} exact SKU and
            location pairs
          </p>
        </div>
        <button
          type="button"
          disabled={disabled || lines.length >= MAX_MINK_BULK_INVENTORY_LINES}
          onClick={() =>
            onChange([
              ...lines,
              {
                sku: "",
                location: "",
                quantity_change: 1,
                reason: "correction",
                note: "",
              },
            ])
          }
          className="inline-flex items-center gap-1 rounded-md border border-[#d8cef8] px-2 py-1 text-[9px] font-semibold text-[#5b3fd0] disabled:opacity-45"
        >
          <Plus className="h-2.5 w-2.5" /> Add line
        </button>
      </div>
      {lines.map((line, index) => (
        <div
          key={index}
          className="space-y-2 rounded-lg border border-[#eeeaf1] bg-[#fcfbfd] p-2.5"
        >
          <div className="flex items-center justify-between gap-2 text-[9px] font-semibold text-[#5f5868]">
            <span>Line {index + 1}</span>
            <button
              type="button"
              aria-label={`Delete bulk inventory line ${index + 1}`}
              disabled={disabled || lines.length <= 1}
              onClick={() => onChange(lines.filter((_, i) => i !== index))}
              className="text-red-600 disabled:opacity-35"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <BulkInput
              label="Exact SKU"
              value={line.sku}
              maxLength={100}
              disabled={disabled}
              onChange={(next) => updateLine(index, { sku: next })}
            />
            <BulkInput
              label="Exact active location"
              value={line.location}
              maxLength={100}
              disabled={disabled}
              onChange={(next) => updateLine(index, { location: next })}
            />
            <BulkInput
              label="Quantity change"
              value={String(line.quantity_change)}
              disabled={disabled}
              inputMode="numeric"
              onChange={(next) =>
                updateLine(index, {
                  quantity_change: Number(next),
                })
              }
            />
            <label className="block">
              <span className="mb-1 block text-[9px] font-semibold text-[#5f5868]">
                Reason
              </span>
              <select
                value={line.reason}
                disabled={disabled}
                onChange={(event) =>
                  updateLine(index, {
                    reason: event.target
                      .value as MinkBulkInventoryDraftLine["reason"],
                  })
                }
                className="h-8 w-full rounded-md border border-[#dfdce5] bg-white px-2 text-[10px] outline-none focus:border-[#6d4dff]"
              >
                {INVENTORY_ADJUSTMENT_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <BulkInput
            label={
              line.reason === "other" ? "Audit note (required)" : "Audit note"
            }
            value={line.note}
            maxLength={200}
            disabled={disabled}
            onChange={(next) => updateLine(index, { note: next })}
          />
        </div>
      ))}
    </div>
  );
}

function readEditableBulkLines(value: string): MinkBulkInventoryDraftLine[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_MINK_BULK_INVENTORY_LINES).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const reason = INVENTORY_ADJUSTMENT_REASONS.includes(row.reason as never)
        ? (row.reason as MinkBulkInventoryDraftLine["reason"])
        : "correction";
      return [
        {
          sku: typeof row.sku === "string" ? row.sku : "",
          location: typeof row.location === "string" ? row.location : "",
          quantity_change:
            typeof row.quantity_change === "number"
              ? row.quantity_change
              : Number(row.quantity_change ?? 0),
          reason,
          note: typeof row.note === "string" ? row.note : "",
        },
      ];
    });
  } catch {
    return [];
  }
}

function BulkInput({
  label,
  value,
  disabled,
  maxLength,
  inputMode,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  maxLength?: number;
  inputMode?: "numeric";
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[9px] font-semibold text-[#5f5868]">
        {label}
      </span>
      <input
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-[#dfdce5] bg-white px-2 text-[10px] outline-none focus:border-[#6d4dff]"
      />
    </label>
  );
}

function BulkInventoryActionPreview({
  lines,
}: {
  lines: MinkBulkInventoryActionApproval["lines"];
}) {
  return (
    <div className="space-y-1.5">
      {lines.map((line) => (
        <div
          key={line.line}
          className="rounded-md border border-[#eeeaf1] bg-[#fcfbfd] p-2 text-[9px]"
        >
          <div className="font-semibold text-[#44365f]">
            {line.line}. {line.product}
            {line.variant ? ` · ${line.variant}` : ""} ({line.sku})
          </div>
          <div className="mt-0.5 text-[#746c7d]">{line.location}</div>
          <div className="mt-1 grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
            <ActionValue
              value={`${line.onHand} on hand · ${line.available} available`}
            />
            <ArrowRight className="h-3 w-3 text-[#8a8194]" />
            <ActionValue
              value={`${line.resultingOnHand} on hand · ${line.resultingAvailable} available (${line.quantityChange > 0 ? "+" : ""}${line.quantityChange})`}
              proposed
            />
          </div>
          <div className="mt-1 text-[#746c7d]">
            Reason: {line.reason}
            {line.note ? ` · ${line.note}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
