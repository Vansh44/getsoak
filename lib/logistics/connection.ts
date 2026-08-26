import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, type SQL } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { storeLogisticsProviders } from "@/drizzle/schema";
import { decryptSecret, encryptSecret } from "@/lib/payments/crypto";
import { PLATFORM_URL } from "@/lib/store/host";
import { shiprocketLogin } from "./shiprocket";
import {
  PlanEntitlementError,
  storeAllowsPlanFeature,
} from "@/lib/plans/entitlements";

export interface ShiprocketConnectionSession {
  id: string;
  storeId: string;
  email: string;
  token: string;
  enabled: boolean;
}

export function newWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function verifyWebhookSecret(
  secret: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashWebhookSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function shiprocketWebhookUrl(connectionId: string): string {
  // Shiprocket rejects callback addresses containing provider keywords such as
  // "shiprocket", "kartrocket", "sr", or "kr". Keep the public route
  // provider-neutral even though the connection itself is provider-specific.
  return `${PLATFORM_URL}/api/webhooks/logistics/${encodeURIComponent(connectionId)}`;
}

type ConnectionRow = {
  id: string;
  store_id: string;
  account_email: string | null;
  credential_secret_enc: string | null;
  token_enc: string | null;
  token_expires_at: string | null;
  webhook_secret_hash: string | null;
  enabled: boolean;
};

async function rowBy(
  condition: SQL<unknown>,
): Promise<ConnectionRow | undefined> {
  const rows = await withService((db) =>
    db
      .select({
        id: storeLogisticsProviders.id,
        store_id: storeLogisticsProviders.storeId,
        account_email: storeLogisticsProviders.accountEmail,
        credential_secret_enc: storeLogisticsProviders.credentialSecretEnc,
        token_enc: storeLogisticsProviders.tokenEnc,
        token_expires_at: storeLogisticsProviders.tokenExpiresAt,
        webhook_secret_hash: storeLogisticsProviders.webhookSecretHash,
        enabled: storeLogisticsProviders.enabled,
      })
      .from(storeLogisticsProviders)
      .where(condition)
      .limit(1),
  );
  return rows[0];
}

export async function shiprocketConnectionForStore(storeId: string) {
  return rowBy(
    and(
      eq(storeLogisticsProviders.storeId, storeId),
      eq(storeLogisticsProviders.provider, "shiprocket"),
    )!,
  );
}

export async function shiprocketConnectionById(connectionId: string) {
  return rowBy(
    and(
      eq(storeLogisticsProviders.id, connectionId),
      eq(storeLogisticsProviders.provider, "shiprocket"),
    )!,
  );
}

async function sessionForRow(
  row: ConnectionRow | undefined,
  requireEnabled: boolean,
): Promise<ShiprocketConnectionSession> {
  if (!row?.account_email || !row.credential_secret_enc) {
    throw new Error("Connect Shiprocket in Channels first.");
  }
  if (requireEnabled && !row.enabled) {
    throw new Error("Shiprocket is paused in Channels.");
  }

  const expires = row.token_expires_at
    ? new Date(row.token_expires_at).getTime()
    : 0;
  if (row.token_enc && expires > Date.now() + 5 * 60_000) {
    return {
      id: row.id,
      storeId: row.store_id,
      email: row.account_email,
      token: decryptSecret(row.token_enc),
      enabled: row.enabled,
    };
  }

  const session = await shiprocketLogin(
    row.account_email,
    decryptSecret(row.credential_secret_enc),
  );
  await withService((db) =>
    db
      .update(storeLogisticsProviders)
      .set({
        tokenEnc: encryptSecret(session.token),
        tokenExpiresAt: session.expiresAt.toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(storeLogisticsProviders.id, row.id)),
  );
  return {
    id: row.id,
    storeId: row.store_id,
    email: row.account_email,
    token: session.token,
    enabled: row.enabled,
  };
}

export async function getShiprocketSessionForStore(
  storeId: string,
  requireEnabled = true,
) {
  if (!(await storeAllowsPlanFeature(storeId, "shippingIntegration"))) {
    throw new PlanEntitlementError(
      "Shiprocket is available on Basic and Pro. Your connection and shipment history remain safe until you upgrade.",
    );
  }
  return sessionForRow(
    await shiprocketConnectionForStore(storeId),
    requireEnabled,
  );
}

export async function getShiprocketSessionById(
  connectionId: string,
  requireEnabled = true,
) {
  return sessionForRow(
    await shiprocketConnectionById(connectionId),
    requireEnabled,
  );
}
