"use client";

// One notification's configuration.
//
// ══ THE SHAPE, AND WHY ════════════════════════════════════════════════════
// A single event can notify two completely different people:
//
//   Team     → your staff. Many possible recipients, operational wording.
//   Customer → the one shopper it happened to. Their wording, their inbox.
//
// So the page is organised BY AUDIENCE first, then by channel — because "who
// is this for" is the question a merchant is actually answering. The previous
// version had one flat set of channels, which made customer notifications
// invisible and their copy uneditable.
//
// Only audiences the notification actually reaches are rendered, so there is
// never a control that configures nobody.

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Lock, RotateCcw, Save, Send, Store, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  previewNotificationEmail,
  saveNotificationConfig,
  sendTestNotificationEmail,
  type NotificationDetail,
} from "@/app/actions/notification-actions";
import { CHANNELS, type ChannelKey } from "@/lib/notifications/channels";
import { DIGESTS, type Digest } from "@/lib/notifications/events";
import { renderTemplate } from "@/lib/notifications/template";
import { sampleValuesFor } from "@/lib/notifications/variables";
import type { RoutingRule } from "@/lib/notifications/routing";
import { getSection } from "@/app/dashboard/lib/permissions";
import { RecipientPicker } from "../recipient-picker";

const DIGEST_LABEL: Record<Digest, string> = {
  instant: "As it happens",
  hourly: "Hourly summary",
  daily: "Daily summary",
};

interface Template {
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
}

interface AudienceDraft {
  channels: Record<string, boolean>;
  templates: Record<string, Template>;
  routing?: RoutingRule;
}

function Toggle({
  on,
  disabled,
  onChange,
  label,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-emerald-500" : "bg-[rgba(17,24,39,0.18)]"
      } ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-5" : "translate-x-1"
        }`}
      />
    </button>
  );
}

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
    <div className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[170px_1fr] sm:gap-6">
      <div className="pt-1.5">
        <div className="text-[13px] font-semibold text-[var(--dash-text)]">
          {label}
        </div>
        {hint && (
          <p className="mt-0.5 text-[12px] leading-snug text-[var(--dash-text-3)]">
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function NotificationDetailView({
  detail,
  scopedAudience,
}: {
  detail: NotificationDetail;
  /** Set when the URL named an audience: the page then shows only that one and
   *  hides the switcher — you answered "who is this for" by choosing a tab. */
  scopedAudience?: "team" | "customer";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const notification = detail.notification;
  const readOnly = !detail.canManage;
  // When the URL scopes us to one audience, that IS the audience list — so
  // there is nothing to switch between and no switcher to render.
  const allAudiences = notification.audiences;
  const audiences = scopedAudience
    ? allAudiences.filter((a) => a.key === scopedAudience)
    : allAudiences;

  const [activeAudience, setActiveAudience] = useState<string>(
    audiences[0]?.key ?? "team",
  );
  const [activeChannel, setActiveChannel] = useState<ChannelKey>("email");
  const [digest, setDigest] = useState<Digest>(notification.digest);
  const [isEnabled, setIsEnabled] = useState(notification.isEnabled);

  // Pre-filled with the built-in copy for THAT audience, so a merchant sees
  // real wording rather than an empty box. saveNotificationConfig drops any
  // field still equal to the default, so an untouched notification stays on
  // the platform's (improving) version instead of freezing today's text.
  const [draft, setDraft] = useState<Record<string, AudienceDraft>>(() => {
    const seeded: Record<string, AudienceDraft> = {};
    for (const audience of audiences) {
      const defaults = detail.defaults[audience.key];
      const templates: Record<string, Template> = {
        ...(audience.templates as Record<string, Template>),
      };
      templates.email = {
        subject: templates.email?.subject || defaults?.subject || "",
        body: templates.email?.body || defaults?.body || "",
        cc: templates.email?.cc ?? "",
        bcc: templates.email?.bcc ?? "",
      };
      seeded[audience.key] = {
        channels: { ...audience.channels },
        templates,
        routing: audience.routing,
      };
    }
    return seeded;
  });

  const current =
    audiences.find((a) => a.key === activeAudience) ?? audiences[0];
  const currentDraft = current ? draft[current.key] : undefined;
  const samples = useMemo(
    () => sampleValuesFor(notification.key),
    [notification.key],
  );

  // The email preview renders SERVER-side (the branded layout resolves the
  // store's brand + logo, which is server-only), so it's a debounced
  // round-trip showing exactly what lands in an inbox — sample values only.
  const [preview, setPreview] = useState("");
  const emailTemplate = currentDraft?.templates.email;
  useEffect(() => {
    if (activeChannel !== "email") return;
    const handle = setTimeout(async () => {
      const result = await previewNotificationEmail(notification.key, {
        subject: emailTemplate?.subject,
        body: emailTemplate?.body,
      });
      if (result.html) setPreview(result.html);
    }, 350);
    return () => clearTimeout(handle);
  }, [
    activeChannel,
    activeAudience,
    notification.key,
    emailTemplate?.subject,
    emailTemplate?.body,
  ]);

  // Derived values, declared before the handlers that read them.
  const sectionLabel =
    getSection(notification.section)?.label ?? notification.section;
  const channelDef = CHANNELS.find((c) => c.key === activeChannel);
  const template = currentDraft?.templates[activeChannel] ?? {};
  const defaults = current ? detail.defaults[current.key] : undefined;

  const patchAudience = (key: string, patch: Partial<AudienceDraft>) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));

  const setTemplate = (channel: ChannelKey, patch: Partial<Template>) => {
    if (!current) return;
    patchAudience(current.key, {
      templates: {
        ...draft[current.key].templates,
        [channel]: { ...draft[current.key].templates[channel], ...patch },
      },
    });
  };

  /** Put a field back on the platform's wording. Explicit, because "clear the
   *  box" is a rule nobody discovers on their own. */
  const revert = (field: "subject" | "body") => {
    if (!current) return;
    const value =
      field === "subject" ? (defaults?.subject ?? "") : (defaults?.body ?? "");
    setTemplate(activeChannel, { [field]: value });
    toast.success(`${field === "subject" ? "Subject" : "Message"} reset`);
  };

  const [isSending, setIsSending] = useState(false);
  const sendTest = async () => {
    if (!current) return;
    setIsSending(true);
    try {
      const result = await sendTestNotificationEmail(
        notification.key,
        current.key,
        {
          subject: template.subject,
          body: template.body,
        },
      );
      if (result.error) toast.error(result.error);
      else toast.success(`Test email sent to ${result.sentTo}`);
    } finally {
      setIsSending(false);
    }
  };

  const handleSave = () => {
    startTransition(async () => {
      const result = await saveNotificationConfig(notification.key, {
        digest,
        isEnabled,
        audiences: Object.fromEntries(
          audiences.map((audience) => [
            audience.key,
            {
              channels: draft[audience.key].channels,
              templates: draft[audience.key].templates,
              // Only the team audience has recipients to route.
              ...(audience.key === "team" && draft[audience.key].routing
                ? {
                    routing: {
                      mode: draft[audience.key].routing!.mode,
                      roles: draft[audience.key].routing!.roles,
                      admins: draft[audience.key].routing!.admins,
                    },
                  }
                : {}),
            },
          ]),
        ),
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Notification saved.");
      router.refresh();
    });
  };

  return (
    <div className="dash-page-enter flex flex-col gap-4">
      <header className="dash-page-header row">
        <div>
          <h1 className="flex items-center gap-2">
            <Link
              href="/dashboard/settings/notifications"
              className="text-[var(--dash-text-3)] no-underline hover:underline"
            >
              Notifications
            </Link>
            <span className="text-[var(--dash-text-3)]">/</span>
            {notification.displayName}
            {scopedAudience && (
              <span className="dash-badge-grey rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide">
                {scopedAudience === "team" ? "Team" : "Customer"}
              </span>
            )}
          </h1>
          <p>{notification.description}</p>
        </div>
        {!readOnly && (
          <Button
            onClick={handleSave}
            disabled={isPending}
            className="shrink-0"
          >
            <Save className="mr-1.5 h-4 w-4" />
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        )}
      </header>

      {/* ── Whole-notification settings ─────────────────────────────────── */}
      <section className="dash-card">
        <div className="dash-card-body divide-y divide-[rgba(17,24,39,0.06)]">
          <Field label="Trigger" hint="The event your store emits.">
            <input
              readOnly
              value={notification.key}
              className="w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface-2)] px-3 py-2 font-mono text-[12.5px] text-[var(--dash-text-2)]"
            />
          </Field>

          <Field
            label="Status"
            hint={
              notification.configurable
                ? "Turn off to stop notifying. It's still recorded in Activity."
                : "This one can't be switched off — you'd be blind to a change you need to see."
            }
          >
            <div className="flex items-center gap-2.5 pt-1">
              <Toggle
                on={isEnabled}
                disabled={readOnly || !notification.configurable || isPending}
                onChange={setIsEnabled}
                label="Notification enabled"
              />
              <span className="text-[13px] text-[var(--dash-text-2)]">
                {isEnabled ? "On" : "Off"}
              </span>
              {!notification.configurable && (
                <span className="dash-badge-grey inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium">
                  <Lock className="h-3 w-3" />
                  Always on
                </span>
              )}
            </div>
          </Field>

          <Field
            label="Email frequency"
            hint="Batch emails so a busy day doesn't mean a full inbox."
          >
            <select
              value={digest}
              disabled={readOnly || isPending}
              onChange={(e) => setDigest(e.target.value as Digest)}
              className="w-[200px] rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-2 text-[13px] text-[var(--dash-text)] outline-none disabled:opacity-45"
            >
              {DIGESTS.map((d) => (
                <option key={d} value={d}>
                  {DIGEST_LABEL[d]}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      {/* ── Who it notifies. Hidden when the URL already scoped us, and when
             the notification only reaches one audience — a "switcher" with one
             option is just noise. ─────────────────────────────────────────── */}
      {audiences.length > 1 && (
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--dash-text-3)]">
            Who this notifies
          </div>
          <div className="flex flex-wrap gap-2">
            {audiences.map((audience) => (
              <button
                key={audience.key}
                type="button"
                onClick={() => setActiveAudience(audience.key)}
                className={`flex min-w-[250px] items-start gap-2.5 rounded-[var(--dash-radius)] border px-3.5 py-2.5 text-left transition-colors ${
                  activeAudience === audience.key
                    ? "border-[var(--dash-accent)] bg-[var(--dash-surface)]"
                    : "border-[var(--dash-border)] bg-[var(--dash-surface-2)] hover:border-[var(--dash-border-hover)]"
                }`}
              >
                {audience.key === "team" ? (
                  <Store className="mt-0.5 h-4 w-4 shrink-0 text-[var(--dash-text-2)]" />
                ) : (
                  <User className="mt-0.5 h-4 w-4 shrink-0 text-[var(--dash-text-2)]" />
                )}
                <span>
                  <span className="block text-[13.5px] font-semibold text-[var(--dash-text)]">
                    {audience.label}
                  </span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--dash-text-3)]">
                    {audience.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {current && currentDraft && (
        <>
          {current.key === "team" && currentDraft.routing ? (
            <section className="dash-card">
              <div className="dash-card-body">
                <Field
                  label="Recipients"
                  hint={`Only staff who can view ${sectionLabel} can be notified about it.`}
                >
                  <div className="pt-1">
                    <RecipientPicker
                      rule={currentDraft.routing}
                      sectionKey={notification.section}
                      sectionLabel={sectionLabel}
                      roles={detail.audience.roles}
                      members={detail.audience.members}
                      disabled={readOnly || isPending}
                      onChange={(next) =>
                        patchAudience(current.key, { routing: next })
                      }
                      // Only where both halves are true: the store has more
                      // than one location, AND this event actually carries one.
                      showScope={
                        detail.multiLocation && notification.hasLocation
                      }
                    />
                  </div>
                </Field>
              </div>
            </section>
          ) : null}

          {current.key === "customer" && (
            <p className="text-[12.5px] text-[var(--dash-text-3)]">
              Goes to the shopper this happened to — there&apos;s no recipient
              list to choose.
            </p>
          )}

          {/* Channels for this audience. */}
          <section className="dash-card">
            <div className="dash-card-header">
              <div className="dash-card-title">
                How {current.label.toLowerCase()} gets it
              </div>
            </div>
            <div className="dash-card-body">
              <div className="flex flex-col gap-2.5">
                {CHANNELS.map((channel) => (
                  <label
                    key={channel.key}
                    className={`flex items-center gap-3 text-[13px] ${
                      channel.available
                        ? "text-[var(--dash-text)]"
                        : "text-[var(--dash-text-3)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="dash-checkbox"
                      checked={Boolean(currentDraft.channels[channel.key])}
                      disabled={readOnly || !channel.available || isPending}
                      onChange={(e) =>
                        patchAudience(current.key, {
                          channels: {
                            ...currentDraft.channels,
                            [channel.key]: e.target.checked,
                          },
                        })
                      }
                    />
                    {channel.label}
                    {!channel.available && (
                      <span className="text-[11.5px]">— {channel.note}</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          </section>

          {/* Copy, per channel. */}
          <section className="dash-card">
            <div className="dash-card-header flex-wrap gap-2">
              <div className="dash-card-title">
                What {current.label.toLowerCase()} sees
              </div>
              <div className="dash-filter-tabs">
                {CHANNELS.filter((c) => c.available).map((channel) => (
                  <button
                    key={channel.key}
                    type="button"
                    className={`dash-filter-tab ${activeChannel === channel.key ? "active" : ""}`}
                    onClick={() => setActiveChannel(channel.key)}
                  >
                    {channel.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="dash-card-body divide-y divide-[rgba(17,24,39,0.06)]">
              {activeChannel === "email" && current.key === "team" && (
                <>
                  <Field label="Cc" hint="Optional. Comma-separated.">
                    <input
                      value={template.cc ?? ""}
                      readOnly={readOnly}
                      onChange={(e) =>
                        setTemplate(activeChannel, { cc: e.target.value })
                      }
                      className="w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-2 text-[13px] text-[var(--dash-text)] outline-none"
                    />
                  </Field>
                  <Field label="Bcc" hint="Optional. Comma-separated.">
                    <input
                      value={template.bcc ?? ""}
                      readOnly={readOnly}
                      onChange={(e) =>
                        setTemplate(activeChannel, { bcc: e.target.value })
                      }
                      className="w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-2 text-[13px] text-[var(--dash-text)] outline-none"
                    />
                  </Field>
                </>
              )}

              <Field
                label={activeChannel === "email" ? "Subject" : "Title"}
                hint="Clear it to fall back to the built-in wording."
              >
                <input
                  value={template.subject ?? ""}
                  readOnly={readOnly}
                  placeholder={defaults?.subject}
                  onChange={(e) =>
                    setTemplate(activeChannel, { subject: e.target.value })
                  }
                  className="w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-2 text-[13px] text-[var(--dash-text)] outline-none"
                />
                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                  <p className="text-[12px] text-[var(--dash-text-3)]">
                    Preview:{" "}
                    <span className="font-medium">
                      {renderTemplate(
                        template.subject || defaults?.subject || "",
                        samples,
                        "text",
                      )}
                    </span>
                  </p>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => revert("subject")}
                      disabled={template.subject === defaults?.subject}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--dash-text-2)] hover:text-[var(--dash-text)] disabled:opacity-40 disabled:hover:text-[var(--dash-text-2)]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reset to default
                    </button>
                  )}
                </div>
              </Field>

              <Field
                label="Message"
                hint={
                  activeChannel === "email"
                    ? "HTML. Use <p>, <ul>/<li> and <strong> — the email styles them for you."
                    : "Clear it to fall back to the built-in wording."
                }
              >
                <textarea
                  value={template.body ?? ""}
                  readOnly={readOnly}
                  placeholder={defaults?.body}
                  rows={activeChannel === "email" ? 12 : 3}
                  onChange={(e) =>
                    setTemplate(activeChannel, { body: e.target.value })
                  }
                  className="w-full rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-3 py-2 font-mono text-[12.5px] text-[var(--dash-text)] outline-none"
                />

                <div className="mt-1.5 flex flex-wrap items-center gap-3">
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => revert("body")}
                      disabled={template.body === defaults?.body}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--dash-text-2)] hover:text-[var(--dash-text)] disabled:opacity-40 disabled:hover:text-[var(--dash-text-2)]"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reset to default
                    </button>
                  )}
                  {/* A preview shows what you think you wrote; a real email in
                      your own inbox shows what recipients will actually see. */}
                  {!readOnly && activeChannel === "email" && (
                    <button
                      type="button"
                      onClick={sendTest}
                      disabled={isSending}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--dash-accent)] hover:underline disabled:opacity-50"
                    >
                      <Send className="h-3 w-3" />
                      {isSending ? "Sending…" : "Send test to me"}
                    </button>
                  )}
                </div>

                <div className="mt-2 overflow-hidden rounded-md border border-[var(--dash-border)]">
                  <div className="border-b border-[var(--dash-border)] bg-[var(--dash-surface-2)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--dash-text-3)]">
                    {activeChannel === "email"
                      ? `Inbox preview — ${current.label.toLowerCase()}`
                      : "Bell preview"}
                  </div>
                  {activeChannel === "email" ? (
                    // An iframe so the email's own styles can't leak into the
                    // dashboard (and the dashboard's can't flatter the email).
                    <iframe
                      title="Email preview"
                      className="h-[420px] w-full border-0 bg-white"
                      sandbox=""
                      srcDoc={preview}
                    />
                  ) : (
                    <div className="p-3">
                      <div className="text-[13px] font-semibold text-[var(--dash-text)]">
                        {renderTemplate(
                          template.subject || defaults?.subject || "",
                          samples,
                          "text",
                        )}
                      </div>
                      <div className="mt-0.5 text-[12.5px] text-[var(--dash-text-2)]">
                        {renderTemplate(
                          template.body || defaults?.body || "",
                          samples,
                          "text",
                        )
                          .split("\n")
                          .filter(Boolean)
                          .slice(0, 2)
                          .join(" · ")}
                      </div>
                    </div>
                  )}
                </div>
              </Field>

              <Field
                label="Variables"
                hint="Click to copy. Anything else is rejected when you save."
              >
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {detail.variables.map((variable) => (
                    <button
                      key={variable.name}
                      type="button"
                      title={`${variable.description} e.g. ${variable.sample}`}
                      onClick={() =>
                        navigator.clipboard
                          ?.writeText(`{{${variable.name}}}`)
                          .then(() =>
                            toast.success(`Copied {{${variable.name}}}`),
                          )
                          .catch(() => {})
                      }
                      className="rounded-md border border-[var(--dash-border)] bg-[var(--dash-surface)] px-2 py-1 font-mono text-[11.5px] text-[var(--dash-text-2)] transition-colors hover:border-[var(--dash-border-hover)] hover:text-[var(--dash-text)]"
                    >
                      {`{{${variable.name}}}`}
                    </button>
                  ))}
                </div>
              </Field>

              {channelDef && !channelDef.available && (
                <p className="pt-3 text-[12.5px] text-[var(--dash-text-3)]">
                  {channelDef.note}
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
