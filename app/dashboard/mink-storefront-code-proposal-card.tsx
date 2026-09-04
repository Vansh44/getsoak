"use client";

import {
  Code2,
  ExternalLink,
  LoaderCircle,
  Monitor,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { CustomCodeFrame } from "@/app/(storefront)/components/sections/custom-code-frame";
import { validateConfig, type CustomCodeConfig } from "@/lib/sections/registry";
import type { MinkStorefrontCodePreviewDto } from "@/lib/mink/storefront-code-preview-types";
import type { MinkArtifact } from "@/lib/mink/types";

type Proposal = Extract<MinkArtifact, { type: "storefront_code_proposal" }>;
type SourceField = "html" | "css" | "js";

export function MinkStorefrontCodeProposalCard({
  proposal,
}: {
  proposal: Proposal;
}) {
  const [result, setResult] = useState<{
    draftId: string;
    preview: MinkStorefrontCodePreviewDto | null;
    error: string | null;
  } | null>(null);
  const [view, setView] = useState<"desktop" | "mobile">("desktop");
  const [tab, setTab] = useState<"preview" | SourceField>("preview");

  useEffect(() => {
    const controller = new AbortController();
    void requestPreview(proposal.draftId, controller.signal)
      .then((result) => {
        setResult({
          draftId: proposal.draftId,
          preview: result,
          error: null,
        });
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return;
        setResult({
          draftId: proposal.draftId,
          preview: null,
          error:
            requestError instanceof Error
              ? requestError.message
              : "This private preview could not be loaded.",
        });
      });
    return () => controller.abort();
  }, [proposal.draftId]);

  const loading = result?.draftId !== proposal.draftId;
  const preview = loading ? null : result.preview;
  const error = loading ? null : result.error;
  const targetTone = preview?.targetState ?? "current";
  const changedLabel = proposal.changedFields.length
    ? proposal.changedFields.join(", ")
    : "none";

  return (
    <section className="overflow-hidden rounded-2xl border border-[#ddd6fe] bg-white shadow-[0_1px_3px_rgba(38,25,77,0.08)]">
      <header className="border-b border-[#ebe7f7] bg-[#fbfaff] px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#6d4dff] text-white">
              <Code2 className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold text-[#27242d]">
                {proposal.title}
              </h3>
              <p className="mt-0.5 text-[9px] text-[#716d78]">
                Private preview · {proposal.expectedCredits} AI credits · no
                builder changes
              </p>
            </div>
          </div>
          <a
            href={proposal.destinationPath}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-[9px] font-semibold text-[#5d3fe3] hover:underline"
          >
            Open Builder <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </header>

      <div className="space-y-3 p-3">
        <div className="flex flex-wrap gap-1.5 text-[9px]">
          <Badge>Page: {proposal.target.pageSlug}</Badge>
          <Badge>Changed: {changedLabel}</Badge>
          <Badge>
            {proposal.beforeCharacters.toLocaleString("en-IN")} →{" "}
            {proposal.afterCharacters.toLocaleString("en-IN")} chars
          </Badge>
        </div>
        <p className="text-[11px] leading-5 text-[#39363f]">
          {proposal.explanation}
        </p>

        {loading ? (
          <div className="flex min-h-28 items-center justify-center gap-2 rounded-xl border border-[#eeeaf8] bg-[#faf9fc] text-[10px] text-[#716d78]">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Validating private preview…
          </div>
        ) : error ? (
          <div className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] leading-4 text-rose-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : preview ? (
          <>
            <div
              className={`flex gap-2 rounded-xl border p-2.5 text-[9px] leading-4 ${
                targetTone === "current"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              {targetTone === "current" ? (
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span>{preview.targetMessage}</span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex rounded-lg border border-[#e7e3ef] bg-[#f7f6f9] p-0.5">
                {(["preview", "html", "css", "js"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setTab(item)}
                    className={`rounded-md px-2 py-1 text-[9px] font-semibold uppercase tracking-wide ${
                      tab === item
                        ? "bg-white text-[#4f35c8] shadow-sm"
                        : "text-[#77727f]"
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              {tab === "preview" ? (
                <div className="flex rounded-lg border border-[#e7e3ef] p-0.5">
                  <ViewportButton
                    active={view === "desktop"}
                    label="Desktop"
                    onClick={() => setView("desktop")}
                    icon={<Monitor className="h-3 w-3" />}
                  />
                  <ViewportButton
                    active={view === "mobile"}
                    label="Mobile"
                    onClick={() => setView("mobile")}
                    icon={<Smartphone className="h-3 w-3" />}
                  />
                </div>
              ) : null}
            </div>

            {tab === "preview" ? (
              <div className="overflow-auto rounded-xl border border-[#ded9e8] bg-[#f1eff4] p-2">
                <div
                  data-testid="mink-storefront-preview-viewport"
                  data-viewport={view}
                  className={`mx-auto overflow-hidden rounded-lg bg-white shadow-sm transition-[width] ${
                    view === "mobile" ? "w-[390px] max-w-full" : "w-full"
                  }`}
                >
                  <CustomCodeFrame
                    config={preview.proposedConfig}
                    title={`${proposal.destinationLabel} private Mink preview`}
                    strictNetworkIsolation
                  />
                </div>
              </div>
            ) : (
              <SourceCompare
                field={tab}
                before={preview.beforeConfig}
                after={preview.proposedConfig}
              />
            )}

            <details className="rounded-xl border border-[#eeeaf8] bg-[#fbfaff] px-3 py-2">
              <summary className="cursor-pointer text-[9px] font-semibold text-[#4a4260]">
                Security and validation details
              </summary>
              <ul className="mt-2 space-y-1 text-[9px] leading-4 text-[#696471]">
                {preview.validationChecks.map((check) => (
                  <li key={check} className="flex gap-1.5">
                    <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                    <span>{check}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 break-all font-mono text-[8px] text-[#8a8490]">
                Patch SHA-256: {preview.patchDigest}
              </div>
            </details>
          </>
        ) : null}

        <div className="rounded-xl border border-[#e5e1eb] bg-[#f8f7fa] px-3 py-2 text-[9px] leading-4 text-[#65616b]">
          This proposal is immutable and preview-only. Phase 7B cannot edit or
          save the Website Builder draft, publish the page, access StoreMink
          source code, run shell commands or deploy.
        </div>
      </div>
    </section>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[#ddd6fe] bg-[#f8f5ff] px-2 py-1 font-medium text-[#564a70]">
      {children}
    </span>
  );
}

function ViewportButton({
  active,
  label,
  onClick,
  icon,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[9px] font-semibold ${
        active ? "bg-[#eee9ff] text-[#4f35c8]" : "text-[#77727f]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function SourceCompare({
  field,
  before,
  after,
}: {
  field: SourceField;
  before: CustomCodeConfig;
  after: CustomCodeConfig;
}) {
  const beforeSource = before[field];
  const afterSource = after[field];
  const changed = beforeSource !== afterSource;
  return (
    <div className="grid gap-2 lg:grid-cols-2">
      <SourcePanel title="Current builder code" source={beforeSource} />
      <SourcePanel
        title={changed ? "Proposed code" : "Proposed code · unchanged"}
        source={afterSource}
      />
    </div>
  );
}

function SourcePanel({ title, source }: { title: string; source: string }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-[#e5e1eb] bg-[#17151b]">
      <div className="border-b border-white/10 px-2.5 py-1.5 text-[8px] font-semibold uppercase tracking-wide text-[#c8c2d2]">
        {title} · {source.length.toLocaleString("en-IN")} chars
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words p-2.5 text-[9px] leading-4 text-[#f3eff8]">
        <code>{source || "(empty)"}</code>
      </pre>
    </div>
  );
}

async function requestPreview(
  draftId: string,
  signal: AbortSignal,
): Promise<MinkStorefrontCodePreviewDto> {
  const response = await fetch(
    `/api/mink/drafts/${encodeURIComponent(draftId)}/storefront-code-preview`,
    { signal, cache: "no-store", headers: { Accept: "application/json" } },
  );
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      readError(body) ?? "This private preview could not be loaded.",
    );
  }
  return readPreview(body, draftId);
}

function readPreview(
  value: unknown,
  expectedId: string,
): MinkStorefrontCodePreviewDto {
  if (!isRecord(value) || !isRecord(value.preview)) {
    throw new Error("The private preview response was malformed.");
  }
  const preview = value.preview;
  const before = validateConfig("custom_code", preview.beforeConfig, "draft");
  const proposed = validateConfig(
    "custom_code",
    preview.proposedConfig,
    "draft",
  );
  if (
    preview.id !== expectedId ||
    !boundedText(preview.title, 120) ||
    !boundedText(preview.destinationLabel, 180) ||
    typeof preview.destinationPath !== "string" ||
    preview.destinationPath.length > 400 ||
    !preview.destinationPath.startsWith("/dashboard/builder") ||
    !boundedText(preview.explanation, 1_000) ||
    !isRecord(preview.target) ||
    !boundedText(preview.target.pageSlug, 60) ||
    !boundedText(preview.target.sectionId, 128) ||
    !boundedText(preview.target.expectedPageVersion, 40) ||
    Number.isNaN(Date.parse(preview.target.expectedPageVersion)) ||
    typeof preview.target.expectedSectionDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(preview.target.expectedSectionDigest) ||
    (preview.targetState !== "current" &&
      preview.targetState !== "stale" &&
      preview.targetState !== "unavailable") ||
    !boundedText(preview.targetMessage, 300) ||
    typeof preview.patchDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(preview.patchDigest) ||
    !Array.isArray(preview.changedFields) ||
    !preview.changedFields.every((field) =>
      ["html", "css", "js", "height"].includes(String(field)),
    ) ||
    !Array.isArray(preview.validationChecks) ||
    preview.validationChecks.length > 10 ||
    !preview.validationChecks.every(
      (check) => typeof check === "string" && check.length <= 200,
    ) ||
    !isRecord(preview.sandbox) ||
    !isRecord(preview.sandbox.iframe) ||
    preview.sandbox.iframe.sandboxAttribute !== "allow-scripts" ||
    preview.sandbox.iframe.opaqueOrigin !== true ||
    preview.sandbox.iframe.sameOrigin !== false ||
    preview.sandbox.iframe.topNavigation !== false ||
    !isRecord(preview.authority) ||
    preview.authority.canPreview !== true ||
    preview.authority.canEditProposal !== false ||
    preview.authority.canSaveBuilderDraft !== false ||
    preview.authority.canPublish !== false ||
    "error" in before ||
    "error" in proposed
  ) {
    throw new Error("The private preview response failed validation.");
  }
  return {
    ...(preview as unknown as MinkStorefrontCodePreviewDto),
    beforeConfig: before.config as CustomCodeConfig,
    proposedConfig: proposed.config as CustomCodeConfig,
  };
}

function readError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string"
    ? value.error.slice(0, 300)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}
