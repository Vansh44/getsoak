import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { decryptSecret } from "@/lib/payments/crypto";
import {
  admins,
  storeSmsProviders,
  storeSmsTemplates,
  users,
} from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import type { TwilioCreds } from "./twilio";

// ---------------------------------------------------------------------------
// Can this store send THIS notification by SMS, and with what?
//
// ── ★★ THREE CONDITIONS, AND ALL OF THEM ARE PER-STORE ─────────────────────
//   1. a CONNECTED and ENABLED provider — the merchant's own Twilio account,
//   2. the merchant's channel switch for that event and audience,
//   3. a DLT TEMPLATE mirrored for that event and audience.
//
// (3) is the one email has no counterpart for, and it is not a formality. A
// message whose body does not match a template the merchant registered with
// their operator is dropped at the carrier — silently, with no bounce. So the
// EXISTENCE OF AN APPROVED TEMPLATE IS THE REAL SWITCH: a merchant who went
// through DLT registration for "order.placed" has stated their intent about as
// unambiguously as anyone can.
//
// ── ★ WHY `sms` IS NOT A FIELD ON THE EVENT REGISTRY ───────────────────────
// `EventDef.audiences[x]` carries `{inApp, email}` and deliberately gains no
// `sms`. There is no defensible platform DEFAULT for it: ON would queue
// messages that every carrier blocks (no template), and OFF would make the
// field pure noise on all 38 events. The merchant's own switch plus their own
// template answer it better than a default could.
// ---------------------------------------------------------------------------

export interface SmsSender {
  creds: TwilioCreds;
  senderHeader: string;
  dltEntityId: string;
}

/**
 * The store's sender, or null when it cannot send.
 *
 * Null covers three different situations on purpose — never connected, paused
 * by the merchant, or a decrypt that failed — because the CALLER's response to
 * all three is identical: don't queue an SMS. The distinction that matters is
 * logged, not returned.
 */
export async function loadSmsSender(
  db: Db,
  storeId: string,
): Promise<SmsSender | null> {
  try {
    const rows = await db
      .select({
        accountSid: storeSmsProviders.accountSid,
        authTokenEnc: storeSmsProviders.authTokenEnc,
        senderHeader: storeSmsProviders.senderHeader,
        dltEntityId: storeSmsProviders.dltEntityId,
        enabled: storeSmsProviders.enabled,
      })
      .from(storeSmsProviders)
      .where(eq(storeSmsProviders.storeId, storeId))
      .limit(1);

    const row = rows[0];
    if (!row || !row.enabled) return null;

    return {
      creds: {
        accountSid: row.accountSid,
        authToken: decryptSecret(row.authTokenEnc),
      },
      senderHeader: row.senderHeader,
      dltEntityId: row.dltEntityId,
    };
  } catch (err) {
    // A decrypt failure means PAYMENT_CRED_KEY rotated without re-encrypting —
    // worth an error line, because every SMS for this store stops until it is
    // fixed and nothing else would say so.
    logError("sms: sender load failed", err, { storeId });
    return null;
  }
}

export interface SmsTemplateRow {
  audience: string;
  dltTemplateId: string;
  body: string;
  variables: string[];
}

/**
 * The store's mirrored templates for one event, keyed by audience.
 *
 * Disabled rows are excluded here rather than at the send: a merchant turning a
 * template off means "stop sending this", and the cheapest place to honour that
 * is before anything is queued.
 */
export async function loadSmsTemplates(
  db: Db,
  storeId: string,
  eventKey: string,
): Promise<Map<string, SmsTemplateRow>> {
  const out = new Map<string, SmsTemplateRow>();
  try {
    const rows = await db
      .select({
        audience: storeSmsTemplates.audience,
        dltTemplateId: storeSmsTemplates.dltTemplateId,
        body: storeSmsTemplates.body,
        variables: storeSmsTemplates.variables,
        enabled: storeSmsTemplates.enabled,
      })
      .from(storeSmsTemplates)
      .where(
        and(
          eq(storeSmsTemplates.storeId, storeId),
          eq(storeSmsTemplates.eventKey, eventKey),
          eq(storeSmsTemplates.enabled, true),
        ),
      );

    for (const r of rows) {
      out.set(r.audience, {
        audience: r.audience,
        dltTemplateId: r.dltTemplateId,
        body: r.body,
        variables: Array.isArray(r.variables) ? (r.variables as string[]) : [],
      });
    }
  } catch (err) {
    logError("sms: template load failed", err, { storeId, eventKey });
  }
  return out;
}

/**
 * A recipient's phone number, from the table their type lives in.
 *
 * ★ BOTH AUDIENCES ARE REACHABLE, but not equally: `users.phone` is NOT NULL,
 * while `admins.phone` is nullable and mostly empty — nothing in the signup or
 * invite flow requires a staff phone. So a team SMS silently reaches nobody for
 * most stores, which is why the console says so next to the switch rather than
 * letting a merchant configure a channel with no addresses behind it.
 */
export async function phonesForRecipients(
  db: Db,
  recipients: { id: string; type: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const customerIds = recipients
    .filter((r) => r.type === "customer")
    .map((r) => r.id);
  const adminIds = recipients
    .filter((r) => r.type === "admin")
    .map((r) => r.id);

  // Batched by type — one query each, not one per recipient. The fan-out runs
  // on every event, so a per-recipient lookup here is a cost every store pays.
  try {
    if (customerIds.length) {
      const rows = await db
        .select({ id: users.id, phone: users.phone })
        .from(users)
        .where(inArray(users.id, customerIds));
      for (const r of rows) if (r.phone) out.set(r.id, r.phone);
    }
    if (adminIds.length) {
      const rows = await db
        .select({ id: admins.id, phone: admins.phone })
        .from(admins)
        .where(inArray(admins.id, adminIds));
      for (const r of rows) if (r.phone) out.set(r.id, r.phone);
    }
  } catch (err) {
    // A lookup failure costs the SMS, never the notification — the in-app row
    // and the email have already been decided by this point.
    logError("sms: phone lookup failed", err);
  }
  return out;
}

/**
 * Can this store send SMS at all — a connected, enabled, verified provider?
 *
 * Distinct from `loadSmsSender`: that one decrypts a credential for a send, and
 * this one only answers a yes/no for a settings gate, so it never touches the
 * ciphertext. Own transaction, because its caller is a server action rather
 * than the fan-out.
 */
export async function storeCanSendSms(storeId: string): Promise<boolean> {
  try {
    const { withService } = await import("@/lib/db/client");
    const rows = await withService((db) =>
      db
        .select({ enabled: storeSmsProviders.enabled })
        .from(storeSmsProviders)
        .where(eq(storeSmsProviders.storeId, storeId))
        .limit(1),
    );
    return rows[0]?.enabled === true;
  } catch (err) {
    // ★ FAILS CLOSED, unlike the suppression check. The cost of a false "no"
    // here is a merchant retrying a settings save; the cost of a false "yes"
    // is a switch that looks on and silently sends nothing, which is the exact
    // state this guard exists to prevent.
    logError("sms: connection check failed", err, { storeId });
    return false;
  }
}
