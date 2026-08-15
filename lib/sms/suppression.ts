import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// STOP — the opt-out list.
//
// ── ★★ PER STORE, NOT GLOBAL — the opposite of email suppression ───────────
// `email_suppressions` (§24) is deliberately global: a hard bounce bounces for
// everyone, and the sending domain's reputation is the PLATFORM's. An SMS
// opt-out is the reverse on both counts. It is a statement of consent to ONE
// business ("stop texting me about my grocery order"), it says nothing about
// whether the number works, and the sender header is the MERCHANT's registered
// identity rather than a shared one. Making it global would let one shopper's
// STOP to one shop silence every other shop they buy from.
//
// ── ★ NOT OPTIONAL ─────────────────────────────────────────────────────────
// Honouring STOP is a carrier and regulatory requirement, not a courtesy. It is
// also the one part of this system where getting it wrong is visible to a
// regulator rather than to a merchant.
// ---------------------------------------------------------------------------

/** The words carriers and customers actually use. */
const STOP_WORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "optout",
  "opt-out",
]);

const START_WORDS = new Set([
  "start",
  "unstop",
  "subscribe",
  "optin",
  "opt-in",
]);

export type InboundIntent = "stop" | "start" | "other";

/**
 * What did an inbound message mean?
 *
 * PURE, so the vocabulary can be tested without a provider. Deliberately
 * generous about surrounding whitespace and case, and deliberately NOT generous
 * about extra words: "stop sending so many" is a complaint, but "please stop"
 * is an opt-out, so a single leading/trailing courtesy word is tolerated and a
 * sentence is not. When in doubt it returns `other` — a missed opt-out is
 * recoverable by a human reading the log; a wrongly-inferred one silently ends
 * a customer's order updates.
 */
export function classifyInbound(body: string): InboundIntent {
  const words = (body ?? "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 2) return "other";
  for (const w of words) {
    if (STOP_WORDS.has(w)) return "stop";
    if (START_WORDS.has(w)) return "start";
  }
  return "other";
}

/** Ten digits, however the number arrived — so a match is not defeated by +91. */
export function suppressionKey(phone: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/**
 * Has this number opted out of this store's messages?
 *
 * ★ FAILS OPEN, unlike most checks here. A database blip must not stop a
 * merchant's order confirmations — and the alternative reading, "we could not
 * check, so assume they opted out", would silently stop every message for as
 * long as the outage lasts. The email suppression check makes the same choice
 * for the same reason.
 */
export async function isSuppressed(
  storeId: string,
  phone: string,
): Promise<boolean> {
  const key = suppressionKey(phone);
  if (!key) return false;
  try {
    const rows = await withService((db) =>
      db.execute(sql`
        select 1 from public.sms_suppressions
         where store_id = ${storeId}::uuid and phone = ${key}
         limit 1
      `),
    );
    return asRows(rows).length > 0;
  } catch (err) {
    logError("sms: suppression check failed", err, { storeId });
    return false;
  }
}

/** Record an opt-out. Idempotent — a second STOP is not an error. */
export async function suppressPhone(
  storeId: string,
  phone: string,
  reason = "stop",
): Promise<void> {
  const key = suppressionKey(phone);
  if (!key) return;
  try {
    await withService((db) =>
      db.execute(sql`
        insert into public.sms_suppressions (store_id, phone, reason)
        values (${storeId}::uuid, ${key}, ${reason})
        on conflict (store_id, phone) do nothing
      `),
    );
  } catch (err) {
    // ⚠ Loud. A failed opt-out means we keep texting someone who asked us to
    // stop, which is the one failure here a regulator cares about.
    logError("sms: could not record opt-out", err, { storeId });
  }
}

/** Undo an opt-out, for START. */
export async function unsuppressPhone(
  storeId: string,
  phone: string,
): Promise<void> {
  const key = suppressionKey(phone);
  if (!key) return;
  try {
    await withService((db) =>
      db.execute(sql`
        delete from public.sms_suppressions
         where store_id = ${storeId}::uuid and phone = ${key}
      `),
    );
  } catch (err) {
    logError("sms: could not clear opt-out", err, { storeId });
  }
}

function asRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return ((result as { rows?: unknown[] })?.rows ?? []) as unknown[];
}
