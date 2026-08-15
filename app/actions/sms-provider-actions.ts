"use server";

// ---------------------------------------------------------------------------
// Connecting a store's OWN SMS account (Channels → SMS). CODEBASE §37.
//
// The `payment-provider-actions.ts` shape, because it is the same problem: BYO
// credentials that must be verified before they are stored, encrypted at rest,
// and never returned to any caller.
//
// ── ★★ WHY BYO AND NOT PLATFORM-WIDE LIKE EMAIL ────────────────────────────
// TRAI requires the merchant to register a Principal Entity, a 6-character
// sender header and every template on an operator DLT portal. The header IS
// their registered identity, so StoreMink cannot send under it from a shared
// account — and a message that does not match an approved template is blocked
// at the carrier with no bounce and no useful error.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { encryptSecret } from "@/lib/payments/crypto";
import { storeSmsProviders } from "@/drizzle/schema";
import { normalizeSenderHeader } from "@/lib/sms/dlt";
import { twilioVerifyCreds } from "@/lib/sms/twilio";

export interface SmsChannelState {
  connected: boolean;
  enabled: boolean;
  /** Public-ish — it is in every Twilio dashboard URL — so it is shown back so
   *  the merchant can confirm WHICH account is wired up. */
  accountSid: string | null;
  senderHeader: string | null;
  dltEntityId: string | null;
  verifiedAt: string | null;
}

export interface SmsActionResult {
  success?: boolean;
  error?: string;
}

const EMPTY: SmsChannelState = {
  connected: false,
  enabled: false,
  accountSid: null,
  senderHeader: null,
  dltEntityId: null,
  verifiedAt: null,
};

/**
 * What the Channels card renders.
 *
 * ★ THE AUTH TOKEN IS NEVER IN HERE. It is write-only by design — no action
 * returns it, and the card shows "connected" rather than a masked value,
 * because a masked value invites someone to try to read it.
 */
export async function getSmsChannelState(): Promise<SmsChannelState> {
  const userId = await getManagerUserId("channels");
  if (!userId) return EMPTY;

  const storeId = await getActingStoreId();
  try {
    const rows = await withService((db) =>
      db
        .select({
          accountSid: storeSmsProviders.accountSid,
          senderHeader: storeSmsProviders.senderHeader,
          dltEntityId: storeSmsProviders.dltEntityId,
          enabled: storeSmsProviders.enabled,
          verifiedAt: storeSmsProviders.verifiedAt,
        })
        .from(storeSmsProviders)
        .where(eq(storeSmsProviders.storeId, storeId))
        .limit(1),
    );
    const row = rows[0];
    if (!row) return EMPTY;
    return {
      connected: true,
      enabled: row.enabled,
      accountSid: row.accountSid,
      senderHeader: row.senderHeader,
      dltEntityId: row.dltEntityId,
      verifiedAt: row.verifiedAt ?? null,
    };
  } catch {
    // ⚠ KNOWN GAP. access.ts's rule is that a DB error must never become a
    // state decision — getViewerContext returns `dbError` so the layout can
    // show an outage rather than "no access". This cannot do that yet, because
    // SmsChannelState has no third state, so an unreachable database reads as
    // "not connected" and invites the merchant to re-enter a DLT registration
    // that is already stored. Fixing it means an `unavailable` flag here and a
    // branch in the card. Pinned by a test so it stays visible.
    return EMPTY;
  }
}

/**
 * Verify and store a store's Twilio credentials plus its DLT registration.
 *
 * ★ VERIFIED BEFORE STORED. A typo'd token must fail HERE, in front of the
 * person who typed it — not silently, six hours later, on a customer's order
 * confirmation that never arrives.
 */
export async function saveSmsCredentials(input: {
  accountSid: string;
  authToken: string;
  senderHeader: string;
  dltEntityId: string;
}): Promise<SmsActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };

  const accountSid = (input.accountSid ?? "").trim();
  const authToken = (input.authToken ?? "").trim();
  const dltEntityId = (input.dltEntityId ?? "").trim();

  // A cheap shape check before spending an API call on obviously wrong input.
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    return { error: "That doesn't look like a Twilio Account SID (AC…)." };
  }
  if (authToken.length < 16 || authToken.length > 200) {
    return { error: "That doesn't look like a Twilio Auth Token." };
  }

  // ★ THE DLT FIELDS ARE REQUIRED, NOT OPTIONAL EXTRAS. Storing a connection
  // without them produces a channel that looks connected and delivers nothing
  // to an Indian handset — the carrier drops it silently.
  const senderHeader = normalizeSenderHeader(input.senderHeader);
  if (!senderHeader) {
    return {
      error:
        "A DLT sender header is exactly six letters, no digits — that's the transactional form (a numeric header is promotional).",
    };
  }
  if (!dltEntityId) {
    return {
      error:
        "Your DLT Principal Entity ID is required. Without it, carriers in India drop the message and you get no error back.",
    };
  }

  const check = await twilioVerifyCreds({ accountSid, authToken });
  if (!check.ok) return { error: check.error };

  // Resolved only after every gate and validation has passed, so a rejected
  // save never costs a lookup.
  const storeId = await getActingStoreId();

  const fields = {
    provider: "twilio",
    accountSid,
    authTokenEnc: encryptSecret(authToken),
    senderHeader,
    dltEntityId,
    // Pasting working credentials IS the statement of intent, so connecting
    // (or re-keying) enables the channel — same as the gateway.
    enabled: true,
    verifiedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await withService((db) =>
      db
        .insert(storeSmsProviders)
        .values({ storeId, ...fields })
        .onConflictDoUpdate({ target: storeSmsProviders.storeId, set: fields }),
    );
  } catch (err) {
    console.error(
      "saveSmsCredentials:",
      err instanceof Error ? err.message : err,
    );
    return { error: "Failed to save. Please try again." };
  }

  revalidatePath("/dashboard/channels");
  return { success: true };
}

/**
 * Pause or resume, WITHOUT discarding the credentials.
 *
 * A merchant who has hit their Twilio balance wants to stop sending, not to
 * re-enter a DLT registration they cannot retype from memory.
 */
export async function setSmsEnabled(
  enabled: boolean,
): Promise<SmsActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  try {
    await withService((db) =>
      db
        .update(storeSmsProviders)
        .set({ enabled, updatedAt: new Date().toISOString() })
        .where(eq(storeSmsProviders.storeId, storeId)),
    );
  } catch {
    return { error: "Couldn't update the SMS channel. Please try again." };
  }
  revalidatePath("/dashboard/channels");
  return { success: true };
}

/**
 * Forget the connection entirely.
 *
 * ⚠ This DOES discard the DLT registration fields, which the merchant cannot
 * retype from memory — the header and entity id live on the operator's portal.
 * The UI says so before it calls this.
 */
export async function disconnectSms(): Promise<SmsActionResult> {
  const userId = await getManagerUserId("channels");
  if (!userId) return { error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  try {
    await withService((db) =>
      db
        .delete(storeSmsProviders)
        .where(eq(storeSmsProviders.storeId, storeId)),
    );
  } catch {
    return { error: "Couldn't disconnect. Please try again." };
  }
  revalidatePath("/dashboard/channels");
  return { success: true };
}
