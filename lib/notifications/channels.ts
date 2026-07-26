// ---------------------------------------------------------------------------
// Delivery channels — the console's vocabulary, in one place.
//
// Two of these actually deliver today. The rest are declared here (and rendered
// in the console) as LOCKED: a merchant can see the platform intends to support
// them, but there is no toggle that silently does nothing. `available: false`
// is enforced server-side on save, not just greyed out in the UI — a channel
// with no provider must never accept a "yes" it can't honour.
//
// `web` is the in-app bell. Internally the preference resolver calls that
// channel `inApp` (it predates the console); toChannelKey/toPreferenceKey are
// the only places the two names meet.
// ---------------------------------------------------------------------------

export const CHANNEL_KEYS = [
  "email",
  "web",
  "sms",
  "push",
  "whatsapp",
] as const;

export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export interface ChannelDef {
  key: ChannelKey;
  label: string;
  /** False = configurable in the UI but not deliverable; saves are rejected. */
  available: boolean;
  /** Shown in the console where a channel is locked. */
  note?: string;
}

export const CHANNELS: readonly ChannelDef[] = [
  {
    key: "email",
    label: "Email",
    available: true,
  },
  {
    key: "web",
    label: "Web",
    available: true,
    note: "The notification bell in the dashboard.",
  },
  {
    key: "sms",
    label: "SMS",
    available: false,
    note: "No SMS provider is connected yet.",
  },
  {
    key: "push",
    label: "Push",
    available: false,
    note: "Push notifications aren't set up yet.",
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    available: false,
    note: "WhatsApp Business isn't connected yet.",
  },
];

const CHANNEL_BY_KEY = new Map(CHANNELS.map((c) => [c.key, c]));

export function getChannel(key: string): ChannelDef | undefined {
  return CHANNEL_BY_KEY.get(key as ChannelKey);
}

export function isChannelKey(key: unknown): key is ChannelKey {
  return typeof key === "string" && CHANNEL_BY_KEY.has(key as ChannelKey);
}

/** Channels that can actually be delivered right now. */
export function availableChannels(): ChannelDef[] {
  return CHANNELS.filter((c) => c.available);
}

/** Console channel → the key the preference resolver uses. */
export function toPreferenceKey(key: ChannelKey): "email" | "inApp" | null {
  if (key === "email") return "email";
  if (key === "web") return "inApp";
  return null;
}

/** A store's stored `channels` jsonb, normalised. Unknown keys are dropped and
 *  unavailable channels are forced off, so junk (or a stale row from before a
 *  provider was removed) can never turn into a delivery attempt. */
export function normalizeChannels(
  value: unknown,
): Partial<Record<ChannelKey, boolean>> {
  const out: Partial<Record<ChannelKey, boolean>> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, on] of Object.entries(value as Record<string, unknown>)) {
    if (!isChannelKey(key)) continue;
    if (typeof on !== "boolean") continue;
    if (!getChannel(key)?.available) {
      out[key] = false;
      continue;
    }
    out[key] = on;
  }
  return out;
}
