import "server-only";

import { and, eq } from "drizzle-orm";
import {
  locationLogisticsMappings,
  storeLocations,
  storeShippingSettings,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { getShiprocketSessionForStore } from "@/lib/logistics/connection";
import { checkShiprocketServiceability } from "@/lib/logistics/shiprocket";
import { manualShippingOption, shiprocketShippingOptions } from "./rates";
import {
  DEFAULT_SHIPPING_SETTINGS,
  rowToShippingSettings,
  type CheckoutShippingOption,
  type ShippingPackage,
  type ShippingSettings,
} from "./types";

export async function readShippingSettings(
  storeId: string,
): Promise<ShippingSettings> {
  const rows = await withService((db) =>
    db
      .select()
      .from(storeShippingSettings)
      .where(eq(storeShippingSettings.storeId, storeId))
      .limit(1),
  ).catch((error) => {
    // Safe rollout default: stores remain free-shipping if application code
    // reaches an instance moments before the migration has landed.
    console.error("readShippingSettings:", error);
    return [];
  });
  return rows[0]
    ? rowToShippingSettings(rows[0])
    : { ...DEFAULT_SHIPPING_SETTINGS };
}

function postalCode(address: unknown): string {
  if (!address || typeof address !== "object") return "";
  const value = (address as Record<string, unknown>).postalCode;
  return typeof value === "string" ? value.replace(/\s/g, "") : "";
}

export async function quoteShippingForOrder(input: {
  storeId: string;
  fulfilmentLocationId: string | null;
  deliveryPostcode: string;
  cod: boolean;
  merchandiseSubtotal: number;
  parcel: ShippingPackage;
  settings?: ShippingSettings;
}): Promise<{ options: CheckoutShippingOption[]; error?: string }> {
  const settings =
    input.settings ?? (await readShippingSettings(input.storeId));
  if (settings.mode !== "shiprocket") {
    return {
      options: [manualShippingOption(settings, input.merchandiseSubtotal)],
    };
  }

  if (!/^\d{6}$/.test(input.deliveryPostcode.replace(/\s/g, ""))) {
    return { options: [], error: "Enter a valid 6-digit delivery PIN code." };
  }

  const locations = await withService((db) => {
    const query = db
      .select({
        id: storeLocations.id,
        address: storeLocations.address,
        pickupCode: locationLogisticsMappings.externalPickupCode,
      })
      .from(storeLocations)
      .leftJoin(
        locationLogisticsMappings,
        and(
          eq(locationLogisticsMappings.locationId, storeLocations.id),
          eq(locationLogisticsMappings.provider, "shiprocket"),
        ),
      )
      .where(
        and(
          eq(storeLocations.storeId, input.storeId),
          eq(storeLocations.active, true),
          input.fulfilmentLocationId
            ? eq(storeLocations.id, input.fulfilmentLocationId)
            : eq(storeLocations.isDefault, true),
        ),
      )
      .limit(1);
    return query;
  });
  const origin = locations[0];
  if (!origin?.pickupCode) {
    return {
      options: [],
      error:
        "Sync the fulfilment location with Shiprocket before using live rates.",
    };
  }
  const pickupPostcode = postalCode(origin.address);
  if (!/^\d{6}$/.test(pickupPostcode)) {
    return {
      options: [],
      error: "Add a valid 6-digit PIN code to the fulfilment location.",
    };
  }

  try {
    const session = await getShiprocketSessionForStore(input.storeId);
    const raw = await checkShiprocketServiceability(session.token, {
      pickupPostcode,
      deliveryPostcode: input.deliveryPostcode.replace(/\s/g, ""),
      cod: input.cod,
      weightKg: Math.max(0.5, input.parcel.weightGrams / 1000),
      lengthCm: input.parcel.lengthCm,
      widthCm: input.parcel.widthCm,
      heightCm: input.parcel.heightCm,
      declaredValue: input.merchandiseSubtotal,
    });
    const options = shiprocketShippingOptions(
      raw,
      settings,
      input.merchandiseSubtotal,
    );
    return options.length
      ? { options }
      : { options: [], error: "No courier is available for this PIN code." };
  } catch (error) {
    return {
      options: [],
      error:
        error instanceof Error
          ? error.message
          : "Could not fetch courier rates. Try again.",
    };
  }
}
