"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Loader2,
  Send,
  Trash2,
  Users,
} from "lucide-react";
import {
  deleteAnnouncement,
  previewAnnouncementAudience,
  saveAnnouncement,
  sendAnnouncement,
  sendAnnouncementTest,
  type AnnouncementRow,
} from "@/app/actions/announcement-actions";
import {
  AUDIENCE_ROLES,
  CATEGORY_META,
  type AnnouncementCategory,
  type AudienceFilter,
  type AudienceRole,
} from "@/lib/announcements/audience";
import type { AudiencePreview } from "@/lib/announcements/resolve";
import type { SmsAvailability } from "@/lib/announcements/sms-availability";

// ---------------------------------------------------------------------------
// The composer.
//
// ★ THE AUDIENCE PREVIEW IS DELIBERATELY MANUAL. It runs the real resolver
// over every admin and till account on the platform, so firing it on every
// keystroke would be a full audience scan per character. The operator asks for
// it, which is also when they actually want to know.
//
// ★ AND THE SEND BUTTON REQUIRES ONE. You cannot send something whose reach
// you have not looked at — the confirm step quotes the number back, because
// "send to everyone" is not a thing anyone should be able to do by accident.
// ---------------------------------------------------------------------------

const PLANS = ["free", "basic", "pro"];
const STATUSES = ["active", "suspended"];

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {hint ? <p className="mt-0.5 text-xs text-slate-500">{hint}</p> : null}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition ${
        disabled
          ? "cursor-not-allowed border-slate-200 bg-slate-50 opacity-60"
          : checked
            ? "cursor-pointer border-slate-900 bg-slate-50"
            : "cursor-pointer border-slate-200 bg-white hover:bg-slate-50"
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">
          {label}
        </span>
        {hint ? (
          <span className="block text-xs text-slate-500">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}

const INPUT =
  "w-full rounded-md border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-100";

export function AnnouncementComposer({
  initial,
  canSend,
  smsGate,
}: {
  initial: AnnouncementRow | null;
  canSend: boolean;
  /** Why SMS can't go out, computed server-side. */
  smsGate: SmsAvailability;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [id, setId] = useState(initial?.id ?? "");
  const locked = (initial?.status ?? "draft") !== "draft";

  const [title, setTitle] = useState(initial?.title ?? "");
  const [category, setCategory] = useState<AnnouncementCategory>(
    initial?.category ?? "feature",
  );
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [ctaLabel, setCtaLabel] = useState(initial?.ctaLabel ?? "");
  const [ctaUrl, setCtaUrl] = useState(initial?.ctaUrl ?? "");
  const [smsBody, setSmsBody] = useState(initial?.smsBody ?? "");
  const [dltTemplateId, setDltTemplateId] = useState(
    initial?.dltTemplateId ?? "",
  );
  const [channels, setChannels] = useState(
    initial?.channels ?? { email: true, sms: false },
  );
  const [audience, setAudience] = useState<AudienceFilter>(
    initial?.audience ?? { include: ["owner"], plans: [], statuses: [] },
  );

  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function toggleIn<T extends string>(list: T[] | undefined, value: T): T[] {
    const set = new Set(list ?? []);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    return [...set];
  }

  // Any edit invalidates the reach figure — a stale count is worse than none,
  // because the confirm step quotes it back as if it were current.
  function edited<T>(setter: (v: T) => void) {
    return (value: T) => {
      setPreview(null);
      setter(value);
    };
  }

  async function save(): Promise<string | null> {
    setBusy(true);
    const res = await saveAnnouncement({
      id: id || undefined,
      title,
      category,
      subject,
      body,
      ctaLabel,
      ctaUrl,
      smsBody,
      dltTemplateId,
      channels,
      audience,
    });
    setBusy(false);
    if (res.error) {
      toast.error(res.error);
      return null;
    }
    if (res.id && res.id !== id) {
      setId(res.id);
      window.history.replaceState(
        null,
        "",
        `/dashboard/announcements/${res.id}`,
      );
    }
    return res.id ?? id;
  }

  async function onSave() {
    const saved = await save();
    if (saved) toast.success("Draft saved.");
  }

  async function onPreview() {
    setPreviewing(true);
    const result = await previewAnnouncementAudience(
      audience,
      category,
      channels,
    );
    setPreviewing(false);
    setPreview(result);
    if (!result.ok) toast.error("Couldn't work out the audience.");
  }

  async function onTest() {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    const res = await sendAnnouncementTest(saved);
    setBusy(false);
    if (res.error) return void toast.error(res.error);
    toast.success("Test sent to your own address.");
  }

  async function onSend() {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    const res = await sendAnnouncement(saved);
    setBusy(false);
    setConfirming(false);
    if (res.error) return void toast.error(res.error);
    toast.success("Sending. Recipients are being worked through now.");
    startTransition(() => router.refresh());
  }

  async function onDelete() {
    if (!id) return router.push("/dashboard/announcements");
    setBusy(true);
    const res = await deleteAnnouncement(id);
    setBusy(false);
    if (res.error) return void toast.error(res.error);
    router.push("/dashboard/announcements");
  }

  const reach = preview?.reach.email ?? 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-5">
        {locked ? (
          <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              This announcement has been sent, so its copy is locked. What
              people received has to stay what the record says they received.
            </span>
          </div>
        ) : null}

        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <Field label="Name" hint="For you. Never sent.">
            <input
              className={INPUT}
              value={title}
              disabled={locked}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="August feature round-up"
            />
          </Field>

          <Field label="Kind">
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(CATEGORY_META) as AnnouncementCategory[]).map(
                (key) => (
                  <button
                    key={key}
                    type="button"
                    disabled={locked}
                    onClick={() => edited(setCategory)(key)}
                    className={`rounded-lg border px-3 py-2.5 text-left transition disabled:opacity-60 ${
                      category === key
                        ? "border-slate-900 bg-slate-50"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <span className="block text-sm font-medium text-slate-800">
                      {CATEGORY_META[key].label}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-slate-500">
                      {CATEGORY_META[key].hint}
                    </span>
                  </button>
                ),
              )}
            </div>
          </Field>
        </section>

        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Email</h2>
          <Field label="Subject">
            <input
              className={INPUT}
              value={subject}
              disabled={locked}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Pick up in store is now live"
            />
          </Field>
          <Field
            label="Body"
            hint="Basic HTML is allowed and is sanitized on save and again on send."
          >
            <textarea
              className={`${INPUT} min-h-[200px] font-mono text-xs`}
              value={body}
              disabled={locked}
              onChange={(e) => setBody(e.target.value)}
              placeholder="<p>Hello,</p><p>We've just shipped…</p>"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Button label" hint="Optional.">
              <input
                className={INPUT}
                value={ctaLabel}
                disabled={locked}
                onChange={(e) => setCtaLabel(e.target.value)}
                placeholder="See what's new"
              />
            </Field>
            <Field label="Button link">
              <input
                className={INPUT}
                value={ctaUrl}
                disabled={locked}
                onChange={(e) => setCtaUrl(e.target.value)}
                placeholder="https://help.storemink.com/…"
              />
            </Field>
          </div>
        </section>

        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">SMS</h2>
            <Toggle
              checked={channels.sms}
              disabled={locked || !smsGate.available}
              onChange={(next) => setChannels({ ...channels, sms: next })}
              label="Also send by SMS"
            />
          </div>

          {!smsGate.available ? (
            // ★ THE REASON IS ON SCREEN, not hidden behind a disabled control.
            // Two of these three blockers are a registration process, not a
            // setting, and someone has to know that before they plan around it.
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-amber-900">
                    {smsGate.reason}
                  </p>
                  <ul className="mt-2 space-y-1.5 text-xs leading-5 text-amber-800">
                    {smsGate.blockers.map((blocker) => (
                      <li key={blocker} className="flex gap-1.5">
                        <span aria-hidden>•</span>
                        <span>{blocker}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}

          <Field
            label="Message"
            hint="Must match a registered DLT template exactly, apart from its variables. A body that does not match is dropped at the carrier with no bounce."
          >
            <textarea
              className={`${INPUT} min-h-[80px]`}
              value={smsBody}
              disabled={locked}
              onChange={(e) => setSmsBody(e.target.value)}
            />
          </Field>
          <Field label="DLT template id">
            <input
              className={INPUT}
              value={dltTemplateId}
              disabled={locked}
              onChange={(e) => setDltTemplateId(e.target.value)}
              placeholder="1107xxxxxxxxxxxxx"
            />
          </Field>
        </section>
      </div>

      <aside className="space-y-5">
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">Audience</h2>

          <Field label="Who">
            <div className="space-y-2">
              {AUDIENCE_ROLES.map((role) => (
                <Toggle
                  key={role.id}
                  checked={(audience.include ?? []).includes(role.id)}
                  disabled={locked}
                  label={role.label}
                  hint={role.hint}
                  onChange={() =>
                    edited(setAudience)({
                      ...audience,
                      include: toggleIn<AudienceRole>(
                        audience.include,
                        role.id,
                      ),
                    })
                  }
                />
              ))}
            </div>
          </Field>

          <Field label="Plan" hint="Nothing selected = every plan.">
            <div className="flex flex-wrap gap-1.5">
              {PLANS.map((plan) => (
                <button
                  key={plan}
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    edited(setAudience)({
                      ...audience,
                      plans: toggleIn(audience.plans, plan),
                    })
                  }
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
                    (audience.plans ?? []).includes(plan)
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {plan}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Store status" hint="Nothing selected = any status.">
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  disabled={locked}
                  onClick={() =>
                    edited(setAudience)({
                      ...audience,
                      statuses: toggleIn(audience.statuses, status),
                    })
                  }
                  className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
                    (audience.statuses ?? []).includes(status)
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>
          </Field>

          <div className="space-y-2">
            <Toggle
              checked={audience.launchedOnly === true}
              disabled={locked}
              label="Launched stores only"
              hint="Skip stores that haven't published anything yet."
              onChange={(next) =>
                edited(setAudience)({ ...audience, launchedOnly: next })
              }
            />
            <Toggle
              checked={audience.includeDemo === true}
              disabled={locked}
              label="Include demo stores"
              onChange={(next) =>
                edited(setAudience)({ ...audience, includeDemo: next })
              }
            />
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Reach</h2>
            <button
              type="button"
              onClick={onPreview}
              disabled={previewing}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              {previewing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Users className="h-3.5 w-3.5" />
              )}
              Check
            </button>
          </div>

          {!preview ? (
            <p className="text-sm text-slate-500">
              Check who this reaches before sending.
            </p>
          ) : (
            <>
              <div className="text-2xl font-semibold tabular-nums text-slate-950">
                {preview.reach.email.toLocaleString("en-IN")}
                <span className="ml-1.5 text-sm font-normal text-slate-500">
                  by email
                </span>
              </div>
              {channels.sms ? (
                <div className="text-sm text-slate-600">
                  {preview.reach.sms.toLocaleString("en-IN")} by SMS
                </div>
              ) : null}

              <div className="border-t border-slate-100 pt-2 text-xs text-slate-500">
                {preview.matched.toLocaleString("en-IN")} matched the filter.
                {/* Every skip carries its reason — "38 skipped" alone tells an
                    operator nothing about whether the audience is wrong or the
                    list is dirty. */}
                <ul className="mt-1.5 space-y-0.5">
                  {preview.skipped.no_consent > 0 ? (
                    <li>
                      {preview.skipped.no_consent} not opted in to product
                      updates
                    </li>
                  ) : null}
                  {preview.skipped.suppressed > 0 ? (
                    <li>{preview.skipped.suppressed} previously bounced</li>
                  ) : null}
                  {preview.skipped.duplicate > 0 ? (
                    <li>
                      {preview.skipped.duplicate} already counted via another
                      store
                    </li>
                  ) : null}
                  {preview.skipped.no_email > 0 ? (
                    <li>{preview.skipped.no_email} have no email address</li>
                  ) : null}
                  {preview.skipped.no_phone > 0 && channels.sms ? (
                    <li>{preview.skipped.no_phone} have no phone number</li>
                  ) : null}
                </ul>
              </div>

              {preview.sample.length > 0 ? (
                <div className="border-t border-slate-100 pt-2">
                  <p className="text-xs font-medium text-slate-600">
                    For example
                  </p>
                  <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
                    {preview.sample.map((s) => (
                      <li key={s.email} className="truncate">
                        {s.email} · {s.store}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </section>

        {!locked ? (
          <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <button
              type="button"
              onClick={onSave}
              disabled={busy}
              className="w-full rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Save draft
            </button>
            <button
              type="button"
              onClick={onTest}
              disabled={busy}
              className="w-full rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              Send a test to me
            </button>
            {canSend ? (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                // ★ REACH MUST BE CHECKED FIRST. "Send to everyone" should not
                // be reachable without having looked at who everyone is.
                disabled={busy || !preview || reach === 0}
                title={
                  !preview
                    ? "Check the reach first."
                    : reach === 0
                      ? "This reaches nobody."
                      : undefined
                }
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                <Send className="h-4 w-4" /> Send
              </button>
            ) : (
              <p className="pt-1 text-xs text-slate-400">
                Sending is restricted to a platform superadmin.
              </p>
            )}
            {id ? (
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" /> Delete draft
              </button>
            ) : null}
          </section>
        ) : null}
      </aside>

      {confirming ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirming(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-slate-900">
              Send to {reach.toLocaleString("en-IN")}{" "}
              {reach === 1 ? "person" : "people"}?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              This can&apos;t be recalled. Every recipient is recorded, and the
              copy is locked once sending starts.
            </p>
            {category === "operational" ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                This is marked an operational notice, so it also goes to people
                who opted out of product updates. Only send it if it genuinely
                affects their account.
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                className="rounded-md px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                className="rounded-md bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                disabled={busy}
                onClick={onSend}
              >
                {busy ? "Sending…" : "Send now"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
