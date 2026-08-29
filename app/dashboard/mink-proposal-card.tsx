"use client";

import {
  Check,
  ExternalLink,
  History,
  LoaderCircle,
  RotateCcw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  MINK_DRAFT_CONFIG,
  type MinkDraftContent,
  type MinkDraftCreditSource,
  type MinkDraftKind,
  type MinkDraftVersionSummary,
} from "@/lib/mink/draft-types";
import type { MinkArtifact } from "@/lib/mink/types";

type Proposal = Extract<MinkArtifact, { type: "proposal" }>;
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
};

export function MinkProposalCard({ proposal }: { proposal: Proposal }) {
  const [draft, setDraft] = useState<DraftResponse>(() =>
    fromProposal(proposal),
  );
  const [content, setContent] = useState<MinkDraftContent>(proposal.content);
  const [busy, setBusy] = useState<"load" | "save" | "rollback" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const fields = MINK_DRAFT_CONFIG[draft.kind].fields;
  const dirty = useMemo(
    () =>
      fields.some((field) => content[field.key] !== draft.content[field.key]),
    [content, draft.content, fields],
  );

  useEffect(() => {
    const controller = new AbortController();
    void requestDraft(proposal.draftId, { signal: controller.signal })
      .then((next) => {
        setDraft(next);
        setContent(next.content);
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
        {fields.map((field) => (
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
            {field.multiline ? (
              <textarea
                value={content[field.key] ?? ""}
                maxLength={field.maxLength}
                rows={field.key === "content" ? 8 : 4}
                onChange={(event) =>
                  setContent((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
                className="w-full resize-y rounded-lg border border-[#dfdce5] bg-white px-2.5 py-2 text-xs leading-5 text-[#252228] outline-none focus:border-[#6d4dff] focus:ring-1 focus:ring-[#6d4dff]"
              />
            ) : (
              <input
                value={content[field.key] ?? ""}
                maxLength={field.maxLength}
                onChange={(event) =>
                  setContent((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
                className="h-9 w-full rounded-lg border border-[#dfdce5] bg-white px-2.5 text-xs text-[#252228] outline-none focus:border-[#6d4dff] focus:ring-1 focus:ring-[#6d4dff]"
              />
            )}
            <span className="mt-0.5 block text-right text-[9px] text-[#99939f]">
              {(content[field.key] ?? "").length.toLocaleString("en-IN")} /{" "}
              {field.maxLength.toLocaleString("en-IN")}
            </span>
          </label>
        ))}

        {error ? (
          <p
            role="alert"
            className="rounded-lg bg-[#fff3f2] p-2 text-[10px] leading-4 text-[#9a2c20]"
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

        <p className="rounded-lg bg-[#fff9e8] px-2.5 py-2 text-[10px] leading-4 text-[#735b17]">
          Private Mink drafts are never published or sent. Saving here does not
          change the linked dashboard record or contact a customer.
        </p>
      </div>
    </section>
  );
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
