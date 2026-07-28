import "server-only";

// ---------------------------------------------------------------------------
// Resolving a notification's effective configuration.
//
// ══ THE MENTAL MODEL ══════════════════════════════════════════════════════
//
// One EVENT ("an order was placed") can notify TWO DIFFERENT AUDIENCES, and
// they have nothing in common but the trigger:
//
//   TEAM     — the merchant's staff. "New order ORD10010004 · ₹1,240 · from
//              Priya S." Who receives it is permission-derived and narrowable;
//              it lands in the dashboard bell and staff inboxes.
//   CUSTOMER — the shopper. "Order confirmed — we've received your order."
//              There is exactly one recipient (the person it happened to), it
//              lands in their storefront notification centre and their inbox,
//              and it is transactional: staff preferences must never govern it.
//
// So configuration is PER AUDIENCE. A merchant who turns off team email for
// "New order" has said nothing about the shopper's confirmation, and the data
// model has to make that impossible to get wrong — that used to be a bug, not
// a design (see the regression test in record.test.ts).
//
// ══ THE THREE LAYERS ══════════════════════════════════════════════════════
//
//   code registry  ←  platform definition  ←  store settings
//
// Same layering as lib/settings/registry.ts (convention #9): an empty database
// behaves exactly like the code defaults, so a brand-new store gets sensible
// notifications without a single row being written. Each layer has one owner:
//
//   registry    — engineering. What can be emitted, which audiences it reaches,
//                 and every default.
//   definition  — StoreMink operators. Renames, recategorisation, and rows
//                 registered ahead of the code that will fire them.
//   settings    — the merchant. Per audience: channels, copy, and (team only)
//                 recipients. Plus digest and on/off for the whole event.
// ---------------------------------------------------------------------------

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  notificationDefinitions,
  notificationSettings,
  stores,
} from "@/drizzle/schema";
import {
  getEventDef,
  type Digest,
  type EventDef,
  type EventKey,
} from "./events";
import {
  CHANNELS,
  getChannel,
  normalizeChannels,
  toPreferenceKey,
  type ChannelKey,
} from "./channels";
import { DEFAULT_ROUTING, normalizeRouting, type RoutingRule } from "./routing";

/**
 * The console's audience vocabulary. Maps onto the registry's `audiences`:
 * team = "store-admins", customer = "customer". (Platform "operators" events
 * are not merchant-configurable and never appear in a store's console.)
 */
export const AUDIENCE_KEYS = ["team", "customer"] as const;
export type AudienceKey = (typeof AUDIENCE_KEYS)[number];

export const AUDIENCE_LABEL: Record<AudienceKey, string> = {
  team: "Team",
  customer: "Customer",
};

export const AUDIENCE_DESCRIPTION: Record<AudienceKey, string> = {
  team: "Your staff, in the dashboard bell and their inbox.",
  customer: "The shopper this happened to, on your storefront and by email.",
};

export interface ChannelTemplate {
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
}

/** Everything a merchant configures for ONE audience of one notification. */
export interface AudienceConfig {
  /** Per-channel on/off for this audience. */
  channels: Record<ChannelKey, boolean>;
  /** Merchant copy per channel; absent = the built-in wording. */
  templates: Partial<Record<ChannelKey, ChannelTemplate>>;
  /** TEAM ONLY. A customer notification has exactly one recipient — the person
   *  it happened to — so there is nothing to route. */
  routing?: RoutingRule;
}

export interface ResolvedNotification {
  key: string;
  displayName: string;
  description: string;
  category: string;
  group: string;
  /** Dashboard section that gates which STAFF may receive it (permissions.ts).
   *  Irrelevant to the customer audience. */
  section: string;
  severity: string;
  /** Only the audiences this event actually reaches. An event with no customer
   *  audience simply has no `customer` key — the console renders what's here,
   *  so it can never offer a tab that leads nowhere. */
  audiences: Partial<Record<AudienceKey, AudienceConfig>>;
  digest: Digest;
  isEnabled: boolean;
  /** Registered by an operator but not emitted by any code path yet. */
  isCustom: boolean;
  /** False = the merchant may not switch this notification off. */
  configurable: boolean;
  /** True once the store has saved its own configuration for this event. */
  isConfigured: boolean;
  /** The store's display name, for {{store_name}} in a merchant template.
   *  Comes free with the settings read (joined), so a template never costs an
   *  extra query — and it is only ever needed when a settings row exists. */
  storeName: string | null;
}

/** Registry audience key → console audience key. */
const REGISTRY_AUDIENCE: Record<AudienceKey, "store-admins" | "customer"> = {
  team: "store-admins",
  customer: "customer",
};

/** Registry defaults, before any database row is applied. */
function fromRegistry(def: EventDef): ResolvedNotification {
  const audiences: Partial<Record<AudienceKey, AudienceConfig>> = {};

  for (const audience of AUDIENCE_KEYS) {
    const defaults = def.audiences[REGISTRY_AUDIENCE[audience]];
    if (!defaults) continue;

    const channels = {} as Record<ChannelKey, boolean>;
    for (const channel of CHANNELS) {
      if (!channel.available) {
        channels[channel.key] = false;
        continue;
      }
      const prefKey = toPreferenceKey(channel.key);
      channels[channel.key] =
        prefKey === "email"
          ? Boolean(defaults.email)
          : prefKey === "inApp"
            ? Boolean(defaults.inApp)
            : false;
    }

    audiences[audience] = {
      channels,
      templates: {},
      ...(audience === "team" ? { routing: DEFAULT_ROUTING } : {}),
    };
  }

  return {
    key: def.key,
    displayName: def.label,
    description: def.description,
    category: def.group,
    group: def.group,
    section: def.section,
    severity: def.severity,
    audiences,
    digest: "instant",
    isEnabled: true,
    isCustom: false,
    configurable: def.configurable !== false,
    isConfigured: false,
    storeName: null,
  };
}

type DefinitionRow = {
  key: string;
  displayName: string | null;
  description: string | null;
  category: string | null;
  group: string | null;
  channels: unknown;
  isActive: boolean;
  isCustom: boolean;
};

type SettingsRow = {
  eventKey: string;
  storeName: string | null;
  channels: unknown;
  routing: string;
  routingScope: string | null;
  targetRoles: string[];
  targetAdmins: string[];
  templates: unknown;
  digest: string;
  isEnabled: boolean;
};

function applyDefinition(
  base: ResolvedNotification,
  row: DefinitionRow | undefined,
): ResolvedNotification {
  if (!row) return base;

  // A platform-level channel switch applies to every audience the event has —
  // an operator turning a channel off means "this platform can't do that",
  // which is true regardless of who was going to receive it.
  const override = normalizeChannels(row.channels);
  const audiences = { ...base.audiences };
  for (const audience of AUDIENCE_KEYS) {
    const config = audiences[audience];
    if (!config) continue;
    audiences[audience] = {
      ...config,
      channels: { ...config.channels, ...override },
    };
  }

  return {
    ...base,
    displayName: row.displayName?.trim() || base.displayName,
    description: row.description?.trim() || base.description,
    category: row.category?.trim() || base.category,
    group: row.group?.trim() || base.group,
    audiences,
    isCustom: row.isCustom,
  };
}

function normalizeTemplateMap(
  value: unknown,
): Partial<Record<ChannelKey, ChannelTemplate>> {
  const out: Partial<Record<ChannelKey, ChannelTemplate>> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!getChannel(key)) continue;
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const entry: ChannelTemplate = {};
    for (const field of ["subject", "body", "cc", "bcc"] as const) {
      if (typeof t[field] === "string") entry[field] = t[field] as string;
    }
    if (Object.keys(entry).length > 0) out[key as ChannelKey] = entry;
  }
  return out;
}

/**
 * Read a per-audience map out of a stored jsonb column.
 *
 * Accepts the LEGACY FLAT SHAPE too ({"email": true} rather than
 * {"team": {"email": true}}) and reads it as the team's config: that's what it
 * always meant before audiences became first-class, and a store that saved
 * settings under the old shape shouldn't silently lose them.
 */
function readAudienceMap<T>(
  value: unknown,
  read: (raw: unknown) => T,
  isEmpty: (parsed: T) => boolean,
): Partial<Record<AudienceKey, T>> {
  const out: Partial<Record<AudienceKey, T>> = {};
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;

  const hasAudienceKeys = AUDIENCE_KEYS.some((a) => a in record);
  if (!hasAudienceKeys) {
    const legacy = read(record);
    if (!isEmpty(legacy)) out.team = legacy;
    return out;
  }

  for (const audience of AUDIENCE_KEYS) {
    if (!(audience in record)) continue;
    out[audience] = read(record[audience]);
  }
  return out;
}

function applySettings(
  base: ResolvedNotification,
  row: SettingsRow | undefined,
): ResolvedNotification {
  if (!row) return base;

  const storedChannels = readAudienceMap(
    row.channels,
    normalizeChannels,
    (parsed) => Object.keys(parsed).length === 0,
  );
  const storedTemplates = readAudienceMap(
    row.templates,
    normalizeTemplateMap,
    (parsed) => Object.keys(parsed).length === 0,
  );
  const routing = normalizeRouting({
    routing: row.routing,
    routing_scope: row.routingScope,
    target_roles: row.targetRoles,
    target_admins: row.targetAdmins,
  });

  const audiences = { ...base.audiences };
  for (const audience of AUDIENCE_KEYS) {
    const config = audiences[audience];
    // A stored config for an audience the event no longer has is ignored, not
    // resurrected — the registry decides who an event can reach.
    if (!config) continue;
    audiences[audience] = {
      channels: { ...config.channels, ...(storedChannels[audience] ?? {}) },
      templates: storedTemplates[audience] ?? {},
      ...(audience === "team" ? { routing } : {}),
    };
  }

  return {
    ...base,
    audiences,
    digest: (["instant", "hourly", "daily"] as const).includes(
      row.digest as Digest,
    )
      ? (row.digest as Digest)
      : base.digest,
    // A non-configurable notification cannot be switched off, whatever the
    // row says — the registry flag wins (role changes, failed billing).
    isEnabled: base.configurable ? row.isEnabled : true,
    isConfigured: true,
    storeName: row.storeName ?? base.storeName,
  };
}

const DEFINITION_COLUMNS = {
  key: notificationDefinitions.key,
  displayName: notificationDefinitions.displayName,
  description: notificationDefinitions.description,
  category: notificationDefinitions.category,
  group: notificationDefinitions.group,
  channels: notificationDefinitions.channels,
  isActive: notificationDefinitions.isActive,
  isCustom: notificationDefinitions.isCustom,
};

const SETTINGS_COLUMNS = {
  eventKey: notificationSettings.eventKey,
  storeName: stores.name,
  channels: notificationSettings.channels,
  routing: notificationSettings.routing,
  routingScope: notificationSettings.routingScope,
  targetRoles: notificationSettings.targetRoles,
  targetAdmins: notificationSettings.targetAdmins,
  templates: notificationSettings.templates,
  digest: notificationSettings.digest,
  isEnabled: notificationSettings.isEnabled,
};

/**
 * One event's effective configuration for one store. Used on the fan-out path,
 * so it stays to two indexed single-row reads.
 */
export async function resolveNotification(
  db: Db,
  storeId: string | null,
  key: EventKey | string,
): Promise<ResolvedNotification | null> {
  const def = getEventDef(key);
  if (!def) return null;
  let resolved = fromRegistry(def);

  // Sequential: one pooled connection per scoped transaction serves one query
  // at a time (see the note in order-actions.ts).
  const definitionRows = await db
    .select(DEFINITION_COLUMNS)
    .from(notificationDefinitions)
    .where(eq(notificationDefinitions.key, def.key))
    .limit(1);
  const definition = definitionRows[0] as DefinitionRow | undefined;
  // An operator can retire a notification platform-wide.
  if (definition && !definition.isActive) return null;
  resolved = applyDefinition(resolved, definition);

  if (!storeId) return resolved;

  const settingRows = await db
    .select(SETTINGS_COLUMNS)
    .from(notificationSettings)
    .innerJoin(stores, eq(stores.id, notificationSettings.storeId))
    .where(
      and(
        eq(notificationSettings.storeId, storeId),
        eq(notificationSettings.eventKey, def.key),
      ),
    )
    .limit(1);

  return applySettings(resolved, settingRows[0] as SettingsRow | undefined);
}

/**
 * Every notification, resolved for one store — the console's list. Two queries
 * total regardless of how many notifications exist.
 */
export async function resolveAllNotifications(
  db: Db,
  storeId: string | null,
  defs: readonly EventDef[],
): Promise<ResolvedNotification[]> {
  const keys = defs.map((d) => d.key);
  if (keys.length === 0) return [];

  const definitionRows = (await db
    .select(DEFINITION_COLUMNS)
    .from(notificationDefinitions)
    .where(inArray(notificationDefinitions.key, keys))) as DefinitionRow[];
  const definitions = new Map(definitionRows.map((r) => [r.key, r]));

  const settingRows = storeId
    ? ((await db
        .select(SETTINGS_COLUMNS)
        .from(notificationSettings)
        .innerJoin(stores, eq(stores.id, notificationSettings.storeId))
        .where(
          and(
            eq(notificationSettings.storeId, storeId),
            inArray(notificationSettings.eventKey, keys),
          ),
        )) as SettingsRow[])
    : [];
  const settings = new Map(settingRows.map((r) => [r.eventKey, r]));

  const out: ResolvedNotification[] = [];
  for (const def of defs) {
    const definition = definitions.get(def.key);
    if (definition && !definition.isActive) continue;
    out.push(
      applySettings(
        applyDefinition(fromRegistry(def), definition),
        settings.get(def.key),
      ),
    );
  }
  return out;
}
