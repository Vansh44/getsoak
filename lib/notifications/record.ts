import "server-only";

// ---------------------------------------------------------------------------
// The recorder — the ONE way anything enters the notification system.
//
// A server action calls emitEvent(); this module appends the audit row and
// fans it out to whoever the registry says should hear about it. Call sites
// never touch the notifications table, so routing, preferences and copy stay
// in one place instead of being re-implemented per feature.
//
// THREE RULES, in order of importance:
//
//  1. IT MUST NEVER BREAK THE THING IT IS REPORTING ON. A failure to record
//     "order placed" must not fail the order. Every path is wrapped and logged;
//     emitEvent() additionally defers the work with after() so it runs once the
//     response is on its way.
//  2. WRITES ARE SERVICE-ROLE. The calling action has already authorised the
//     actor; the tables have no client INSERT policy on purpose, so a customer
//     can't forge an audit entry or push a notification into an admin's bell.
//  3. FAN-OUT IS IDEMPOTENT. notifications is UNIQUE on (event_id,
//     recipient_id) and inserts use onConflictDoNothing, so a retry can never
//     double-notify.
// ---------------------------------------------------------------------------

import { after } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  activityEvents,
  notificationEmailQueue,
  notificationSmsQueue,
  notificationPreferences,
  notifications,
  users,
} from "@/drizzle/schema";
import { logError, logWarn } from "@/lib/observability/logger";
import {
  getEventDef,
  resolveChannels,
  type Audience,
  type EventKey,
  type PreferenceOverride,
} from "./events";
import { renderNotification } from "./render";
import type { EmailOrderSummary } from "@/lib/email/line-items";
import { digestSendAfter } from "./digest";
import {
  loadSmsSender,
  loadSmsTemplates,
  phonesForRecipients,
} from "@/lib/sms/channel";
import { renderDltBody } from "@/lib/sms/dlt";
import { selectRecipients } from "./routing";
import { resolveNotification, type AudienceKey } from "./config";
import { renderTemplate, templateValues } from "./template";
import { defaultEmailTemplate } from "./default-templates";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import {
  operatorRecipients,
  storeAdminRecipients,
  type Recipient,
} from "./recipients";

export type ActorType = "customer" | "admin" | "operator" | "system";

/** Registry audience → the console's audience key. Operators aren't
 *  merchant-configurable, so they have none and keep the built-in copy. */
function toAudienceKey(audience: Audience): AudienceKey | null {
  if (audience === "store-admins") return "team";
  if (audience === "customer") return "customer";
  return null;
}

export interface EmitEventInput {
  type: EventKey;
  /** The store this happened in. NULL/omitted = a platform-level event. */
  storeId?: string | null;
  actor?: {
    type: ActorType;
    id?: string | null;
    /** Display name, snapshotted so the feed survives a rename or deletion. */
    label?: string | null;
  };
  subject?: {
    type?: string | null;
    id?: string | null;
    label?: string | null;
  };
  /** Small, non-secret extras used by the copy templates (render.ts). */
  payload?: Record<string, unknown>;
  /**
   * Where this happened, when it happened somewhere: a POS sale's register, an
   * online order's fulfilment location, a stock adjustment's shop. Feeds the
   * `event_location` routing scope. Omitted for anything with no location, and
   * such an event is never narrowed by one (routing.ts).
   */
  locationId?: string | null;
  ip?: string | null;
  /**
   * The customer this event concerns (order owner, blog author). Required for
   * any event with a `customer` audience — without it there is nobody to tell.
   */
  customerId?: string | null;
  /**
   * Narrow the `store-admins` audience to specific admins.
   *
   * ★ IT CAN ONLY EVER REMOVE PEOPLE. It is applied AFTER the section
   * permission filter and the store's own routing rule, so it obeys the same
   * floor everything else does (routing.ts): naming somebody who cannot view
   * the event's section does not deliver to them. Use it for an event that is
   * genuinely about one admin's own request — a Mink workflow they queued —
   * rather than news the whole team needs.
   */
  restrictToAdminIds?: readonly string[] | null;
  /**
   * DISPLAY-ONLY extras for the EMAIL channel — today, an order summary.
   *
   * Deliberately separate from `payload`: that one is the audit record, kept
   * small and scalar on purpose (sanitizePayload drops objects and arrays), and
   * it feeds the bell, the activity feed and merchant {{tokens}}. A line-item
   * list is none of those things — it's one channel's layout — so it rides its
   * own field and is snapshotted onto the queue row at enqueue.
   */
  email?: EmailOrderSummary;
  /**
   * Use the database's event-specific uniqueness key for a reconciled outbox
   * event. Ordinary audit events remain append-only and should omit this.
   */
  deduplicate?: boolean;
}

// Payload guards. The column is jsonb and store admins can read every event of
// their store, so keep it small and boring: this is display data, not a log
// sink, and it must never become a place someone stashes a token.
const MAX_PAYLOAD_KEYS = 24;
const MAX_VALUE_LENGTH = 500;

function sanitizePayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!payload) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (Object.keys(out).length >= MAX_PAYLOAD_KEYS) break;
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] =
        value.length > MAX_VALUE_LENGTH
          ? value.slice(0, MAX_VALUE_LENGTH)
          : value;
    }
    // Objects/arrays are dropped on purpose — a notification payload that
    // needs nesting is a sign the data belongs in its own table.
  }
  return out;
}

/**
 * Bound the order summary before it is stored.
 *
 * Same reasoning as sanitizePayload: this is a jsonb column written from a call
 * site, so it needs a ceiling and a known shape rather than whatever an emitter
 * happens to pass. Names are capped, quantities and money coerced to finite
 * numbers, and the row count limited — a 500-line order must not turn one queue
 * row into a document.
 */
const MAX_SUMMARY_ITEMS = 50;

function sanitizeSummary(summary: EmailOrderSummary): EmailOrderSummary {
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    items: (summary.items ?? []).slice(0, MAX_SUMMARY_ITEMS).map((i) => ({
      name: String(i.name ?? "").slice(0, 200),
      variant: i.variant ? String(i.variant).slice(0, 100) : null,
      quantity: num(i.quantity) ?? 0,
      total: num(i.total),
    })),
    currency: summary.currency ? String(summary.currency).slice(0, 8) : null,
    subtotal: num(summary.subtotal),
    discount: num(summary.discount),
    tax: num(summary.tax),
    shipping: num(summary.shipping),
    total: num(summary.total),
  };
}

function trim(value: string | null | undefined, max = 300): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

/**
 * Record an event and deliver it. Awaits the write — use this only where the
 * caller genuinely needs it persisted before returning (a cron job, a test).
 * Request handlers should use emitEvent().
 *
 * Resolves to the new event id, or null if nothing was recorded. Normally never
 * throws. The in-app-only watch outbox may supply its transaction: errors then
 * propagate so notification delivery and outbox acknowledgement roll back together.
 */
export async function recordEvent(
  input: EmitEventInput,
  existingDb?: Db,
): Promise<string | null> {
  // Only this fixed in-app event can share a transaction; email workers must
  // never be kicked before their caller commits.
  if (existingDb && input.type !== "mink.watch_ready")
    throw new Error("Only Mink watch alerts support a shared transaction");
  const def = getEventDef(input.type);
  if (!def) {
    // A typo'd key would otherwise vanish silently — record nothing, say so.
    logWarn("notifications: unknown event type", { type: input.type });
    return null;
  }

  try {
    let queuedInstantEmail = false;
    const persist = async (db: Db) => {
      const insert = db.insert(activityEvents).values({
        storeId: input.storeId ?? null,
        type: def.key,
        actorType: input.actor?.type ?? "system",
        actorId: input.actor?.id ?? null,
        actorLabel: trim(input.actor?.label),
        subjectType: trim(input.subject?.type, 64),
        subjectId: trim(input.subject?.id, 128),
        subjectLabel: trim(input.subject?.label),
        payload: sanitizePayload(input.payload),
        ip: trim(input.ip, 64),
      });
      const [event] = input.deduplicate
        ? await insert
            .onConflictDoNothing()
            .returning({ id: activityEvents.id })
        : await insert.returning({ id: activityEvents.id });

      if (!event) return null;
      queuedInstantEmail = await fanOut(db, event.id, input, def.key);
      if (existingDb && queuedInstantEmail)
        throw new Error("Watch alerts must remain in-app only");
      return event.id;
    };
    const eventId = await (existingDb
      ? persist(existingDb)
      : withService(persist));

    // Kick the email worker only AFTER the transaction has committed — a
    // worker that claims before the COMMIT would find an empty queue and the
    // mail would then wait for the next cron tick. Best-effort: the cron
    // heartbeat is the reliable path, this is just what makes "new order"
    // mail arrive in seconds.
    if (queuedInstantEmail) {
      await triggerEmailWorker();
    }
    return eventId;
  } catch (error) {
    if (existingDb) throw error;
    logError("notifications: failed to record event", error, {
      type: input.type,
      storeId: input.storeId ?? undefined,
    });
    return null;
  }
}

/**
 * Fire-and-forget version for request handlers: defers to after() so the user's
 * response is never held up by (or failed by) bookkeeping. This is what nearly
 * every server action should call.
 */
export function emitEvent(input: EmitEventInput): void {
  try {
    after(async () => {
      await recordEvent(input);
    });
  } catch (error) {
    // after() outside a request scope (a script, a test) — record inline
    // rather than dropping the event on the floor.
    void recordEvent(input).catch((err) =>
      logError("notifications: deferred emit failed", err, {
        type: input.type,
      }),
    );
    logWarn("notifications: after() unavailable, emitted inline", {
      type: input.type,
      error: String(error),
    });
  }
}

// ── Fan-out ────────────────────────────────────────────────────────────────

/** Returns true when at least one INSTANT email was queued, so the caller can
 *  kick the worker once the transaction commits. */
async function fanOut(
  db: Db,
  eventId: string,
  input: EmitEventInput,
  key: EventKey,
): Promise<boolean> {
  const def = getEventDef(key);
  if (!def) return false;

  // The store's effective configuration for this event: registry ← platform
  // definition ← store settings (lib/notifications/config.ts). Read first,
  // because its routing rule decides WHO the recipients are — the per-person
  // overrides can only be looked up once we know that list.
  const config = await resolveNotification(db, input.storeId ?? null, key);

  // Retired platform-wide, or switched off by this store. The activity_events
  // row already written stands: the audit trail must stay complete even when
  // nobody is notified.
  if (!config || !config.isEnabled) return false;

  const recipients: Recipient[] = [];

  if (def.audiences["store-admins"] && input.storeId) {
    // Permission first, THEN the store's routing rule. selectRecipients can
    // only narrow this set — see the header of routing.ts for why targeting
    // must never widen it.
    const eligible = await storeAdminRecipients(db, input.storeId, def.section);
    const selected = selectRecipients(
      eligible,
      config.audiences.team?.routing,
      input.locationId ?? null,
    );
    // Narrowing only, and last — see `restrictToAdminIds` above.
    const targeted = input.restrictToAdminIds
      ? selected.filter((r) => input.restrictToAdminIds!.includes(r.id))
      : selected;
    recipients.push(...targeted);
  }
  if (def.audiences.customer && input.customerId) {
    recipients.push({
      id: input.customerId,
      type: "customer",
      audience: "customer",
      email: null,
      roleSlug: "",
      label: null,
    });
  }
  if (def.audiences.operators) {
    recipients.push(...(await operatorRecipients(db)));
  }

  // Audit-only events (and events whose audience resolved to nobody) stop
  // here — the activity_events row IS the delivery.
  if (recipients.length === 0) return false;

  // One person, one notification. A store owner who places a test order on
  // their own store appears twice — once as staff, once as the customer. The
  // UNIQUE (event_id, recipient_id) index would collapse that at the database,
  // but deduping here is explicit and keeps the counts we report honest.
  // Store-admins are pushed first, so the admin copy (the one that links into
  // the dashboard) is the one that survives.
  const seen = new Set<string>();
  const unique = recipients.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  const userPrefs = await loadUserPreferences(
    db,
    key,
    input.storeId ?? null,
    unique.map((r) => r.id),
  );

  // Copy is per-audience, not per-recipient, so render once each.
  const rendered = new Map<Audience, ReturnType<typeof renderNotification>>();
  const renderFor = (audience: Audience) => {
    if (!rendered.has(audience)) {
      const builtIn = renderNotification(
        {
          type: key,
          actorLabel: input.actor?.label ?? null,
          subjectId: input.subject?.id ?? null,
          subjectLabel: input.subject?.label ?? null,
          payload: input.payload ?? null,
        },
        audience,
      );
      rendered.set(audience, applyMerchantTemplate(builtIn, audience));
    }
    return rendered.get(audience) ?? null;
  };

  /**
   * Overlay the store's own wording on the BELL line, where they've written
   * any. This uses the WEB channel's template for THAT AUDIENCE — the email
   * channel has its own, applied in emailFor(), because the two have
   * completely different shapes: a bell line is ~60 characters next to the
   * thing it describes, an email is a standalone document.
   *
   * Team and customer copy are configured separately (config.ts), so a
   * merchant editing what their staff see never touches what a shopper reads.
   * A blank field falls through to the built-in copy, so partial edits are
   * always safe and a shopper can never receive an empty message.
   */
  function applyMerchantTemplate(
    builtIn: ReturnType<typeof renderNotification>,
    audience: Audience,
  ): ReturnType<typeof renderNotification> {
    const audienceKey = toAudienceKey(audience);
    if (!builtIn || !audienceKey) return builtIn;
    const template = config?.audiences[audienceKey]?.templates.web;
    if (!template?.subject && !template?.body) return builtIn;

    const values = templateValues(
      key,
      {
        storeName: config?.storeName ?? null,
        actorLabel: input.actor?.label ?? null,
        subjectLabel: input.subject?.label ?? null,
        eventName: def?.label ?? key,
        // ★ ISO, NOT a locale string. `templateValues` runs every value
        // through `formatVariable`, and `date` is the one that used to arrive
        // pre-formatted — so it was formatted TWICE, and the second pass
        // misread the first. "5/8/2026, 9:42:46 am" (en-IN, D/M/Y) parses in
        // V8 as US M/D/Y, so an order placed on 5 August was confirmed to the
        // customer as "8 May 2026". Past the 12th it is unparseable instead,
        // and the raw "28/7/2026, 12:20:46 am" fell straight through to the
        // email. Formatting belongs in exactly one place; this is the stored
        // shape, like every other value.
        date: new Date().toISOString(),
        link: builtIn.url,
      },
      input.payload ?? null,
    );

    return {
      title: template.subject
        ? renderTemplate(template.subject, values, "text")
        : builtIn.title,
      body: template.body
        ? renderTemplate(template.body, values, "html")
        : builtIn.body,
      url: builtIn.url,
    };
  }

  /**
   * Staff EMAIL copy, rendered once: the store's own template if they've
   * written one, otherwise the built-in default (default-templates.ts). Both
   * are template text over the same variables, so this is one code path.
   */
  const emailCopy = new Map<
    AudienceKey,
    ReturnType<typeof renderNotification>
  >();
  const emailFor = (audience: Audience) => {
    const audienceKey = toAudienceKey(audience);
    const builtIn = renderFor(audience);
    if (!audienceKey) return builtIn;

    if (!emailCopy.has(audienceKey)) {
      const template = config?.audiences[audienceKey]?.templates.email;
      const values = templateValues(
        key,
        {
          storeName: config?.storeName ?? null,
          actorLabel: input.actor?.label ?? null,
          subjectLabel: input.subject?.label ?? null,
          eventName: def?.label ?? key,
          // ★ ISO, NOT a locale string. `templateValues` runs every value
          // through `formatVariable`, and `date` is the one that used to arrive
          // pre-formatted — so it was formatted TWICE, and the second pass
          // misread the first. "5/8/2026, 9:42:46 am" (en-IN, D/M/Y) parses in
          // V8 as US M/D/Y, so an order placed on 5 August was confirmed to the
          // customer as "8 May 2026". Past the 12th it is unparseable instead,
          // and the raw "28/7/2026, 12:20:46 am" fell straight through to the
          // email. Formatting belongs in exactly one place; this is the stored
          // shape, like every other value.
          date: new Date().toISOString(),
          link: builtIn?.url ?? null,
        },
        input.payload ?? null,
      );
      // Built AFTER the values, so a fact this particular emitter didn't
      // supply is left out rather than rendered as an empty labelled row.
      const fallback = defaultEmailTemplate(
        key,
        audienceKey,
        values,
        input.payload ?? null,
      );
      emailCopy.set(audienceKey, {
        // A blank template field falls through to the built-in copy: a
        // shopper must never receive an empty subject because a merchant
        // half-finished an edit.
        title: renderTemplate(
          template?.subject || fallback.subject,
          values,
          "text",
        ),
        // HTML mode: the body IS html now, so every substituted value must be
        // escaped — a customer named `<script>` must not become markup in the
        // email. (The subject above stays "text": it's a mail header, and
        // escaping there would print &amp; at a shopper.)
        body: renderTemplate(template?.body || fallback.body, values, "html"),
        url: builtIn?.url ?? null,
      });
    }
    return emailCopy.get(audienceKey) ?? builtIn;
  };

  const rows: (typeof notifications.$inferInsert)[] = [];
  const mail: (typeof notificationEmailQueue.$inferInsert)[] = [];
  const sms: (typeof notificationSmsQueue.$inferInsert)[] = [];
  // Gathered in the recipient loop, resolved once after it — see below.
  const smsCandidates: {
    recipient: (typeof unique)[number];
    audienceKey: string;
  }[] = [];
  // Only resolved lazily, and only if someone actually wants email — a
  // customer's address is a query we shouldn't pay for on every event.
  let customerEmail: string | null | undefined;

  for (const recipient of unique) {
    // WHOSE preferences apply depends on the audience:
    //   store-admins → the store default, then their own override.
    //   operators    → their own override only (a store's settings have no
    //                  business governing platform mail).
    //   customer     → NEITHER. Order confirmations are transactional mail to
    //                  the shopper; they must not be switchable from a staff
    //                  preferences page that never mentions them. (Turning off
    //                  "New order" email for the team used to silently stop
    //                  shoppers' confirmation emails too.)
    const isStaff = recipient.audience === "store-admins";
    // Each audience has its OWN channel switches in the console, so turning
    // off team email says nothing about the shopper's confirmation.
    const audienceKey = toAudienceKey(recipient.audience);
    const audienceConfig = audienceKey
      ? config.audiences[audienceKey]
      : undefined;
    const storePref: PreferenceOverride | null = audienceConfig
      ? {
          inApp: audienceConfig.channels.web,
          email: audienceConfig.channels.email,
          digest: config.digest,
        }
      : null;
    const userPref =
      recipient.audience === "customer" ? null : userPrefs.get(recipient.id);

    const channels = resolveChannels(
      def,
      recipient.audience,
      storePref,
      userPref,
    );
    if (!channels.inApp && !channels.email) continue;

    const copy = renderFor(recipient.audience);
    if (!copy) continue;

    if (channels.inApp) {
      rows.push({
        storeId: input.storeId ?? null,
        eventId,
        recipientType: recipient.type,
        recipientId: recipient.id,
        type: key,
        title: copy.title,
        body: copy.body,
        url: copy.url,
        severity: def.severity,
      });
    }

    if (channels.email) {
      let address = recipient.email;
      if (!address && recipient.type === "customer") {
        if (customerEmail === undefined) {
          customerEmail = await customerEmailFor(db, recipient.id);
        }
        address = customerEmail;
      }
      // No address = nothing to send. The in-app row still stands, so the
      // notification isn't lost — it just doesn't leave the building.
      if (address) {
        // Email gets the FULL copy — subject plus the details laid out for
        // scanning — not the bell's one-liner. The bell has ~60 characters of
        // room and lives next to the thing it describes; an inbox has neither.
        const mailCopy = emailFor(recipient.audience) ?? copy;
        mail.push({
          storeId: input.storeId ?? null,
          eventId,
          recipientId: recipient.id,
          recipientType: recipient.type,
          email: address,
          eventKey: key,
          digest: channels.digest,
          title: mailCopy.title,
          body: mailCopy.body,
          url: mailCopy.url,
          severity: def.severity,
          // Copy lines apply to the store's own staff mail only — a shopper's
          // order confirmation must never be Cc'd to the team.
          cc: isStaff ? (audienceConfig?.templates.email?.cc ?? null) : null,
          bcc: isStaff ? (audienceConfig?.templates.email?.bcc ?? null) : null,
          // Snapshotted like the copy above, so a receipt keeps the prices it
          // was written with even if the order is edited before it sends.
          lineItems: input.email ? sanitizeSummary(input.email) : null,
          sendAfter: digestSendAfter(channels.digest).toISOString(),
        });
      }
    }

    // ── SMS ─────────────────────────────────────────────────────────────────
    // Only the merchant's own switch is read here; whether the store CAN send
    // (a connected provider, a mirrored DLT template) is resolved once, below,
    // rather than per recipient. Nothing is loaded at all unless somebody has
    // the switch on, so a store that never touches SMS pays no query for it.
    if (audienceConfig?.channels.sms && audienceKey) {
      smsCandidates.push({ recipient, audienceKey });
    }
  }

  // ★ RESOLVED ONCE PER EVENT, NOT PER RECIPIENT. Three round trips at most —
  // sender, templates, phones — and only when a switch is actually on.
  if (smsCandidates.length > 0 && input.storeId) {
    const sender = await loadSmsSender(db, input.storeId);
    if (sender) {
      const templates = await loadSmsTemplates(db, input.storeId, key);
      // Nothing to send without a mirrored template: the carrier would drop it.
      const wanted = smsCandidates.filter((c) => templates.has(c.audienceKey));
      if (wanted.length > 0) {
        const phones = await phonesForRecipients(
          db,
          wanted.map((c) => ({ id: c.recipient.id, type: c.recipient.type })),
        );
        for (const c of wanted) {
          const phone = phones.get(c.recipient.id);
          // No number on file = nothing to send to. Not an error: admins.phone
          // is nullable and mostly empty.
          if (!phone) continue;
          const template = templates.get(c.audienceKey);
          if (!template) continue;

          // ★ RENDERED AT ENQUEUE, not at send. The values are snapshotted like
          // the email queue's title/body, so a receipt keeps what it was written
          // with — and a template whose mapping no longer fits is caught HERE,
          // where it can be logged against the event, rather than in a worker
          // retry loop.
          const resolved = templateValues(
            key,
            {
              storeName: config?.storeName ?? null,
              actorLabel: input.actor?.label ?? null,
              subjectLabel: input.subject?.label ?? null,
              eventName: def?.label ?? key,
              // ISO for the reason the web/email paths give above: every value
              // goes through formatVariable exactly once, and a pre-formatted
              // date gets misread on the second pass.
              date: new Date().toISOString(),
              link: null,
            },
            input.payload ?? null,
          );
          const values = template.variables.map((name) =>
            String(resolved[name] ?? ""),
          );
          const rendered = renderDltBody(
            { templateId: template.dltTemplateId, body: template.body },
            values,
          );
          if (!rendered.ok) {
            logWarn("sms: template no longer fits its mapping", {
              storeId: input.storeId,
              event: key,
              audience: c.audienceKey,
              reason: rendered.error,
            });
            continue;
          }

          sms.push({
            storeId: input.storeId,
            eventId,
            recipientId: c.recipient.id,
            recipientType: c.recipient.type,
            phone,
            eventKey: key,
            values,
          });
        }
      }
    }
  }

  if (rows.length > 0) {
    await db.insert(notifications).values(rows).onConflictDoNothing();
  }
  if (mail.length > 0) {
    // Enqueue only — sending happens in the worker. See the header of
    // supabase/notifications_02_email_queue.sql for why a Resend call must
    // never sit on a checkout's code path.
    await db.insert(notificationEmailQueue).values(mail).onConflictDoNothing();
  }
  if (sms.length > 0) {
    // Enqueue only, for the email queue's reason: a provider round trip has no
    // business sitting on a checkout's code path.
    await db.insert(notificationSmsQueue).values(sms).onConflictDoNothing();
  }
  return mail.some((m) => m.digest === "instant");
}

/** A customer's address for the email channel, or null if they have none. */
async function customerEmailFor(
  db: Db,
  customerId: string,
): Promise<string | null> {
  try {
    const rows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, customerId))
      .limit(1);
    return rows[0]?.email ?? null;
  } catch (error) {
    logError("notifications: customer email lookup failed", error, {
      customerId,
    });
    return null;
  }
}

/**
 * Each listed recipient's personal override for this event. Keyed by
 * recipient id; absent means "no opinion, inherit".
 */
async function loadUserPreferences(
  db: Db,
  key: EventKey,
  storeId: string | null,
  recipientIds: string[],
): Promise<Map<string, PreferenceOverride>> {
  const byUser = new Map<string, PreferenceOverride>();
  if (recipientIds.length === 0) return byUser;

  const rows = await db
    .select({
      recipientId: notificationPreferences.recipientId,
      inApp: notificationPreferences.inApp,
      email: notificationPreferences.email,
      digest: notificationPreferences.digest,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.eventKey, key),
        eq(notificationPreferences.scope, "user"),
        inArray(notificationPreferences.recipientId, recipientIds),
        storeId
          ? eq(notificationPreferences.storeId, storeId)
          : isNull(notificationPreferences.storeId),
      ),
    );

  for (const row of rows) {
    byUser.set(row.recipientId, {
      inApp: row.inApp,
      email: row.email,
      digest: (row.digest as PreferenceOverride["digest"]) ?? null,
    });
  }
  return byUser;
}
