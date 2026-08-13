"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  productVariants,
  products,
  storeLogisticsProviders,
  storeShippingSettings,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { rateLimit } from "@/lib/rate-limit";
import { emitEvent } from "@/lib/notifications/record";
import {
  getActingStoreId,
  getManagerIdentity,
  getViewerContext,
} from "@/app/dashboard/lib/access";
import { can } from "@/app/dashboard/lib/permissions";
import { resolveFulfilmentLocation } from "@/lib/fulfilment/resolve";
import {
  manualShippingOption,
  packageForShippingLines,
} from "@/lib/shipping/rates";
import {
  rowToShippingSettings,
  type CheckoutShippingOption,
  type ShippingSettings,
} from "@/lib/shipping/types";
import {
  quoteShippingForOrder,
  readShippingSettings,
} from "@/lib/shipping/quote";
import type { CartItem } from "@/app/(storefront)/components/cart/CartProvider";

export interface ShippingSettingsState {
  settings: ShippingSettings;
  shiprocketConnected: boolean;
  shiprocketEnabled: boolean;
}

export async function getShippingSettings(): Promise<ShippingSettingsState> {
  const viewer = await getViewerContext();
  if (
    !viewer?.profile ||
    !can(viewer.permissions, "settings", "view", viewer.isSuperadmin)
  ) {
    return {
      settings: rowToShippingSettings(undefined),
      shiprocketConnected: false,
      shiprocketEnabled: false,
    };
  }
  const storeId = await getActingStoreId();
  const [settings, providers] = await Promise.all([
    readShippingSettings(storeId),
    withService((db) =>
      db
        .select({ enabled: storeLogisticsProviders.enabled })
        .from(storeLogisticsProviders)
        .where(
          and(
            eq(storeLogisticsProviders.storeId, storeId),
            eq(storeLogisticsProviders.provider, "shiprocket"),
          ),
        )
        .limit(1),
    ),
  ]);
  return {
    settings,
    shiprocketConnected: providers.length > 0,
    shiprocketEnabled: providers[0]?.enabled ?? false,
  };
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function saveShippingSettings(
  input: ShippingSettings,
): Promise<{ success?: boolean; error?: string }> {
  const manager = await getManagerIdentity("settings");
  if (!manager)
    return { error: "You don't have permission to change shipping." };
  const storeId = await getActingStoreId();

  const settings = rowToShippingSettings({
    mode: input.mode,
    flatRate: finite(input.flatRate),
    freeAbove: input.freeAbove == null ? null : finite(input.freeAbove),
    manualMinDays: Math.round(finite(input.manualMinDays, 3)),
    manualMaxDays: Math.round(finite(input.manualMaxDays, 7)),
    handlingDays: Math.round(finite(input.handlingDays, 1)),
    carrierAdjustmentType: input.carrierAdjustmentType,
    carrierAdjustmentValue: finite(input.carrierAdjustmentValue),
    showAllCouriers: !!input.showAllCouriers,
  });
  if (settings.flatRate < 0)
    return { error: "The fixed shipping charge cannot be negative." };
  if (settings.freeAbove !== null && settings.freeAbove <= 0)
    return { error: "The free-shipping amount must be greater than zero." };
  if (
    settings.manualMinDays < 0 ||
    settings.manualMaxDays < settings.manualMinDays ||
    settings.manualMaxDays > 90
  ) {
    return { error: "Enter a valid delivery estimate between 0 and 90 days." };
  }
  if (settings.handlingDays < 0 || settings.handlingDays > 30)
    return { error: "Handling time must be between 0 and 30 days." };
  if (settings.carrierAdjustmentValue < 0)
    return { error: "The live-rate adjustment cannot be negative." };

  if (settings.mode === "shiprocket") {
    const provider = await withService((db) =>
      db
        .select({ enabled: storeLogisticsProviders.enabled })
        .from(storeLogisticsProviders)
        .where(
          and(
            eq(storeLogisticsProviders.storeId, storeId),
            eq(storeLogisticsProviders.provider, "shiprocket"),
          ),
        )
        .limit(1),
    );
    if (!provider[0]?.enabled) {
      return { error: "Connect and enable Shiprocket in Channels first." };
    }
  }

  await withService((db) =>
    db
      .insert(storeShippingSettings)
      .values({
        storeId,
        ...settings,
        updatedBy: manager.uid,
      })
      .onConflictDoUpdate({
        target: storeShippingSettings.storeId,
        set: {
          ...settings,
          updatedBy: manager.uid,
          updatedAt: sql`now()`,
        },
      }),
  );
  revalidatePath("/dashboard/settings/shipping");
  revalidatePath("/checkout");
  emitEvent({
    type: "settings.changed",
    storeId,
    actor: { type: "admin", id: manager.uid },
    payload: { settings: "Shipping & delivery", count: 1 },
  });
  return { success: true };
}

export async function getCheckoutShippingOptions(input: {
  items: CartItem[];
  postalCode: string;
  paymentMethod: "cod" | "razorpay";
}): Promise<{ options: CheckoutShippingOption[]; error?: string }> {
  const user = await getServerUser();
  if (!user) return { options: [], error: "Sign in to see delivery rates." };
  const allowed = await rateLimit(`shipping-quote:${user.id}`, {
    max: 40,
    windowSeconds: 60,
  });
  if (!allowed.allowed) {
    return {
      options: [],
      error: "Too many delivery checks. Wait a moment and try again.",
    };
  }
  if (!input.items.length || input.items.length > 100) {
    return { options: [], error: "Your cart is empty or too large." };
  }
  const storeId = await getCurrentStoreId();
  const productIds = [...new Set(input.items.map((item) => item.productId))];
  const variantIds = [
    ...new Set(
      input.items
        .map((item) => item.variantId)
        .filter((id): id is string => !!id),
    ),
  ];
  const [shippingSettings, productRows, variantRows] = await Promise.all([
    readShippingSettings(storeId),
    withService((db) =>
      db
        .select({
          id: products.id,
          price: products.sellingPrice,
          trackInventory: products.trackInventory,
          allowBackorder: products.allowBackorder,
          requiresShipping: products.requiresShipping,
          weightGrams: products.weightGrams,
          lengthCm: products.lengthCm,
          widthCm: products.widthCm,
          heightCm: products.heightCm,
        })
        .from(products)
        .where(
          and(eq(products.storeId, storeId), inArray(products.id, productIds)),
        ),
    ),
    variantIds.length
      ? withService((db) =>
          db
            .select({
              id: productVariants.id,
              price: productVariants.sellingPrice,
              trackInventory: productVariants.trackInventory,
              allowBackorder: productVariants.allowBackorder,
              requiresShipping: productVariants.requiresShipping,
              weightGrams: productVariants.weightGrams,
              lengthCm: productVariants.lengthCm,
              widthCm: productVariants.widthCm,
              heightCm: productVariants.heightCm,
            })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.storeId, storeId),
                inArray(productVariants.id, variantIds),
              ),
            ),
        )
      : Promise.resolve([]),
  ]);
  const productMap = new Map(productRows.map((row) => [row.id, row]));
  const variantMap = new Map(variantRows.map((row) => [row.id, row]));
  let subtotal = 0;
  const lines = input.items.flatMap((item) => {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) return [];
    const product = productMap.get(item.productId);
    if (!product) return [];
    const variant = item.variantId ? variantMap.get(item.variantId) : null;
    if (item.variantId && !variant) return [];
    subtotal += (variant?.price ?? product.price) * item.quantity;
    return [
      {
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
        needsStock:
          !!(variant?.trackInventory ?? product.trackInventory) &&
          !(variant?.allowBackorder ?? product.allowBackorder),
        requiresShipping: variant?.requiresShipping ?? product.requiresShipping,
        weightGrams: variant?.weightGrams ?? product.weightGrams,
        lengthCm: variant?.lengthCm ?? product.lengthCm,
        widthCm: variant?.widthCm ?? product.widthCm,
        heightCm: variant?.heightCm ?? product.heightCm,
      },
    ];
  });
  if (lines.length !== input.items.length) {
    return { options: [], error: "Your cart changed. Refresh and try again." };
  }
  if (!lines.some((line) => line.requiresShipping)) {
    return {
      options: [
        {
          id: "digital:none",
          label: "No delivery required",
          description: "Digital products",
          amount: 0,
          carrierCost: null,
          courierId: null,
          courierName: null,
          estimatedDeliveryMinDays: null,
          estimatedDeliveryMaxDays: null,
          estimatedDeliveryAt: null,
          freeShippingApplied: true,
        },
      ],
    };
  }
  if (shippingSettings.mode !== "shiprocket") {
    return { options: [manualShippingOption(shippingSettings, subtotal)] };
  }
  const fulfilmentLocationId = await resolveFulfilmentLocation(storeId, lines);
  return quoteShippingForOrder({
    storeId,
    fulfilmentLocationId,
    deliveryPostcode: input.postalCode,
    cod: input.paymentMethod === "cod",
    merchandiseSubtotal: subtotal,
    parcel: packageForShippingLines(lines),
    settings: shippingSettings,
  });
}
