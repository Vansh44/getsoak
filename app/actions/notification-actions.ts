"use server";

// ---------------------------------------------------------------------------
// Notification & activity server actions.
//
// SCOPE RESOLUTION is the thing to understand here. One uid can be a customer
// of store A and staff of store B, and a StoreMink operator is keyed by email
// rather than uid at all. So every read resolves TWO axes:
//
//   • WHO  — `currentRecipient()`: the viewer's uid plus, for an operator,
//            their lowercased email (see the notifications RLS policy).
//   • WHERE— `currentScope()`: the store resolved from the host, or PLATFORM
//            when we're on storemink.com. Derived from the HOST, never from a
//            client-supplied id, and never from getCurrentStoreId()'s
//            never-null fallback — that would quietly show the fallback
//            store's notifications on the platform console.
//
// Reads run under withUser so RLS is the second lock on both axes; the
// scope filter is the first.
// ---------------------------------------------------------------------------

import { after } from "next/server";

import { getStoreLocations } from "@/lib/pos/locations";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { withService, withUser, type UserIdentity } from "@/lib/db/client";
import {
  activityEvents,
  admins,
  emailLogs,
  notificationEmailQueue,
  notificationPreferences,
  notifications,
  roles,
} from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { isPlatformHost } from "@/lib/store/host";
import { getViewerAccess, getViewerContext } from "@/app/dashboard/lib/access";
import {
  SECTIONS,
  SUPERADMIN_SLUG,
  can,
  normalizePermissions,
} from "@/app/dashboard/lib/permissions";
import { logError } from "@/lib/observability/logger";
import {
  DIGESTS,
  EVENTS,
  getEventDef,
  isEventKey,
  storeAdminEvents,
  merchantEvents,
  eventKeySlug,
  resolveChannels,
  type Digest,
} from "@/lib/notifications/events";
import {
  normalizeRouting,
  isRoutingMode,
  type RoutingRule,
} from "@/lib/notifications/routing";
import {
  resolveAllNotifications,
  resolveNotification,
  AUDIENCE_DESCRIPTION,
  AUDIENCE_KEYS,
  AUDIENCE_LABEL,
  type AudienceKey,
  type ChannelTemplate,
  type ResolvedNotification,
} from "@/lib/notifications/config";
import { getChannel } from "@/lib/notifications/channels";
import { defaultEmailTemplate } from "@/lib/notifications/default-templates";
import { renderTemplate } from "@/lib/notifications/template";
import { sampleValuesFor } from "@/lib/notifications/variables";
import {
  platformBrand,
  renderNotificationEmail,
} from "@/lib/email/notification-emails";
import { getStoreBrandById } from "@/lib/store/brand";
import { fromAddress } from "@/lib/email/sender";
import { findSuppressed, normalizeEmail } from "@/lib/email/suppression";
import { sendEmail } from "@/lib/email/send";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import { rateLimit } from "@/lib/rate-limit";
import { PLATFORM_URL } from "@/lib/site";
import {
  variablesFor,
  type TemplateVariable,
} from "@/lib/notifications/variables";
import { validateTemplate } from "@/lib/notifications/template";
import { sanitizeBlogContent } from "@/lib/sanitize";
import { notificationSettings } from "@/drizzle/schema";

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  severity: string;
  read_at: string | null;
  created_at: string;
}

export interface InboxResult {
  notifications: NotificationRow[];
  unread: number;
  error?: string;
}

/** The ids this viewer's notifications can be addressed to (uid, or an
 *  operator's email). Null when signed out. */
async function currentRecipient(): Promise<{
  identity: UserIdentity;
  ids: string[];
} | null> {
  const user = await getServerUser();
  if (!user) return null;
  const ids = [user.id];
  if (user.email) ids.push(user.email.toLowerCase());
  return { identity: { uid: user.id, email: user.email ?? null }, ids };
}

/** Store scope for this request, or null on the platform host. */
async function currentScope(): Promise<{ storeId: string | null }> {
  const headersList = await headers();
  const host =
    headersList.get("x-forwarded-host") || headersList.get("host") || "";
  if (isPlatformHost(host)) return { storeId: null };
  return { storeId: await getCurrentStoreId() };
}

function scopeFilter(storeId: string | null) {
  return storeId
    ? eq(notifications.storeId, storeId)
    : isNull(notifications.storeId);
}

const INBOX_PAGE_SIZE = 20;

/**
 * The bell's dropdown: this viewer's latest live notifications in the current
 * scope, plus the unread count for the badge.
 */
export async function getMyNotifications(
  limit = INBOX_PAGE_SIZE,
): Promise<InboxResult> {
  const me = await currentRecipient();
  if (!me) return { notifications: [], unread: 0 };
  const { storeId } = await currentScope();
  const take = Math.min(Math.max(1, limit), 50);

  try {
    return await withUser(me.identity, async (db) => {
      const base = and(
        inArray(notifications.recipientId, me.ids),
        scopeFilter(storeId),
        isNull(notifications.archivedAt),
      );

      // Sequential: one pooled connection per scoped transaction serves one
      // query at a time (see order-actions.ts for the full note).
      const rows = await db
        .select({
          id: notifications.id,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          url: notifications.url,
          severity: notifications.severity,
          read_at: notifications.readAt,
          created_at: notifications.createdAt,
        })
        .from(notifications)
        .where(base)
        .orderBy(desc(notifications.createdAt))
        .limit(take);
      const unreadRows = await db
        .select({ n: count() })
        .from(notifications)
        .where(and(base, isNull(notifications.readAt)));

      return { notifications: rows, unread: unreadRows[0]?.n ?? 0 };
    });
  } catch (error) {
    // The bell must never take the page down with it.
    logError("notifications: inbox read failed", error);
    return {
      notifications: [],
      unread: 0,
      error: "Couldn't load notifications.",
    };
  }
}

/** Just the badge — what the bell polls. Cheap: hits the partial unread index. */
export async function getUnreadNotificationCount(): Promise<number> {
  const me = await currentRecipient();
  if (!me) return 0;
  const { storeId } = await currentScope();

  try {
    return await withUser(me.identity, async (db) => {
      const rows = await db
        .select({ n: count() })
        .from(notifications)
        .where(
          and(
            inArray(notifications.recipientId, me.ids),
            scopeFilter(storeId),
            isNull(notifications.archivedAt),
            isNull(notifications.readAt),
          ),
        );
      return rows[0]?.n ?? 0;
    });
  } catch (error) {
    logError("notifications: unread count failed", error);
    return 0;
  }
}

/** Mark one notification read. Ownership is enforced by the recipient filter
 *  AND by RLS — a guessed id from another inbox updates zero rows. */
export async function markNotificationRead(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const me = await currentRecipient();
  if (!me) return { error: "Not signed in." };
  if (!id) return { error: "Missing notification." };

  try {
    await withUser(me.identity, (db) =>
      db
        .update(notifications)
        .set({ readAt: sql`NOW()` })
        .where(
          and(
            eq(notifications.id, id),
            inArray(notifications.recipientId, me.ids),
            isNull(notifications.readAt),
          ),
        ),
    );
    return { success: true };
  } catch (error) {
    logError("notifications: mark read failed", error);
    return { error: "Couldn't update that notification." };
  }
}

export async function markAllNotificationsRead(): Promise<{
  success?: boolean;
  error?: string;
}> {
  const me = await currentRecipient();
  if (!me) return { error: "Not signed in." };
  const { storeId } = await currentScope();

  try {
    await withUser(me.identity, (db) =>
      db
        .update(notifications)
        .set({ readAt: sql`NOW()` })
        .where(
          and(
            inArray(notifications.recipientId, me.ids),
            scopeFilter(storeId),
            isNull(notifications.readAt),
          ),
        ),
    );
    return { success: true };
  } catch (error) {
    logError("notifications: mark all read failed", error);
    return { error: "Couldn't update your notifications." };
  }
}

/** Dismiss a notification from the inbox (kept in the DB for the audit trail). */
export async function archiveNotification(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const me = await currentRecipient();
  if (!me) return { error: "Not signed in." };

  try {
    await withUser(me.identity, (db) =>
      db
        .update(notifications)
        .set({ archivedAt: sql`NOW()`, readAt: sql`COALESCE(read_at, NOW())` })
        .where(
          and(
            eq(notifications.id, id),
            inArray(notifications.recipientId, me.ids),
          ),
        ),
    );
    return { success: true };
  } catch (error) {
    logError("notifications: archive failed", error);
    return { error: "Couldn't dismiss that notification." };
  }
}

// ── Activity feed (/dashboard/activity) ────────────────────────────────────

export interface ActivityRow {
  id: string;
  type: string;
  actor_type: string;
  actor_label: string | null;
  subject_type: string | null;
  subject_label: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ActivityResult {
  events: ActivityRow[];
  total: number;
  error?: string;
}

export interface GetActivityParams {
  page?: number;
  pageSize?: number;
  /** Registry event key, or a group name ("Orders"); anything else = all. */
  type?: string;
  group?: string;
  /** "today" | "7d" | "30d" | "" */
  dateRange?: string;
}

function activityFloor(range: string | undefined): Date | null {
  const DAY = 86_400_000;
  switch (range) {
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
    case "7d":
      return new Date(Date.now() - 7 * DAY);
    case "30d":
      return new Date(Date.now() - 30 * DAY);
    default:
      return null;
  }
}

const ACTIVITY_PAGE_SIZE = 50;

/**
 * The store's audit trail. Gated on `activity` view permission; RLS
 * (is_store_admin / is_platform_admin) is the independent second check.
 */
export async function getActivityFeed(
  params: GetActivityParams = {},
): Promise<ActivityResult> {
  const ctx = await getViewerContext();
  if (!ctx) return { events: [], total: 0, error: "Not signed in." };
  const { storeId } = await currentScope();

  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(
    Math.max(1, params.pageSize ?? ACTIVITY_PAGE_SIZE),
    100,
  );

  const conds = [
    storeId
      ? eq(activityEvents.storeId, storeId)
      : isNull(activityEvents.storeId),
  ];

  // A specific event type wins; otherwise a group expands to its keys. An
  // unknown value is ignored (treated as "all") rather than erroring.
  if (params.type && isEventKey(params.type)) {
    conds.push(eq(activityEvents.type, params.type));
  } else if (params.group) {
    // A group filter covers EVERY event in that group — including the
    // audit-only ones, which never reach an inbox but are the whole point of
    // the feed. (storeAdminEvents() would wrongly drop them.)
    const groupKeys = EVENTS.filter((d) => d.group === params.group).map(
      (d) => d.key,
    );
    if (groupKeys.length) conds.push(inArray(activityEvents.type, groupKeys));
  }

  const floor = activityFloor(params.dateRange);
  if (floor) conds.push(gte(activityEvents.createdAt, floor.toISOString()));

  try {
    const identity: UserIdentity = {
      uid: ctx.userId,
      email: ctx.userEmail,
    };
    return await withUser(identity, async (db) => {
      const where = and(...conds);
      // Sequential (single pooled connection) — see order-actions.ts.
      const rows = await db
        .select({
          id: activityEvents.id,
          type: activityEvents.type,
          actor_type: activityEvents.actorType,
          actor_label: activityEvents.actorLabel,
          subject_type: activityEvents.subjectType,
          subject_label: activityEvents.subjectLabel,
          payload: activityEvents.payload,
          created_at: activityEvents.createdAt,
        })
        .from(activityEvents)
        .where(where)
        .orderBy(desc(activityEvents.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const totals = await db
        .select({ n: count() })
        .from(activityEvents)
        .where(where);

      return {
        events: rows.map((r) => ({
          ...r,
          payload: (r.payload ?? {}) as Record<string, unknown>,
        })),
        total: totals[0]?.n ?? 0,
      };
    });
  } catch (error) {
    logError("notifications: activity feed failed", error, {
      storeId: storeId ?? undefined,
    });
    return { events: [], total: 0, error: "Couldn't load the activity feed." };
  }
}
// ── Notification console (Settings → Notifications) ────────────────────────
//
// Gated on the `notifications` permission section: superadmin has it by
// default, and an owner can grant it to any role from Roles & Permissions
// (the role editor renders SECTIONS, so it appears there automatically).

/** One audience's slice of a notification, flattened for the client. */
export interface ConsoleAudience {
  key: AudienceKey;
  label: string;
  description: string;
  channels: Record<string, boolean>;
  /** Channel keys that are on — what the list's badges render. */
  enabledChannels: string[];
  templates: Partial<Record<string, ChannelTemplate>>;
  /** Team only: a customer notification has exactly one recipient. */
  routing?: RoutingRule;
}

export interface ConsoleRow {
  key: string;
  displayName: string;
  description: string;
  category: string;
  section: string;
  severity: string;
  /** Only the audiences this notification actually reaches, in Team → Customer
   *  order. The UI renders what's here, so it can never offer a tab that
   *  configures nobody. */
  audiences: ConsoleAudience[];
  digest: Digest;
  isEnabled: boolean;
  isCustom: boolean;
  configurable: boolean;
  /** Can carry a locationId — gates the location routing scope in the UI. */
  hasLocation: boolean;
  isConfigured: boolean;
}

/** Every channel on across all of a notification's audiences. */
function enabledChannelsOf(row: ConsoleRow): string[] {
  return [...new Set(row.audiences.flatMap((a) => a.enabledChannels))];
}

export interface ConsoleResult {
  rows: ConsoleRow[];
  /** Category → count, for the filter tabs. */
  counts: Record<string, number>;
  total: number;
  canManage: boolean;
  error?: string;
}

function toConsoleRow(n: ResolvedNotification): ConsoleRow {
  const audiences: ConsoleAudience[] = [];
  for (const key of AUDIENCE_KEYS) {
    const config = n.audiences[key];
    if (!config) continue;
    audiences.push({
      key,
      label: AUDIENCE_LABEL[key],
      description: AUDIENCE_DESCRIPTION[key],
      channels: config.channels,
      enabledChannels: Object.entries(config.channels)
        .filter(([, on]) => on)
        .map(([channel]) => channel),
      templates: config.templates,
      ...(config.routing ? { routing: config.routing } : {}),
    });
  }

  return {
    key: n.key,
    displayName: n.displayName,
    description: n.description,
    category: n.category,
    section: n.section,
    severity: n.severity,
    audiences,
    digest: n.digest,
    isEnabled: n.isEnabled,
    isCustom: n.isCustom,
    configurable: n.configurable,
    hasLocation: !!n.hasLocation,
    isConfigured: n.isConfigured,
  };
}

/**
 * The console list. Filtering is done in memory on purpose: the catalog is a
 * few dozen rows resolved from three layers, so pushing search into SQL would
 * mean the DB filtering a set it doesn't fully own.
 */
export async function getNotificationConsole(
  params: {
    category?: string;
    audience?: string;
    channel?: string;
    q?: string;
  } = {},
): Promise<ConsoleResult> {
  const access = await getViewerAccess();
  if (!access) {
    return {
      rows: [],
      counts: {},
      total: 0,
      canManage: false,
      error: "Not signed in.",
    };
  }
  if (!access.can("notifications", "view")) {
    return {
      rows: [],
      counts: {},
      total: 0,
      canManage: false,
      error: "You don't have access to notification settings.",
    };
  }

  const { storeId } = await currentScope();
  // EVERY merchant-configurable event, not just the ones aimed at staff —
  // shopper-facing notifications belong in this list too, and their absence
  // is exactly why "where do I edit my customer's email?" had no answer.
  const defs = merchantEvents();

  try {
    const resolved = await withService((db) =>
      resolveAllNotifications(db, storeId, defs),
    );
    const rows = resolved.map(toConsoleRow);

    // Counts reflect the CATALOG, not the current filter — the tabs shouldn't
    // change their numbers as you type in the search box.
    const counts: Record<string, number> = { all: rows.length };
    for (const row of rows) {
      counts[row.category] = (counts[row.category] ?? 0) + 1;
      for (const audience of row.audiences) {
        counts[`audience:${audience.key}`] =
          (counts[`audience:${audience.key}`] ?? 0) + 1;
      }
      for (const channel of enabledChannelsOf(row)) {
        counts[`channel:${channel}`] = (counts[`channel:${channel}`] ?? 0) + 1;
      }
    }

    const term = (params.q ?? "").trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (params.category && row.category !== params.category) return false;
      if (
        params.audience &&
        !row.audiences.some((a) => a.key === params.audience)
      ) {
        return false;
      }
      if (params.channel && !enabledChannelsOf(row).includes(params.channel)) {
        return false;
      }
      if (
        term &&
        !row.displayName.toLowerCase().includes(term) &&
        !row.key.toLowerCase().includes(term) &&
        !row.description.toLowerCase().includes(term)
      ) {
        return false;
      }
      return true;
    });

    return {
      rows: filtered,
      counts,
      total: rows.length,
      canManage: access.can("notifications", "manage"),
    };
  } catch (error) {
    logError("notifications: console list failed", error);
    return {
      rows: [],
      counts: {},
      total: 0,
      canManage: false,
      error: "Couldn't load notifications.",
    };
  }
}

export interface NotificationDetail {
  notification: ConsoleRow;
  /** The store has more than one location, so "only where it happened" is a
   *  meaningful choice. False keeps the control hidden entirely. */
  multiLocation: boolean;
  /** Built-in copy PER AUDIENCE, pre-filled into the editor. */
  defaults: Record<string, { subject: string; body: string }>;
  variables: TemplateVariable[];
  audience: StoreAudience;
  canManage: boolean;
  error?: string;
}

/** One notification's full configuration, for the detail page. */
export async function getNotificationDetail(
  key: string,
): Promise<NotificationDetail | { error: string }> {
  const access = await getViewerAccess();
  if (!access) return { error: "Not signed in." };
  if (!access.can("notifications", "view")) {
    return { error: "You don't have access to notification settings." };
  }
  const def = getEventDef(key);
  if (!def) return { error: "Unknown notification." };

  const { storeId } = await currentScope();

  try {
    const resolved = await withService((db) =>
      resolveNotification(db, storeId, def.key),
    );
    if (!resolved) return { error: "That notification isn't available." };

    // The built-in EMAIL copy PER AUDIENCE — subject + a full body, not the
    // one-line bell text — so each editor is pre-filled with exactly what
    // would be sent to that audience.
    const defaults: Record<string, { subject: string; body: string }> = {};
    for (const audience of AUDIENCE_KEYS) {
      if (!resolved.audiences[audience]) continue;
      defaults[audience] = defaultEmailTemplate(def.key, audience);
    }

    return {
      notification: toConsoleRow(resolved),
      // Cheap and only on the detail page: a single-location store never sees
      // a control whose two options mean the same thing.
      multiLocation: storeId
        ? (await getStoreLocations(storeId)).length > 1
        : false,
      defaults,
      variables: variablesFor(def.key),
      audience: await getStoreNotificationAudience(),
      canManage: access.can("notifications", "manage"),
    };
  } catch (error) {
    logError("notifications: detail read failed", error, { key });
    return { error: "Couldn't load that notification." };
  }
}

/** Cc/Bcc are comma-separated lists. Capped at 10: this is a copy line, not a
 *  mailing list — a store wanting 50 recipients wants the recipient picker. */
const MAX_COPY_ADDRESSES = 10;

function parseAddressList(raw: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[,;]/).slice(0, MAX_COPY_ADDRESSES)) {
    const address = part.trim().toLowerCase();
    if (!address) continue;
    // Deliberately simple: catches typos and blocks header-injection
    // characters. Full RFC 5322 validation belongs to the mail server.
    if (!/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]{2,}$/.test(address)) {
      invalid.push(address);
      continue;
    }
    if (!valid.includes(address)) valid.push(address);
  }
  return { valid, invalid };
}

/** What the console edits for ONE audience of a notification. */
export interface SaveAudienceInput {
  /** Per-channel on/off. Unavailable channels are rejected server-side. */
  channels?: Record<string, boolean>;
  /** Per-channel subject/body/cc/bcc. Validated against the event's variables. */
  templates?: Record<string, ChannelTemplate>;
  /** Team only; ignored (and rejected) for the customer audience, which has
   *  exactly one recipient by definition. */
  routing?: {
    mode: string;
    /** "store" (default) or "event_location" — see routing.ts. */
    scope?: string;
    roles?: string[];
    admins?: string[];
  };
}

export interface SaveNotificationInput {
  digest?: string;
  isEnabled?: boolean;
  /** Keyed by audience: { team: {...}, customer: {...} }. */
  audiences?: Partial<Record<AudienceKey, SaveAudienceInput>>;
}

/**
 * Save one notification's configuration for this store. Everything the console
 * edits flows through here onto a single row, so a store's settings for an
 * event stay in one place.
 */
export async function saveNotificationConfig(
  key: string,
  input: SaveNotificationInput,
): Promise<{ success?: boolean; error?: string }> {
  const access = await getViewerAccess();
  if (!access) return { error: "Not signed in." };
  if (!access.can("notifications", "manage")) {
    return { error: "You don't have permission to change notifications." };
  }
  const def = getEventDef(key);
  if (!def) return { error: "Unknown notification." };

  const { storeId } = await currentScope();
  if (!storeId) return { error: "Notification settings need a store." };

  const values: Record<string, unknown> = { updatedBy: access.userId };

  if (input.digest !== undefined) {
    if (!DIGESTS.includes(input.digest as Digest)) {
      return { error: "Invalid email frequency." };
    }
    values.digest = input.digest;
  }

  // ── On/off: some notifications must not be switchable (role changes,
  // failed billing) — the registry decides, not the request.
  if (input.isEnabled !== undefined) {
    if (def.configurable === false && !input.isEnabled) {
      return { error: "This notification can't be switched off." };
    }
    values.isEnabled = Boolean(input.isEnabled);
  }

  // ── Per-audience configuration. Team and customer are edited and stored
  // separately, so a merchant changing what their staff see can never alter
  // what a shopper receives (that was a real bug, not a hypothetical).
  const channelsByAudience: Record<string, Record<string, boolean>> = {};
  const templatesByAudience: Record<
    string,
    Record<string, ChannelTemplate>
  > = {};

  for (const audienceKey of AUDIENCE_KEYS) {
    const audienceInput = input.audiences?.[audienceKey];
    if (!audienceInput) continue;
    const audienceLabel = AUDIENCE_LABEL[audienceKey];

    // Channels: an unavailable channel can never be switched on. The UI shows
    // those locked, but the UI is not the enforcement point.
    if (audienceInput.channels) {
      const channels: Record<string, boolean> = {};
      for (const [channelKey, on] of Object.entries(audienceInput.channels)) {
        const channel = getChannel(channelKey);
        if (!channel) continue;
        if (!channel.available && on) {
          return { error: `${channel.label} isn't connected yet.` };
        }
        channels[channelKey] = Boolean(on);
      }
      channelsByAudience[audienceKey] = channels;
    }

    // Recipients. Superadmin-only, and TEAM-only: a customer notification has
    // exactly one recipient — the person it happened to — so there is nothing
    // to route, and accepting a rule there would imply otherwise.
    if (audienceInput.routing) {
      if (audienceKey !== "team") {
        return {
          error: "Customer notifications always go to the customer.",
        };
      }
      if (!access.isSuperadmin) {
        return { error: "Only a store owner can choose who gets notified." };
      }
      if (!isRoutingMode(audienceInput.routing.mode)) {
        return { error: "Invalid recipient rule." };
      }
      const rule = normalizeRouting({
        routing: audienceInput.routing.mode,
        // Independent of mode — "people with the orders permission, AT this
        // order's location" is a mode AND a scope (lib/notifications/routing.ts).
        routing_scope: audienceInput.routing.scope,
        target_roles: audienceInput.routing.roles,
        target_admins: audienceInput.routing.admins,
      });
      values.routing = rule.mode;
      values.routingScope = rule.scope;
      values.targetRoles = rule.roles;
      values.targetAdmins = rule.admins;
    }

    // Templates: every token must be one this event actually provides, or the
    // merchant would ship a blank into someone's inbox.
    if (audienceInput.templates) {
      // The editor arrives PRE-FILLED with the built-in copy, so "unchanged"
      // looks identical to "customised". Comparing against that audience's
      // default lets us store an override only when something actually
      // changed — otherwise every store that opened this page and hit Submit
      // would freeze today's wording and stop receiving improvements to it.
      const builtIn = defaultEmailTemplate(def.key, audienceKey);

      const templates: Record<string, ChannelTemplate> = {};
      for (const [channelKey, template] of Object.entries(
        audienceInput.templates,
      )) {
        const channel = getChannel(channelKey);
        if (!channel || !template) continue;

        const entry: ChannelTemplate = {};
        for (const [field, kind] of [
          ["subject", "subject"],
          ["body", "body"],
        ] as const) {
          const raw = template[field];
          if (typeof raw !== "string") continue;
          const trimmed = raw.trim();
          // Cleared → fall back to the built-in copy.
          if (!trimmed) continue;
          // Identical to the built-in copy → not an override.
          if (channelKey === "email" && trimmed === builtIn[field].trim()) {
            continue;
          }
          const check = validateTemplate(trimmed, def.key, kind);
          if (!check.valid) {
            return {
              error: `${audienceLabel} · ${channel.label} ${field}: ${check.error}`,
            };
          }
          entry[field] =
            field === "body" ? sanitizeBlogContent(trimmed) : trimmed;
        }

        // Cc/Bcc are real addresses that will receive store data, so they are
        // validated rather than trimmed and hoped for. Team only: copying a
        // shopper's confirmation to staff would leak their address both ways.
        if (audienceKey === "team") {
          for (const field of ["cc", "bcc"] as const) {
            const raw = template[field];
            if (typeof raw !== "string") continue;
            const parsed = parseAddressList(raw);
            if (parsed.invalid.length) {
              return {
                error: `${channel.label} ${field.toUpperCase()}: ${parsed.invalid[0]} isn't a valid email address.`,
              };
            }
            if (parsed.valid.length) entry[field] = parsed.valid.join(", ");
          }
        }

        if (Object.keys(entry).length > 0) templates[channelKey] = entry;
      }
      templatesByAudience[audienceKey] = templates;
    }
  }

  if (Object.keys(channelsByAudience).length > 0) {
    values.channels = channelsByAudience;
  }
  if (Object.keys(templatesByAudience).length > 0) {
    values.templates = templatesByAudience;
  }

  try {
    await withService(async (db) => {
      const existing = await db
        .select({ id: notificationSettings.id })
        .from(notificationSettings)
        .where(
          and(
            eq(notificationSettings.storeId, storeId),
            eq(notificationSettings.eventKey, def.key),
          ),
        )
        .limit(1);

      if (existing[0]) {
        await db
          .update(notificationSettings)
          .set(values)
          .where(eq(notificationSettings.id, existing[0].id));
      } else {
        await db
          .insert(notificationSettings)
          .values({ storeId, eventKey: def.key, ...values });
      }
    });

    revalidatePath("/dashboard/settings/notifications");
    revalidatePath(
      `/dashboard/settings/notifications/${eventKeySlug(def.key)}`,
    );
    return { success: true };
  } catch (error) {
    logError("notifications: config save failed", error, { key });
    return { error: "Couldn't save that notification." };
  }
}

/**
 * Render a notification email exactly as it would arrive — the store's brand,
 * logo, layout and footer — from whatever is currently in the editor.
 *
 * The console can't do this itself: the branded layout resolves the store's
 * brand, which is server-only. So the preview is a round-trip, debounced by
 * the client. It renders with SAMPLE values, never live store data.
 */
export async function previewNotificationEmail(
  key: string,
  template: { subject?: string; body?: string },
): Promise<{ html?: string; subject?: string; error?: string }> {
  const access = await getViewerAccess();
  if (!access) return { error: "Not signed in." };
  if (!access.can("notifications", "view")) {
    return { error: "No access to notification settings." };
  }
  const def = getEventDef(key);
  if (!def) return { error: "Unknown notification." };

  const { storeId } = await currentScope();
  const fallback = defaultEmailTemplate(def.key);
  const values = sampleValuesFor(def.key);

  try {
    const brand = storeId ? await getStoreBrandById(storeId) : platformBrand();
    const rendered = renderNotificationEmail({
      item: {
        title: renderTemplate(
          (template.subject || "").trim() || fallback.subject,
          values,
          "text",
        ),
        body: renderTemplate(
          (template.body || "").trim() || fallback.body,
          values,
          "text",
        ),
        url: "/dashboard",
        severity: def.severity,
      },
      brand,
      baseUrl: storeId ? "https://example.storemink.com" : PLATFORM_URL,
    });
    return { html: rendered.html, subject: rendered.subject };
  } catch (error) {
    logError("notifications: email preview failed", error, { key });
    return { error: "Couldn't render the preview." };
  }
}

/**
 * Mail the notification to the signed-in admin, exactly as it would arrive.
 *
 * The single highest-confidence affordance in a template editor: a preview
 * shows what you think you wrote, a real email in your own inbox shows what
 * your recipients will actually see (after their client has had its way with
 * it). Sends with SAMPLE values, to the caller's OWN address only — never to a
 * customer, and never to an address supplied by the request.
 */
export async function sendTestNotificationEmail(
  key: string,
  audience: string,
  template: { subject?: string; body?: string },
): Promise<{ success?: boolean; sentTo?: string; error?: string }> {
  const access = await getViewerAccess();
  if (!access) return { error: "Not signed in." };
  if (!access.can("notifications", "manage")) {
    return { error: "You don't have permission to send test emails." };
  }
  const def = getEventDef(key);
  if (!def) return { error: "Unknown notification." };
  if (!access.email) return { error: "Your account has no email address." };

  const audienceKey = (AUDIENCE_KEYS as readonly string[]).includes(audience)
    ? (audience as AudienceKey)
    : "team";

  // Rate limited per admin: this is an outbound send triggered by a button,
  // and a stuck finger shouldn't become a mail-provider complaint.
  const rl = await rateLimit(`notif-test:${access.userId}`, {
    max: 10,
    windowSeconds: 600,
  });
  if (!rl.allowed) {
    return { error: "Too many test emails. Try again in a few minutes." };
  }

  const { storeId } = await currentScope();
  const fallback = defaultEmailTemplate(def.key, audienceKey);
  const values = sampleValuesFor(def.key);

  try {
    const brand = storeId ? await getStoreBrandById(storeId) : platformBrand();
    const rendered = renderNotificationEmail({
      item: {
        title: renderTemplate(
          (template.subject || "").trim() || fallback.subject,
          values,
          "text",
        ),
        body: renderTemplate(
          (template.body || "").trim() || fallback.body,
          values,
          "text",
        ),
        url: "/dashboard",
        severity: def.severity,
      },
      brand,
      baseUrl: storeId ? `https://${brand.domain}` : PLATFORM_URL,
    });

    const result = await sendEmail({
      storeId,
      from: fromAddress(brand, { suffix: "Notifications" }),
      to: access.email,
      // Flagged in the subject so a test can never be mistaken for the real
      // thing sitting in an inbox next to it.
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      mailer: "notification_test",
    });
    if (!result.sent) {
      logError("notifications: test send failed", result.error, { key });
      return {
        error: result.error ?? "Couldn't send the test email.",
      };
    }
    return { success: true, sentTo: access.email };
  } catch (error) {
    logError("notifications: test send threw", error, { key });
    return { error: "Couldn't send the test email." };
  }
}

// ── Personal preferences ("My notifications") ──────────────────────────────

export interface MyPreferenceRow {
  key: string;
  label: string;
  description: string;
  group: string;
  configurable: boolean;
  inApp: boolean;
  email: boolean;
}

/**
 * A staff member's own opt-outs. Distinct from the console: this can only say
 * "not me", never "them instead", and needs no special permission — it is
 * their own inbox.
 */
export async function getMyNotificationPreferences(): Promise<{
  rows: MyPreferenceRow[];
  error?: string;
}> {
  const ctx = await getViewerContext();
  if (!ctx || !ctx.profile) return { rows: [], error: "Not signed in." };
  const { storeId } = await currentScope();
  const defs = storeAdminEvents();

  try {
    const [resolved, overrides] = await withService(async (db) => {
      const resolved = await resolveAllNotifications(db, storeId, defs);
      const rows = await db
        .select({
          eventKey: notificationPreferences.eventKey,
          inApp: notificationPreferences.inApp,
          email: notificationPreferences.email,
        })
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.scope, "user"),
            eq(notificationPreferences.recipientId, ctx.userId),
            storeId
              ? eq(notificationPreferences.storeId, storeId)
              : isNull(notificationPreferences.storeId),
          ),
        );
      return [resolved, rows] as const;
    });

    const byKey = new Map(overrides.map((r) => [r.eventKey, r]));
    const rows: MyPreferenceRow[] = resolved
      // Only what reaches this person: a shopper-facing notification has no
      // team audience, so there is nothing here for a staff member to opt out of.
      .filter((n) => n.isEnabled && n.audiences.team)
      .map((n) => {
        const def = getEventDef(n.key);
        const mine = byKey.get(n.key);
        const channels = resolveChannels(
          def!,
          "store-admins",
          {
            inApp: n.audiences.team?.channels.web ?? false,
            email: n.audiences.team?.channels.email ?? false,
            digest: n.digest,
          },
          mine ? { inApp: mine.inApp, email: mine.email } : null,
        );
        return {
          key: n.key,
          label: n.displayName,
          description: n.description,
          group: n.category,
          configurable: n.configurable,
          inApp: channels.inApp,
          email: channels.email,
        };
      });

    return { rows };
  } catch (error) {
    logError("notifications: my preferences read failed", error);
    return { rows: [], error: "Couldn't load your notification settings." };
  }
}

export async function saveMyNotificationPreferences(
  updates: { eventKey: string; inApp: boolean; email: boolean }[],
): Promise<{ success?: boolean; error?: string }> {
  const ctx = await getViewerContext();
  if (!ctx || !ctx.profile) return { error: "Not signed in." };
  if (!Array.isArray(updates) || updates.length === 0) {
    return { error: "Nothing to save." };
  }
  if (updates.length > 200) return { error: "Too many changes at once." };

  const { storeId } = await currentScope();

  const rows = updates
    .map((update) => {
      const def = getEventDef(update.eventKey);
      if (!def || def.configurable === false) return null;
      return {
        storeId,
        scope: "user" as const,
        recipientId: ctx.userId,
        eventKey: def.key,
        inApp: Boolean(update.inApp),
        email: Boolean(update.email),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) return { error: "No valid settings to save." };

  try {
    await withService(async (db) => {
      for (const row of rows) {
        const existing = await db
          .select({ id: notificationPreferences.id })
          .from(notificationPreferences)
          .where(
            and(
              row.storeId
                ? eq(notificationPreferences.storeId, row.storeId)
                : isNull(notificationPreferences.storeId),
              eq(notificationPreferences.scope, "user"),
              eq(notificationPreferences.recipientId, row.recipientId),
              eq(notificationPreferences.eventKey, row.eventKey),
            ),
          )
          .limit(1);

        if (existing[0]) {
          await db
            .update(notificationPreferences)
            .set({ inApp: row.inApp, email: row.email })
            .where(eq(notificationPreferences.id, existing[0].id));
        } else {
          await db.insert(notificationPreferences).values(row);
        }
      }
    });

    revalidatePath("/dashboard/settings/notifications/me");
    return { success: true };
  } catch (error) {
    logError("notifications: my preferences save failed", error);
    return { error: "Couldn't save your notification settings." };
  }
}

// ── Audience (for the recipient picker) ────────────────────────────────────

export interface AudienceMember {
  id: string;
  name: string;
  email: string;
  roleSlug: string;
  /** Sections this person may `view` — the picker uses it to show who is
   *  eligible for which notification, and to explain who isn't. */
  sections: string[];
}

export interface AudienceRole {
  slug: string;
  name: string;
}

export interface StoreAudience {
  roles: AudienceRole[];
  members: AudienceMember[];
  error?: string;
}

/**
 * The store's staff and roles. Includes each person's viewable sections so the
 * picker can show, per notification, who would actually receive it — routing
 * NARROWS the permission-derived set and can never widen it (see
 * lib/notifications/routing.ts), and a merchant should be told that plainly
 * rather than have a pick silently do nothing.
 */
export async function getStoreNotificationAudience(): Promise<StoreAudience> {
  const ctx = await getViewerContext();
  if (!ctx || !ctx.profile) {
    return { roles: [], members: [], error: "Not signed in." };
  }
  const { storeId } = await currentScope();
  if (!storeId) return { roles: [], members: [] };

  try {
    return await withService(async (db) => {
      // Sequential: one pooled connection per scoped transaction.
      const staff = await db
        .select({
          id: admins.id,
          email: admins.email,
          role: admins.role,
          firstName: admins.firstName,
          lastName: admins.lastName,
        })
        .from(admins)
        .where(
          and(
            eq(admins.storeId, storeId),
            or(isNull(admins.isSuspended), eq(admins.isSuspended, false)),
          ),
        );
      const roleRows = await db
        .select({
          slug: roles.slug,
          name: roles.name,
          permissions: roles.permissions,
        })
        .from(roles)
        .where(eq(roles.storeId, storeId));

      const permsBySlug = new Map(
        roleRows.map((r) => [r.slug, normalizePermissions(r.permissions)]),
      );

      const members: AudienceMember[] = staff.map((member) => {
        const slug = member.role ?? "";
        const isSuperadmin = slug === SUPERADMIN_SLUG;
        const perms = permsBySlug.get(slug);
        // Mirrors storeAdminRecipients exactly, so what the picker shows as
        // eligible is precisely who the fan-out will deliver to.
        const sections = SECTIONS.filter((section) =>
          isSuperadmin
            ? true
            : perms
              ? can(perms, section.key, "view")
              : slug === "member",
        ).map((section) => section.key);

        return {
          id: member.id,
          name:
            [member.firstName, member.lastName].filter(Boolean).join(" ") ||
            member.email,
          email: member.email,
          roleSlug: slug,
          sections,
        };
      });

      const roleList: AudienceRole[] = [
        { slug: SUPERADMIN_SLUG, name: "Owner" },
        ...roleRows
          .filter((r) => r.slug !== SUPERADMIN_SLUG)
          .map((r) => ({ slug: r.slug, name: r.name })),
      ];

      return { roles: roleList, members };
    });
  } catch (error) {
    logError("notifications: audience read failed", error);
    return { roles: [], members: [], error: "Couldn't load your team." };
  }
}

// ── Retention ──────────────────────────────────────────────────────────────

/**
 * Delete inbox rows and audit events past their retention window. Called by
 * the daily cron — an inbox that grows forever is a slow outage.
 */
export async function pruneNotifications(
  notificationDays = 90,
  eventDays = 365,
  // Email logs keep BODIES, so they're the heaviest of the three and get the
  // shortest life. 90 days still covers "did last quarter's order confirmation
  // go out?", which is the question anyone actually asks.
  emailLogDays = 90,
): Promise<{ notifications: number; events: number; emailLogs: number }> {
  const notificationFloor = new Date(
    Date.now() - notificationDays * 86_400_000,
  ).toISOString();
  const eventFloor = new Date(
    Date.now() - eventDays * 86_400_000,
  ).toISOString();
  const emailFloor = new Date(
    Date.now() - emailLogDays * 86_400_000,
  ).toISOString();

  return withService(async (db) => {
    const removedNotifications = await db
      .delete(notifications)
      .where(lt(notifications.createdAt, notificationFloor))
      .returning({ id: notifications.id });
    const removedEvents = await db
      .delete(activityEvents)
      .where(lt(activityEvents.createdAt, eventFloor))
      .returning({ id: activityEvents.id });
    const removedEmailLogs = await db
      .delete(emailLogs)
      .where(lt(emailLogs.createdAt, emailFloor))
      .returning({ id: emailLogs.id });
    return {
      notifications: removedNotifications.length,
      events: removedEvents.length,
      emailLogs: removedEmailLogs.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Delivery failures — making the dead-letter queue visible
// ---------------------------------------------------------------------------
//
// A queue row that burned through its retries was marked 'failed' and that was
// the end of it: no error surfaced anywhere a person would look, so a store
// whose notification mail had stopped arriving had no way to find out except by
// noticing the silence. This is the surface for that.
//
// Read-only and store-scoped. It reports WHAT failed and WHY; clearing a
// suppression is an operator action, because a suppression is platform-wide.

export interface DeliveryFailure {
  id: string;
  email: string;
  title: string;
  eventKey: string;
  error: string | null;
  attempts: number;
  createdAt: string;
  /** True when the address itself is out of service, not just this send. */
  suppressed: boolean;
}

export interface DeliveryHealth {
  failures: DeliveryFailure[];
  /** Failed rows in the window, which may exceed the listed sample. */
  total: number;
  error?: string;
}

/** How far back the panel looks. Older failures are history, not a live issue. */
const DELIVERY_WINDOW_DAYS = 7;
const DELIVERY_SAMPLE = 20;

/**
 * Recent notification emails that could not be delivered for the current store.
 * Gated on the same `notifications` section as the rest of the console.
 */
export async function getDeliveryHealth(): Promise<DeliveryHealth> {
  const access = await getViewerAccess();
  if (!access) return { failures: [], total: 0, error: "Not signed in." };
  if (!access.can("notifications", "view")) {
    return {
      failures: [],
      total: 0,
      error: "You don't have access to notification settings.",
    };
  }

  const { storeId } = await currentScope();
  const since = new Date(
    Date.now() - DELIVERY_WINDOW_DAYS * 86_400_000,
  ).toISOString();

  try {
    // Service scope: notification_email_queue is worker-only (RLS on, no
    // policies — the rows are email addresses), so the store filter below IS
    // the tenancy boundary. It must never be dropped.
    const rows = await withService((db) =>
      db
        .select({
          id: notificationEmailQueue.id,
          email: notificationEmailQueue.email,
          title: notificationEmailQueue.title,
          eventKey: notificationEmailQueue.eventKey,
          error: notificationEmailQueue.lastError,
          attempts: notificationEmailQueue.attempts,
          createdAt: notificationEmailQueue.createdAt,
        })
        .from(notificationEmailQueue)
        .where(
          and(
            storeId
              ? eq(notificationEmailQueue.storeId, storeId)
              : isNull(notificationEmailQueue.storeId),
            eq(notificationEmailQueue.status, "failed"),
            gte(notificationEmailQueue.createdAt, since),
          ),
        )
        .orderBy(desc(notificationEmailQueue.createdAt))
        .limit(DELIVERY_SAMPLE),
    );

    if (rows.length === 0) return { failures: [], total: 0 };

    // Sequential, not Promise.all — one pooled connection per scoped
    // transaction (see order-actions.ts).
    const suppressed = await findSuppressed(rows.map((r) => r.email));

    const counted = await withService((db) =>
      db
        .select({ n: count() })
        .from(notificationEmailQueue)
        .where(
          and(
            storeId
              ? eq(notificationEmailQueue.storeId, storeId)
              : isNull(notificationEmailQueue.storeId),
            eq(notificationEmailQueue.status, "failed"),
            gte(notificationEmailQueue.createdAt, since),
          ),
        ),
    );

    return {
      failures: rows.map((r) => ({
        ...r,
        suppressed: suppressed.has(normalizeEmail(r.email)),
      })),
      total: counted[0]?.n ?? rows.length,
    };
  } catch (error) {
    logError("getDeliveryHealth failed", error);
    return { failures: [], total: 0, error: "Could not load delivery status." };
  }
}

/**
 * Put a failed row back in the queue for another try.
 *
 * Refuses a suppressed address rather than pretending: retrying one is
 * guaranteed to fail again and spends the shared domain's reputation doing it.
 * Attempts reset to zero so the row gets a full set of retries, not the tail of
 * an exhausted one.
 */
export async function retryFailedEmail(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const access = await getViewerAccess();
  if (!access) return { error: "Not signed in." };
  if (!access.can("notifications", "manage")) {
    return { error: "You don't have permission to manage notifications." };
  }

  const { storeId } = await currentScope();

  try {
    const rows = await withService((db) =>
      db
        .select({ email: notificationEmailQueue.email })
        .from(notificationEmailQueue)
        .where(
          and(
            eq(notificationEmailQueue.id, id),
            storeId
              ? eq(notificationEmailQueue.storeId, storeId)
              : isNull(notificationEmailQueue.storeId),
            eq(notificationEmailQueue.status, "failed"),
          ),
        )
        .limit(1),
    );
    const target = rows[0];
    if (!target) return { error: "That message is no longer retryable." };

    const suppressed = await findSuppressed([target.email]);
    if (suppressed.has(normalizeEmail(target.email))) {
      return {
        error:
          "This address bounced permanently or reported spam. Retrying can't succeed — contact the recipient for a working address.",
      };
    }

    // Store-scoped and status-guarded, so a stale click can't resurrect a row
    // that has since been retried by someone else.
    const claimed = await withService((db) =>
      db
        .update(notificationEmailQueue)
        .set({
          status: "pending",
          attempts: 0,
          claimedAt: null,
          lastError: null,
          sendAfter: sql`NOW()`,
        })
        .where(
          and(
            eq(notificationEmailQueue.id, id),
            eq(notificationEmailQueue.status, "failed"),
          ),
        )
        .returning({ id: notificationEmailQueue.id }),
    );
    if (!claimed.length)
      return { error: "That message is no longer retryable." };

    after(() => triggerEmailWorker());
    revalidatePath("/dashboard/settings/notifications");
    return { success: true };
  } catch (error) {
    logError("retryFailedEmail failed", error, { id });
    return { error: "Could not retry that message." };
  }
}
