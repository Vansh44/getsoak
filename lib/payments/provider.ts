import "server-only";

import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storePaymentProviders } from "@/drizzle/schema";
import { decryptSecret } from "./crypto";
import { logError } from "@/lib/observability/logger";
import type { RazorpayCreds } from "./razorpay";

// Loaders for payment credentials. Two entirely separate accounts:
//   • a STORE's BYO Razorpay gateway (store_payment_providers — order money
//     settles with the merchant), and
//   • the PLATFORM's own Razorpay account (env — AI-credit purchases only).
// Neither ever reaches a client component; secrets stay server-side.

export interface StoreGateway {
  creds: RazorpayCreds;
  enabled: boolean;
}

/** The store's decrypted BYO Razorpay credentials, or null when not
 *  connected (or the stored secret fails to decrypt). */
export async function getStoreGateway(
  storeId: string,
): Promise<StoreGateway | null> {
  let data:
    | { key_id: string; key_secret_enc: string; enabled: boolean }
    | undefined;
  try {
    const rows = await withService((db) =>
      db
        .select({
          key_id: storePaymentProviders.keyId,
          key_secret_enc: storePaymentProviders.keySecretEnc,
          enabled: storePaymentProviders.enabled,
        })
        .from(storePaymentProviders)
        .where(
          and(
            eq(storePaymentProviders.storeId, storeId),
            eq(storePaymentProviders.provider, "razorpay"),
          ),
        )
        .limit(1),
    );
    data = rows[0];
  } catch (err) {
    // ★ Structured, not console.error. Both failures here silently revert a
    // store to COD — the merchant sees online payments stop working with no
    // error anywhere — so they are exactly what should reach Cloud Error
    // Reporting. logError normalises a non-Error itself, so the raw value goes
    // straight in.
    logError("payments.gateway_load", err, { storeId });
    return null;
  }
  if (!data) return null;
  try {
    return {
      creds: {
        keyId: data.key_id,
        keySecret: decryptSecret(data.key_secret_enc),
      },
      enabled: !!data.enabled,
    };
  } catch (err) {
    // Wrong/rotated PAYMENT_CRED_KEY or corrupt row — treat as not connected
    // rather than crashing checkout. This is the one an operator most needs
    // alerting on: nothing else in the system will ever mention it.
    logError("payments.gateway_decrypt", err, { storeId });
    return null;
  }
}

/** The platform's own Razorpay account (AI-credit purchases). Null until the
 *  RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env vars are set. */
export function getPlatformRazorpayCreds(): RazorpayCreds | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}
