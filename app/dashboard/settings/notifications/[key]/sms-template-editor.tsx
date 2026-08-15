"use client";

// ---------------------------------------------------------------------------
// The SMS tab. NOT the generic template editor beside it, and the difference is
// the whole point.
//
// An email template is free text the merchant AUTHORS, with {{token}}
// substitution and a subject line. A DLT body is FIXED at registration on their
// operator's portal, has no subject, and only its marked {#var#} points may
// vary. So this screen MIRRORS an approval that lives somewhere else — which is
// why it has its own save button rather than riding the page's: it writes to a
// different table, under different validation, and saving it cannot change what
// a carrier will accept.
// ---------------------------------------------------------------------------

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { MessageSquare, Trash2 } from "lucide-react";
import {
  deleteSmsTemplate,
  saveSmsTemplate,
  type SmsTemplate,
} from "@/app/actions/sms-template-actions";
import { DLT_VARIABLE, checkDltTemplate, smsSegments } from "@/lib/sms/dlt";

export function SmsTemplateEditor({
  eventKey,
  audience,
  variables,
  readOnly,
  smsConnected,
  initial,
}: {
  eventKey: string;
  audience: "team" | "customer";
  /** The values this event carries, for the mapping pickers. */
  variables: { name: string; description: string }[];
  readOnly: boolean;
  smsConnected: boolean;
  /** Loaded SERVER-side by getNotificationDetail — see the note there. */
  initial: SmsTemplate | null;
}) {
  const [templateId, setTemplateId] = useState(initial?.dltTemplateId ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [mapping, setMapping] = useState<string[]>(initial?.variables ?? []);
  const [existing, setExisting] = useState<SmsTemplate | null>(initial);
  const [isPending, startTransition] = useTransition();

  // The same pure rules the server enforces on save, so the count and the
  // warning below are what will actually happen rather than a guess.
  const shape = checkDltTemplate({ templateId: templateId || "x", body });
  const slots = shape.ok ? shape.variables : 0;
  const segments = smsSegments(body);

  // ★ DERIVED DURING RENDER, not synced by an effect. The mapping's length has
  // to track the template's variable count, and an effect that setStates to
  // match is a cascading render React (and the lint rule) rightly rejects —
  // the same correction the checkout payment default needed. `mapping` holds
  // only what the merchant actually chose; the slots are computed from it.
  const slotMapping = Array.from({ length: slots }, (_, i) => mapping[i] ?? "");

  function save() {
    startTransition(async () => {
      const res = await saveSmsTemplate({
        eventKey,
        audience,
        dltTemplateId: templateId,
        body,
        variables: slotMapping,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("SMS template saved.");
      setExisting({
        eventKey,
        audience,
        dltTemplateId: templateId,
        body,
        variables: slotMapping,
        enabled: true,
        segments,
      });
    });
  }

  function remove() {
    if (
      !window.confirm(
        "Remove this SMS template? Your DLT registration is untouched — this only stops us sending this notification by SMS.",
      )
    )
      return;
    startTransition(async () => {
      const res = await deleteSmsTemplate({ eventKey, audience });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setExisting(null);
      setTemplateId("");
      setBody("");
      setMapping([]);
      toast.success("SMS template removed.");
    });
  }

  return (
    <div className="space-y-4 px-5 py-4">
      {/* ★ Said first, because a merchant who has not heard of DLT will read
          the silence of a blocked message as our bug. */}
      {!smsConnected && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-[#5b6472] dark:border-amber-900/40 dark:bg-amber-950/30">
          <p className="text-[13px] font-semibold text-[var(--dash-text)]">
            SMS isn&apos;t connected for this store
          </p>
          <p className="mt-1">
            Connect your own Twilio account in Channels first. You can save a
            template here now, but nothing will send until it&apos;s connected.
          </p>
        </div>
      )}

      <div className="rounded-lg border border-[var(--dash-border)] p-3 text-[12px] text-[var(--dash-text-3)]">
        <p className="text-[13px] font-medium text-[var(--dash-text)]">
          This mirrors a template you registered on your DLT portal
        </p>
        <p className="mt-1">
          Paste the body exactly as it was approved, using{" "}
          <code className="font-mono">{DLT_VARIABLE}</code> where each variable
          goes. Carriers in India drop any message whose text doesn&apos;t match
          — with no bounce and no error — so the wording here has to be
          character-for-character what your operator approved.
        </p>
      </div>

      <label className="block">
        <span className="mb-1 block text-[12px] font-medium text-[var(--dash-text-2)]">
          DLT template ID
        </span>
        <input
          value={templateId}
          readOnly={readOnly}
          onChange={(e) => setTemplateId(e.target.value)}
          placeholder="1707161234567890123"
          className="w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-2 font-mono text-[13px] text-[var(--dash-text)] outline-none"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[12px] font-medium text-[var(--dash-text-2)]">
          Approved message
        </span>
        <textarea
          value={body}
          readOnly={readOnly}
          rows={4}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`Hi ${DLT_VARIABLE}, your order ${DLT_VARIABLE} is confirmed. - Your Store`}
          className="w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-2 text-[13px] text-[var(--dash-text)] outline-none"
        />
        <span className="mt-1.5 flex flex-wrap items-center gap-3 text-[12px] text-[var(--dash-text-3)]">
          <span>
            {body.length} characters ·{" "}
            {/* ★ What they are BILLED. One ₹ or emoji re-prices the whole
                message from 160 characters per segment to 70. */}
            <strong className="font-medium text-[var(--dash-text-2)]">
              {segments} segment{segments === 1 ? "" : "s"}
            </strong>{" "}
            per message
          </span>
          {segments > 1 && (
            <span className="text-amber-700 dark:text-amber-500">
              Over one segment — check for ₹, emoji or curly quotes, which cut
              the limit from 160 characters to 70.
            </span>
          )}
        </span>
        {!shape.ok && body.trim() !== "" && (
          <span className="mt-1 block text-[12px] text-red-600 dark:text-red-400">
            {shape.error}
          </span>
        )}
      </label>

      {slots > 0 && (
        <div>
          <p className="mb-1 text-[12px] font-medium text-[var(--dash-text-2)]">
            What fills each {DLT_VARIABLE}
          </p>
          {/* ★ POSITIONAL, because DLT variables have no names — the portal
              approves a shape, and the Nth variable is whatever the merchant
              said it was. */}
          <div className="space-y-2">
            {Array.from({ length: slots }, (_, i) => (
              <label key={i} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[12px] text-[var(--dash-text-3)]">
                  #{i + 1}
                </span>
                <select
                  value={slotMapping[i]}
                  disabled={readOnly}
                  onChange={(e) => {
                    const next = [...slotMapping];
                    next[i] = e.target.value;
                    setMapping(next);
                  }}
                  className="flex-1 rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-2 text-[13px] text-[var(--dash-text)] outline-none"
                >
                  <option value="">Choose a value…</option>
                  {variables.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} — {v.description}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      {!readOnly && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={isPending}
            className="rounded-md bg-[var(--dash-text)] px-4 py-2 text-[13px] font-medium text-[var(--dash-surface)] disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save SMS template"}
          </button>
          {existing && (
            <button
              type="button"
              onClick={remove}
              disabled={isPending}
              className="flex items-center gap-1.5 rounded-md px-3 py-2 text-[13px] text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950/30"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </button>
          )}
          <span className="ml-auto flex items-center gap-1.5 text-[12px] text-[var(--dash-text-3)]">
            <MessageSquare className="h-3.5 w-3.5" />
            Saved separately from the other tabs
          </span>
        </div>
      )}
    </div>
  );
}
