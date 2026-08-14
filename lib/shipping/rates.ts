import type {
  CheckoutShippingOption,
  ShippingPackage,
  ShippingSettings,
} from "./types";

type UnknownRecord = Record<string, unknown>;

const money = (value: number) => Math.round(value * 100) / 100;

export function packageForShippingLines(
  lines: Array<{
    quantity: number;
    requiresShipping: boolean;
    weightGrams: number | null;
    lengthCm: number | null;
    widthCm: number | null;
    heightCm: number | null;
  }>,
): ShippingPackage {
  const physical = lines.filter((line) => line.requiresShipping);
  return {
    weightGrams: Math.max(
      500,
      physical.reduce(
        (sum, line) => sum + (line.weightGrams ?? 0) * line.quantity,
        0,
      ),
    ),
    lengthCm: Math.max(10, ...physical.map((line) => line.lengthCm ?? 0)),
    widthCm: Math.max(10, ...physical.map((line) => line.widthCm ?? 0)),
    heightCm: Math.max(
      5,
      physical.reduce(
        (sum, line) => sum + (line.heightCm ?? 0) * line.quantity,
        0,
      ),
    ),
  };
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function dateAfter(days: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + Math.max(0, days));
  return date.toISOString();
}

function deliveryDescription(minDays: number, maxDays: number): string {
  if (minDays === maxDays) {
    return minDays === 0 ? "Delivery today" : `Delivery in ${minDays} days`;
  }
  return `Delivery in ${minDays}–${maxDays} days`;
}

function transitRange(courier: UnknownRecord): [number, number] {
  const raw =
    courier.estimated_delivery_days ?? courier.delivery_days ?? undefined;
  if (typeof raw === "string") {
    const values = raw.match(/\d+/g)?.map(Number) ?? [];
    if (values.length >= 2) {
      return [Math.max(1, values[0]), Math.max(values[0], values[1])];
    }
    if (values.length === 1)
      return [Math.max(1, values[0]), Math.max(1, values[0])];
  }
  const days = number(raw);
  if (days !== null) {
    const rounded = Math.max(1, Math.round(days));
    return [rounded, rounded];
  }
  if (typeof courier.etd === "string") {
    const eta = Date.parse(courier.etd);
    if (Number.isFinite(eta)) {
      const diff = Math.max(1, Math.ceil((eta - Date.now()) / 86_400_000));
      return [diff, diff];
    }
  }
  return [4, 5];
}

function adjustedCarrierRate(
  carrierRate: number,
  settings: ShippingSettings,
): number {
  if (settings.carrierAdjustmentType === "fixed") {
    return money(Math.max(0, carrierRate + settings.carrierAdjustmentValue));
  }
  if (settings.carrierAdjustmentType === "percentage") {
    return money(
      Math.max(0, carrierRate * (1 + settings.carrierAdjustmentValue / 100)),
    );
  }
  return money(Math.max(0, carrierRate));
}

export function freeShippingApplies(
  settings: ShippingSettings,
  merchandiseSubtotal: number,
): boolean {
  return (
    settings.mode === "free" ||
    (settings.freeAbove !== null && merchandiseSubtotal >= settings.freeAbove)
  );
}

export function manualShippingOption(
  settings: ShippingSettings,
  merchandiseSubtotal: number,
): CheckoutShippingOption {
  const free = freeShippingApplies(settings, merchandiseSubtotal);
  const minDays = settings.manualMinDays;
  const maxDays = Math.max(minDays, settings.manualMaxDays);
  return {
    id: settings.mode === "flat" ? "manual:standard" : "manual:free",
    label: free ? "Free shipping" : "Standard shipping",
    description: deliveryDescription(minDays, maxDays),
    amount: free ? 0 : money(settings.flatRate),
    carrierCost: null,
    courierId: null,
    courierName: null,
    estimatedDeliveryMinDays: minDays,
    estimatedDeliveryMaxDays: maxDays,
    estimatedDeliveryAt: dateAfter(maxDays),
    freeShippingApplied: free,
  };
}

/** Translate Shiprocket's loosely typed response into stable checkout choices. */
export function shiprocketShippingOptions(
  raw: unknown,
  settings: ShippingSettings,
  merchandiseSubtotal: number,
): CheckoutShippingOption[] {
  const root = record(raw);
  const data = record(root?.data);
  const companies = Array.isArray(data?.available_courier_companies)
    ? data.available_courier_companies
    : [];
  const thresholdFree = freeShippingApplies(settings, merchandiseSubtotal);

  const options = companies.flatMap((value): CheckoutShippingOption[] => {
    const courier = record(value);
    if (!courier) return [];
    const courierId = courier.courier_company_id ?? courier.courier_id;
    const courierName = courier.courier_name;
    const carrierRate = number(courier.rate ?? courier.freight_charge);
    if (
      courierId == null ||
      typeof courierName !== "string" ||
      !courierName.trim() ||
      carrierRate === null ||
      carrierRate < 0
    ) {
      return [];
    }

    const [transitMin, transitMax] = transitRange(courier);
    const minDays = transitMin + settings.handlingDays;
    const maxDays = transitMax + settings.handlingDays;
    return [
      {
        id: `shiprocket:${String(courierId)}`,
        label: courierName.trim(),
        description: deliveryDescription(minDays, maxDays),
        amount: thresholdFree ? 0 : adjustedCarrierRate(carrierRate, settings),
        carrierCost: money(carrierRate),
        courierId: String(courierId),
        courierName: courierName.trim(),
        estimatedDeliveryMinDays: minDays,
        estimatedDeliveryMaxDays: maxDays,
        estimatedDeliveryAt: dateAfter(maxDays),
        freeShippingApplied: thresholdFree,
      },
    ];
  });

  options.sort(
    (a, b) =>
      a.amount - b.amount ||
      (a.estimatedDeliveryMaxDays ?? 999) - (b.estimatedDeliveryMaxDays ?? 999),
  );
  return settings.showAllCouriers ? options.slice(0, 5) : options.slice(0, 1);
}
