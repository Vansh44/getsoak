"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  productVariants,
  products,
  storeLogisticsProviders,
  storeShippingSettings,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { variantEffectiveSelling } from "@/lib/pricing";
import { getServerUser } from "@/lib/auth/server-user";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { clientIp, rateLimit } from "@/lib/rate-limit";
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
import { resolveOffersForCart } from "@/lib/offers/cart";
import type { CartItem } from "@/app/(storefront)/components/cart/CartProvider";

export interface ShippingSettingsState {
  settings: ShippingSettings;
  shiprocketConnected: boolean;
  shiprocketEnabled: boolean;
}

export interface ProductDeliveryEstimate {
  available: boolean;
  postalCode: string;
  kind: "physical" | "digital";
  option?: CheckoutShippingOption;
  alternativeCount?: number;
  error?: string;
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
  /** Delivery or collection, for a `fulfilment_type` offer condition. */
  fulfilmentType?: "delivery" | "pickup";
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
          // Needed only by the offer engine, which prices a category-scoped
          // offer — the parcel does not care what shelf a product came from.
          categoryId: products.categoryId,
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
              // The merchandise subtotal below decides free-shipping and the
              // declared value, so it must be the price actually charged — a
              // variant on sale was previously valued at its regular price.
              specialPrice: productVariants.specialPrice,
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
    subtotal +=
      (variant
        ? variantEffectiveSelling({
            selling_price: variant.price,
            special_price: variant.specialPrice,
          })
        : product.price) * item.quantity;
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
  // ★★ DERIVED HERE, NEVER ACCEPTED FROM THE CLIENT. "An offer waives my
  // delivery charge" is precisely the claim a browser would like to make about
  // itself, and this quote is what the shopper is shown AND what `placeOrder`
  // re-checks against. Resolving it server-side costs one read on a path that
  // already makes a carrier round trip, and it is the only way the preview can
  // match the charge.
  //
  // ★ Priced from the SAME rows this function already read for the parcel, so
  // the offer engine and the shipping quote cannot disagree about what is in
  // the cart.
  const offerWaivesShipping = await (async () => {
    try {
      const result = await resolveOffersForCart({
        storeId,
        channel: "storefront",
        locationId: null,
        customerId: user.id,
        code: null,
        paymentMethod: input.paymentMethod,
        fulfilmentType: input.fulfilmentType ?? "delivery",
        lines: input.items.flatMap((item, idx) => {
          const product = productMap.get(item.productId);
          if (!product) return [];
          const variant = item.variantId
            ? variantMap.get(item.variantId)
            : null;
          return [
            {
              id: String(idx),
              productId: item.productId,
              variantId: item.variantId ?? null,
              categoryId: product.categoryId ?? null,
              quantity: item.quantity,
              unitPrice: variant
                ? variantEffectiveSelling({
                    selling_price: variant.price,
                    special_price: variant.specialPrice,
                  })
                : product.price,
              // ★ The price this line is on sale FROM, so `onSalePrice` reads
              // the same here as it does in `placeOrder`. Omitting it made
              // every line look full-price, so a scoped free-shipping offer
              // could quote ₹0 delivery in the preview and the real rate at
              // checkout.
              regularUnitPrice: variant ? variant.price : product.price,
            },
          ];
        }),
      });
      return result?.shipping != null;
    } catch {
      // A quote that cannot resolve offers still quotes. Failing to `false`
      // charges for delivery, which `placeOrder` then re-checks and waives —
      // the shopper is never charged more than the authoritative path says.
      return false;
    }
  })();

  if (shippingSettings.mode !== "shiprocket") {
    return {
      options: [
        manualShippingOption(shippingSettings, subtotal, offerWaivesShipping),
      ],
    };
  }
  const fulfilmentLocationId = await resolveFulfilmentLocation(storeId, lines);
  return quoteShippingForOrder({
    storeId,
    offerWaivesShipping,
    fulfilmentLocationId,
    deliveryPostcode: input.postalCode,
    cod: input.paymentMethod === "cod",
    merchandiseSubtotal: subtotal,
    parcel: packageForShippingLines(lines),
    settings: shippingSettings,
  });
}

/**
 * Public PDP delivery check. The client supplies identifiers, quantity and a
 * PIN only; catalog price, inventory, parcel measurements, warehouse routing
 * and merchant shipping policy are all re-read here. This keeps a product-page
 * promise aligned with the authoritative checkout quote.
 */
export async function getProductDeliveryEstimate(input: {
  productId: string;
  variantId: string | null;
  quantity: number;
  postalCode: string;
}): Promise<ProductDeliveryEstimate> {
  const postalCode = String(input.postalCode ?? "")
    .replace(/\D/g, "")
    .slice(0, 6);
  if (!/^\d{6}$/.test(postalCode)) {
    return {
      available: false,
      postalCode,
      kind: "physical",
      error: "Enter a valid 6-digit delivery PIN code.",
    };
  }
  if (
    typeof input.productId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(input.productId) ||
    (input.variantId !== null &&
      (typeof input.variantId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(input.variantId))) ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > 99
  ) {
    return {
      available: false,
      postalCode,
      kind: "physical",
      error: "This product selection is invalid. Refresh and try again.",
    };
  }

  const ip = clientIp(await headers());
  const allowed = await rateLimit(`product-delivery:${ip}`, {
    max: 30,
    windowSeconds: 60,
  });
  if (!allowed.allowed) {
    return {
      available: false,
      postalCode,
      kind: "physical",
      error: "Too many delivery checks. Wait a moment and try again.",
    };
  }

  const storeId = await getCurrentStoreId();
  const [productRows, variantRows, shippingSettings] = await Promise.all([
    withService((db) =>
      db
        .select({
          id: products.id,
          status: products.status,
          price: products.sellingPrice,
          basePrice: products.basePrice,
          trackInventory: products.trackInventory,
          allowBackorder: products.allowBackorder,
          onlineStock: products.onlineStock,
          requiresShipping: products.requiresShipping,
          weightGrams: products.weightGrams,
          lengthCm: products.lengthCm,
          widthCm: products.widthCm,
          heightCm: products.heightCm,
        })
        .from(products)
        .where(
          and(
            eq(products.storeId, storeId),
            eq(products.id, input.productId),
            eq(products.status, "published"),
          ),
        )
        .limit(1),
    ),
    input.variantId
      ? withService((db) =>
          db
            .select({
              id: productVariants.id,
              productId: productVariants.productId,
              price: productVariants.sellingPrice,
              basePrice: productVariants.basePrice,
              specialPrice: productVariants.specialPrice,
              trackInventory: productVariants.trackInventory,
              allowBackorder: productVariants.allowBackorder,
              onlineStock: productVariants.onlineStock,
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
                eq(productVariants.id, input.variantId!),
                eq(productVariants.productId, input.productId),
              ),
            )
            .limit(1),
        )
      : Promise.resolve([]),
    readShippingSettings(storeId),
  ]);
  const product = productRows[0];
  const variant = variantRows[0];
  if (!product || (input.variantId && !variant)) {
    return {
      available: false,
      postalCode,
      kind: "physical",
      error: "This product is no longer available.",
    };
  }

  const trackInventory = variant?.trackInventory ?? product.trackInventory;
  const allowBackorder = variant?.allowBackorder ?? product.allowBackorder;
  const onlineStock = variant?.onlineStock ?? product.onlineStock;
  if (trackInventory && !allowBackorder && onlineStock < input.quantity) {
    return {
      available: false,
      postalCode,
      kind: "physical",
      error:
        onlineStock <= 0
          ? "This item is currently out of stock for online delivery."
          : `Only ${onlineStock} available for online delivery.`,
    };
  }

  const requiresShipping =
    variant?.requiresShipping ?? product.requiresShipping;
  if (!requiresShipping) {
    return {
      available: true,
      postalCode,
      kind: "digital",
      option: {
        id: "digital:none",
        label: "Available immediately",
        description: "No physical delivery required",
        amount: 0,
        carrierCost: null,
        courierId: null,
        courierName: null,
        estimatedDeliveryMinDays: null,
        estimatedDeliveryMaxDays: null,
        estimatedDeliveryAt: null,
        freeShippingApplied: true,
      },
    };
  }

  // The special-price rule comes from lib/pricing, not a copy of it: this used
  // to inline `special ?? selling` while the checkout quote above omitted the
  // rule altogether, so the two quotes valued the same sale cart differently.
  const variantUnit = variant
    ? variantEffectiveSelling({
        selling_price: variant.price,
        special_price: variant.specialPrice,
      })
    : 0;
  const unitPrice = variant
    ? variantUnit > 0
      ? variantUnit
      : variant.basePrice
    : product.price > 0
      ? product.price
      : product.basePrice;
  const line = {
    productId: product.id,
    variantId: variant?.id ?? null,
    quantity: input.quantity,
    needsStock: trackInventory && !allowBackorder,
    requiresShipping: true,
    weightGrams: variant?.weightGrams ?? product.weightGrams,
    lengthCm: variant?.lengthCm ?? product.lengthCm,
    widthCm: variant?.widthCm ?? product.widthCm,
    heightCm: variant?.heightCm ?? product.heightCm,
  };
  const merchandiseSubtotal = unitPrice * input.quantity;
  const quote =
    shippingSettings.mode === "shiprocket"
      ? await quoteShippingForOrder({
          storeId,
          fulfilmentLocationId: await resolveFulfilmentLocation(storeId, [
            line,
          ]),
          deliveryPostcode: postalCode,
          cod: false,
          merchandiseSubtotal,
          parcel: packageForShippingLines([line]),
          settings: shippingSettings,
        })
      : {
          options: [
            manualShippingOption(shippingSettings, merchandiseSubtotal),
          ],
        };
  const option = quote.options[0];
  if (!option) {
    return {
      available: false,
      postalCode,
      kind: "physical",
      error: quote.error ?? "Delivery is not available for this PIN code.",
    };
  }
  return {
    available: true,
    postalCode,
    kind: "physical",
    option,
    alternativeCount: Math.max(0, quote.options.length - 1),
  };
}
