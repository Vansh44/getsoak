"use server";

import { and, eq } from "drizzle-orm";
import {
  admins,
  locationLogisticsMappings,
  storeBillingSettings,
  storeLocations,
  storeLogisticsProviders,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { encryptSecret } from "@/lib/payments/crypto";
import {
  hashWebhookSecret,
  newWebhookSecret,
  shiprocketWebhookUrl,
} from "@/lib/logistics/connection";
import {
  addShiprocketPickup,
  ShiprocketError,
  shiprocketLogin,
} from "@/lib/logistics/shiprocket";
import { getShiprocketSessionForStore } from "@/lib/logistics/connection";
import {
  getActingStoreId,
  getManagerIdentity,
  getViewerContext,
} from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import {
  isLocationType,
  locationCan,
  normalizeCapabilities,
} from "@/lib/locations/capabilities";

export interface ShiprocketChannelState {
  connected: boolean;
  enabled: boolean;
  accountEmail: string | null;
  connectionId: string | null;
  webhookUrl: string | null;
  mappedLocations: number;
  eligibleLocations: number;
}

export interface LogisticsActionResult {
  success?: boolean;
  error?: string;
  webhookSecret?: string;
  webhookUrl?: string;
  synced?: number;
  skipped?: Array<{ location: string; reason: string }>;
}

async function mayManageChannels() {
  return (await getManagerIdentity("channels")) !== null;
}

export async function getShiprocketChannelState(): Promise<ShiprocketChannelState> {
  const viewer = await getViewerContext();
  if (
    !viewer?.profile ||
    !can(viewer.permissions, "channels", "view", viewer.isSuperadmin)
  ) {
    return {
      connected: false,
      enabled: false,
      accountEmail: null,
      connectionId: null,
      webhookUrl: null,
      mappedLocations: 0,
      eligibleLocations: 0,
    };
  }
  const storeId = await getActingStoreId();
  try {
    const [connections, locations, mappings] = await Promise.all([
      withService((db) =>
        db
          .select({
            id: storeLogisticsProviders.id,
            email: storeLogisticsProviders.accountEmail,
            enabled: storeLogisticsProviders.enabled,
          })
          .from(storeLogisticsProviders)
          .where(
            and(
              eq(storeLogisticsProviders.storeId, storeId),
              eq(storeLogisticsProviders.provider, "shiprocket"),
            ),
          )
          .limit(1),
      ),
      withService((db) =>
        db
          .select({
            type: storeLocations.type,
            capabilities: storeLocations.capabilities,
          })
          .from(storeLocations)
          .where(
            and(
              eq(storeLocations.storeId, storeId),
              eq(storeLocations.active, true),
            ),
          ),
      ),
      withService((db) =>
        db
          .select({ id: locationLogisticsMappings.id })
          .from(locationLogisticsMappings)
          .where(
            and(
              eq(locationLogisticsMappings.storeId, storeId),
              eq(locationLogisticsMappings.provider, "shiprocket"),
            ),
          ),
      ),
    ]);
    const row = connections[0];
    const eligibleLocations = locations.filter((location) => {
      if (!isLocationType(location.type)) return false;
      return locationCan(
        normalizeCapabilities(location.capabilities, location.type),
        "online_fulfil",
      );
    }).length;
    return {
      connected: !!row,
      enabled: !!row?.enabled,
      accountEmail: row?.email ?? null,
      connectionId: row?.id ?? null,
      webhookUrl: row ? shiprocketWebhookUrl(row.id) : null,
      mappedLocations: mappings.length,
      eligibleLocations,
    };
  } catch (error) {
    console.error("getShiprocketChannelState:", error);
    return {
      connected: false,
      enabled: false,
      accountEmail: null,
      connectionId: null,
      webhookUrl: null,
      mappedLocations: 0,
      eligibleLocations: 0,
    };
  }
}

export async function saveShiprocketCredentials(
  emailInput: string,
  passwordInput: string,
): Promise<LogisticsActionResult> {
  if (!(await mayManageChannels())) {
    return { error: "You don't have permission to do this." };
  }
  const email = emailInput.trim().toLowerCase();
  const password = passwordInput.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { error: "Enter the email used for your Shiprocket account." };
  }
  if (password.length < 6 || password.length > 500) {
    return { error: "Enter your Shiprocket API user password." };
  }

  let session;
  try {
    session = await shiprocketLogin(email, password);
  } catch (error) {
    return {
      error: `Shiprocket rejected these credentials: ${error instanceof Error ? error.message : "Authentication failed."}`,
    };
  }

  const storeId = await getActingStoreId();
  const webhookSecret = newWebhookSecret();
  const values = {
    provider: "shiprocket",
    accountEmail: email,
    credentialSecretEnc: encryptSecret(password),
    tokenEnc: encryptSecret(session.token),
    tokenExpiresAt: session.expiresAt.toISOString(),
    webhookSecretHash: hashWebhookSecret(webhookSecret),
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  try {
    const rows = await withService((db) =>
      db
        .insert(storeLogisticsProviders)
        .values({ storeId, ...values })
        .onConflictDoUpdate({
          target: [
            storeLogisticsProviders.storeId,
            storeLogisticsProviders.provider,
          ],
          set: values,
        })
        .returning({ id: storeLogisticsProviders.id }),
    );
    const connectionId = rows[0]?.id;
    if (!connectionId) throw new Error("Connection was not saved.");
    return {
      success: true,
      webhookSecret,
      webhookUrl: shiprocketWebhookUrl(connectionId),
    };
  } catch (error) {
    console.error("saveShiprocketCredentials:", error);
    return { error: "Could not save the Shiprocket connection." };
  }
}

export async function setShiprocketEnabled(
  enabled: boolean,
): Promise<LogisticsActionResult> {
  if (!(await mayManageChannels())) {
    return { error: "You don't have permission to do this." };
  }
  const storeId = await getActingStoreId();
  const rows = await withService((db) =>
    db
      .update(storeLogisticsProviders)
      .set({ enabled: !!enabled, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(storeLogisticsProviders.storeId, storeId),
          eq(storeLogisticsProviders.provider, "shiprocket"),
        ),
      )
      .returning({ id: storeLogisticsProviders.id }),
  );
  return rows.length
    ? { success: true }
    : { error: "Connect Shiprocket first." };
}

export async function rotateShiprocketWebhookSecret(): Promise<LogisticsActionResult> {
  if (!(await mayManageChannels())) {
    return { error: "You don't have permission to do this." };
  }
  const storeId = await getActingStoreId();
  const secret = newWebhookSecret();
  const rows = await withService((db) =>
    db
      .update(storeLogisticsProviders)
      .set({
        webhookSecretHash: hashWebhookSecret(secret),
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(storeLogisticsProviders.storeId, storeId),
          eq(storeLogisticsProviders.provider, "shiprocket"),
        ),
      )
      .returning({ id: storeLogisticsProviders.id }),
  );
  const connectionId = rows[0]?.id;
  return connectionId
    ? {
        success: true,
        webhookSecret: secret,
        webhookUrl: shiprocketWebhookUrl(connectionId),
      }
    : { error: "Connect Shiprocket first." };
}

export async function disconnectShiprocket(): Promise<LogisticsActionResult> {
  if (!(await mayManageChannels())) {
    return { error: "You don't have permission to do this." };
  }
  const storeId = await getActingStoreId();
  try {
    await withService((db) =>
      db
        .delete(locationLogisticsMappings)
        .where(
          and(
            eq(locationLogisticsMappings.storeId, storeId),
            eq(locationLogisticsMappings.provider, "shiprocket"),
          ),
        ),
    );
    await withService((db) =>
      db
        .delete(storeLogisticsProviders)
        .where(
          and(
            eq(storeLogisticsProviders.storeId, storeId),
            eq(storeLogisticsProviders.provider, "shiprocket"),
          ),
        ),
    );
    return { success: true };
  } catch (error) {
    console.error("disconnectShiprocket:", error);
    return { error: "Could not disconnect Shiprocket." };
  }
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pickupCode(locationId: string): string {
  return `SM${locationId.replace(/-/g, "").slice(0, 28).toUpperCase()}`;
}

export async function syncShiprocketPickupLocations(): Promise<LogisticsActionResult> {
  const manager = await getManagerIdentity("channels");
  if (!manager) return { error: "You don't have permission to do this." };
  const storeId = await getActingStoreId();

  let session;
  try {
    session = await getShiprocketSessionForStore(storeId);
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Shiprocket is unavailable.",
    };
  }

  const [locations, contacts, adminsRows] = await Promise.all([
    withService((db) =>
      db
        .select({
          id: storeLocations.id,
          name: storeLocations.name,
          type: storeLocations.type,
          capabilities: storeLocations.capabilities,
          address: storeLocations.address,
        })
        .from(storeLocations)
        .where(
          and(
            eq(storeLocations.storeId, storeId),
            eq(storeLocations.active, true),
          ),
        ),
    ),
    withService((db) =>
      db
        .select({
          email: storeBillingSettings.contactEmail,
          phone: storeBillingSettings.contactPhone,
        })
        .from(storeBillingSettings)
        .where(eq(storeBillingSettings.storeId, storeId))
        .limit(1),
    ),
    withService((db) =>
      db
        .select({ email: admins.email, phone: admins.phone })
        .from(admins)
        .where(and(eq(admins.storeId, storeId), eq(admins.id, manager.uid)))
        .limit(1),
    ),
  ]);

  const email = textField(
    contacts[0]?.email || adminsRows[0]?.email || session.email,
  );
  const phone = textField(contacts[0]?.phone || adminsRows[0]?.phone).replace(
    /[^0-9+]/g,
    "",
  );
  if (!phone) {
    return {
      error:
        "Add a business contact phone in Settings → Tax & invoices before syncing warehouses.",
    };
  }

  let synced = 0;
  const skipped: Array<{ location: string; reason: string }> = [];
  for (const location of locations) {
    if (!isLocationType(location.type)) continue;
    const capabilities = normalizeCapabilities(
      location.capabilities,
      location.type,
    );
    if (!locationCan(capabilities, "online_fulfil")) continue;
    const address = (location.address ?? {}) as Record<string, unknown>;
    const line1 = textField(address.line1);
    const city = textField(address.city);
    const state = textField(address.state);
    const pin = textField(address.postalCode).replace(/\s/g, "");
    if (!line1 || !city || !state || !/^\d{6}$/.test(pin)) {
      skipped.push({
        location: location.name,
        reason: "Complete street, city, state, and a 6-digit PIN code.",
      });
      continue;
    }
    const code = pickupCode(location.id);
    let externalId: string | null = null;
    try {
      const response = await addShiprocketPickup(session.token, {
        pickup_location: code,
        name: location.name.slice(0, 50),
        email,
        phone,
        address: line1,
        address_2: textField(address.line2),
        city,
        state,
        country: "India",
        pin_code: pin,
      });
      externalId =
        response.pickup_id == null ? null : String(response.pickup_id);
    } catch (error) {
      // Re-syncing an existing Shiprocket pickup returns a duplicate-name
      // validation error. The stable code still maps to that same warehouse.
      const message = error instanceof Error ? error.message : "Sync failed.";
      if (
        !(error instanceof ShiprocketError) ||
        !/already|exist|duplicate/i.test(message)
      ) {
        skipped.push({ location: location.name, reason: message });
        continue;
      }
    }
    await withService((db) =>
      db
        .insert(locationLogisticsMappings)
        .values({
          storeId,
          locationId: location.id,
          provider: "shiprocket",
          externalPickupCode: code,
          externalLocationId: externalId,
          syncedAt: new Date().toISOString(),
        })
        .onConflictDoUpdate({
          target: [
            locationLogisticsMappings.locationId,
            locationLogisticsMappings.provider,
          ],
          set: {
            externalPickupCode: code,
            externalLocationId: externalId,
            syncedAt: new Date().toISOString(),
          },
        }),
    );
    synced += 1;
  }

  return {
    success: synced > 0,
    synced,
    skipped,
    ...(synced === 0 && skipped.length === 0
      ? { error: "No active location is enabled for online fulfilment." }
      : {}),
  };
}
