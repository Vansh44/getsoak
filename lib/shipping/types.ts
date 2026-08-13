export type ShippingRateMode = "free" | "flat" | "shiprocket";
export type CarrierAdjustmentType = "none" | "fixed" | "percentage";

export interface ShippingSettings {
  mode: ShippingRateMode;
  flatRate: number;
  freeAbove: number | null;
  manualMinDays: number;
  manualMaxDays: number;
  handlingDays: number;
  carrierAdjustmentType: CarrierAdjustmentType;
  carrierAdjustmentValue: number;
  showAllCouriers: boolean;
}

export const DEFAULT_SHIPPING_SETTINGS: ShippingSettings = {
  mode: "free",
  flatRate: 0,
  freeAbove: null,
  manualMinDays: 3,
  manualMaxDays: 7,
  handlingDays: 1,
  carrierAdjustmentType: "none",
  carrierAdjustmentValue: 0,
  showAllCouriers: true,
};

export interface CheckoutShippingOption {
  id: string;
  label: string;
  description: string;
  amount: number;
  carrierCost: number | null;
  courierId: string | null;
  courierName: string | null;
  estimatedDeliveryMinDays: number | null;
  estimatedDeliveryMaxDays: number | null;
  estimatedDeliveryAt: string | null;
  freeShippingApplied: boolean;
}

/** Immutable checkout choice stored on the order for fulfilment and support. */
export interface ShippingOptionSnapshot extends CheckoutShippingOption {
  quotedAt: string;
  provider: "manual" | "shiprocket";
}

export interface ShippingPackage {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export function rowToShippingSettings(
  row:
    | {
        mode?: string | null;
        flatRate?: number | null;
        freeAbove?: number | null;
        manualMinDays?: number | null;
        manualMaxDays?: number | null;
        handlingDays?: number | null;
        carrierAdjustmentType?: string | null;
        carrierAdjustmentValue?: number | null;
        showAllCouriers?: boolean | null;
      }
    | undefined,
): ShippingSettings {
  if (!row) return DEFAULT_SHIPPING_SETTINGS;
  return {
    mode: row.mode === "flat" || row.mode === "shiprocket" ? row.mode : "free",
    flatRate: Number(row.flatRate ?? 0),
    freeAbove: row.freeAbove == null ? null : Number(row.freeAbove),
    manualMinDays: Number(row.manualMinDays ?? 3),
    manualMaxDays: Number(row.manualMaxDays ?? 7),
    handlingDays: Number(row.handlingDays ?? 1),
    carrierAdjustmentType:
      row.carrierAdjustmentType === "fixed" ||
      row.carrierAdjustmentType === "percentage"
        ? row.carrierAdjustmentType
        : "none",
    carrierAdjustmentValue: Number(row.carrierAdjustmentValue ?? 0),
    showAllCouriers: row.showAllCouriers ?? true,
  };
}
