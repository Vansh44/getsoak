import "server-only";

/**
 * The merchant's own Razorpay webhook (CODEBASE §18).
 *
 * ★★ WHY IT EXISTS. A store's gateway had no webhook at all: a payment was
 * learned only when the shopper's success page ran reconcile-on-read, or when
 * the hourly reaper swept. Close the tab on the Razorpay screen and the money
 * is captured at Razorpay while the order sits `pending` for up to an hour —
 * the merchant sees nothing, the shopper is thanked for nothing, and the order
 * is a candidate for cancellation the whole time.
 *
 * ★ IT ADDS NO NEW WAY TO MARK AN ORDER PAID. The route resolves the order and
 * calls `markOrderPaid`, the same conditional pending → paid claim the callback,
 * the reconcile pass and the reaper use. So the webhook is a fourth TRIGGER for
 * one implementation, not a fourth implementation — and a replayed delivery
 * (Razorpay retries) claims zero rows and announces nothing.
 */

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storePaymentProviders } from "@/drizzle/schema";
import { decryptSecret, encryptSecret } from "@/lib/payments/crypto";
import { storeOrigin } from "@/lib/site";

/**
 * A fresh signing secret.
 *
 * Razorpay accepts an arbitrary string here — the merchant pastes the same
 * value into their webhook settings — so it is ours to choose. 32 random bytes,
 * base64url so it survives being copied out of a dashboard field.
 */
export function newPaymentWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The URL the merchant registers with Razorpay.
 *
 * ★ Store-scoped by id in the PATH, because each store has its own Razorpay
 * account and therefore its own secret — one shared endpoint could not know
 * which key to verify against. The id is a LOOKUP key and never authorisation:
 * the HMAC is, exactly as §14 says of every other identifier in this codebase.
 */
export function paymentWebhookUrl(store: {
  id: string;
  slug: string;
  custom_domain?: string | null;
  settings?: Record<string, unknown> | null;
  plan?: string | null;
}): string {
  // storeOrigin applies the verified-domain and plan gates, so the URL we hand
  // a merchant is one their store actually answers on.
  return `${storeOrigin(store as never)}/api/webhooks/payments/${store.id}`;
}

/** Store a new secret, replacing any previous one. Returns it for display ONCE. */
export async function rotatePaymentWebhookSecret(
  storeId: string,
): Promise<string | null> {
  const secret = newPaymentWebhookSecret();
  const updated = await withService((db) =>
    db
      .update(storePaymentProviders)
      .set({ webhookSecretEnc: encryptSecret(secret) })
      .where(
        and(
          eq(storePaymentProviders.storeId, storeId),
          eq(storePaymentProviders.provider, "razorpay"),
        ),
      )
      .returning({ storeId: storePaymentProviders.storeId }),
  );
  // No connected gateway ⇒ nothing to attach a webhook to. Creating the row
  // here would leave a provider with a webhook and no credentials.
  return updated.length > 0 ? secret : null;
}

/**
 * The plaintext secret for a store, or null.
 *
 * ★ Never returned to a caller outside this module's route — `getChannelState`
 * exposes only whether one is CONFIGURED, the same write-only treatment
 * `key_secret_enc` gets.
 */
export async function loadPaymentWebhookSecret(
  storeId: string,
): Promise<string | null> {
  try {
    const rows = await withService((db) =>
      db
        .select({ enc: storePaymentProviders.webhookSecretEnc })
        .from(storePaymentProviders)
        .where(
          and(
            eq(storePaymentProviders.storeId, storeId),
            eq(storePaymentProviders.provider, "razorpay"),
            // A paused gateway must not have its webhook honoured: the merchant
            // has deliberately stopped taking online payments, and an order
            // marked paid from a channel they switched off is a surprise.
            eq(storePaymentProviders.enabled, true),
          ),
        )
        .limit(1),
    );
    const enc = rows[0]?.enc;
    return enc ? decryptSecret(enc) : null;
  } catch {
    // A read failure must not be reported to the caller as "bad signature" —
    // the route turns null into a 503 so Razorpay RETRIES rather than giving up
    // on a delivery we simply could not check.
    return null;
  }
}

/** Whether a webhook has been set up, for display. Never the secret itself. */
export async function hasPaymentWebhook(storeId: string): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .select({ enc: storePaymentProviders.webhookSecretEnc })
      .from(storePaymentProviders)
      .where(
        and(
          eq(storePaymentProviders.storeId, storeId),
          eq(storePaymentProviders.provider, "razorpay"),
        ),
      )
      .limit(1),
  );
  return !!rows[0]?.enc;
}
