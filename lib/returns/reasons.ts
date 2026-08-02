// Why goods come back — and who pays for it (docs/returns-exchanges-plan.md §2.4).
//
// PURE: no DB, no request, no settings lookup. Just the catalog and the
// arithmetic that turns a reason plus a store's fee config into what actually
// gets deducted.
//
// ── Why the list lives in CODE, not in a table ─────────────────────────────
// Merchant-editable reasons would make the data useless the moment you have
// two stores: "damaged" in one and "Damaged/Broken" in another can't be
// compared, counted, or reported on. It is a fixed vocabulary the platform
// owns, like USP_ICONS — and, unlike a label, it carries BEHAVIOUR, which is
// the real reason it can't be free text.
//
// ── The rule worth encoding ────────────────────────────────────────────────
// ★ A FEE MUST NEVER BE CHARGED FOR THE MERCHANT'S OWN MISTAKE. A flat "10%
// restocking fee on everything" bills the customer for a parcel that arrived
// broken. Every serious retailer distinguishes these; encoding it means the
// merchant sets ONE number and the right thing happens per return.

export const RETURN_REASONS = [
  "damaged",
  "defective",
  "wrong_item",
  "not_as_described",
  "arrived_late",
  "changed_mind",
  "size_fit",
  "other",
] as const;

export type ReturnReason = (typeof RETURN_REASONS)[number];

export interface ReturnReasonDef {
  /** What the shopper picks from. */
  label: string;
  /** Shown under the label so "defective" and "damaged" aren't a coin toss. */
  hint: string;
  /**
   * ★ The load-bearing field. TRUE = the store got it wrong, so fees are
   * waived and the store pays return postage.
   */
  merchantFault: boolean;
  /**
   * Whether a photo is worth asking for when the store requires evidence.
   * Only for claims a picture can actually settle — a photo proves a dented
   * tin; it proves nothing about someone changing their mind.
   */
  photoHelps: boolean;
}

export const RETURN_REASON_REGISTRY: Record<ReturnReason, ReturnReasonDef> = {
  damaged: {
    label: "Arrived damaged",
    hint: "The parcel or the item was broken when it reached you.",
    merchantFault: true,
    photoHelps: true,
  },
  defective: {
    label: "Faulty or doesn't work",
    hint: "It arrived intact but doesn't do what it should.",
    merchantFault: true,
    photoHelps: true,
  },
  wrong_item: {
    label: "Wrong item sent",
    hint: "This isn't what was ordered.",
    merchantFault: true,
    photoHelps: true,
  },
  not_as_described: {
    label: "Not as described",
    hint: "It doesn't match the photos or the description.",
    merchantFault: true,
    photoHelps: true,
  },
  arrived_late: {
    label: "Arrived too late",
    hint: "It came after it was needed.",
    // The store's carrier, the store's problem — charging for a late delivery
    // is charging someone for a promise you broke.
    merchantFault: true,
    photoHelps: false,
  },
  changed_mind: {
    label: "Changed my mind",
    hint: "No longer needed.",
    merchantFault: false,
    photoHelps: false,
  },
  size_fit: {
    label: "Wrong size or fit",
    hint: "It's fine, it just doesn't fit.",
    merchantFault: false,
    photoHelps: false,
  },
  other: {
    label: "Something else",
    hint: "Tell the store what happened.",
    merchantFault: false,
    photoHelps: false,
  },
};

export function isReturnReason(value: unknown): value is ReturnReason {
  return (
    typeof value === "string" &&
    (RETURN_REASONS as readonly string[]).includes(value)
  );
}

/** The merchant-facing list, in the order a shopper should meet it: the
 *  store's own failures first, since those are the urgent ones. */
export function returnReasonOptions(): Array<
  ReturnReasonDef & { value: ReturnReason }
> {
  return RETURN_REASONS.map((value) => ({
    value,
    ...RETURN_REASON_REGISTRY[value],
  }));
}

export interface ReturnFeeConfig {
  /** `returns.restockingFeePercent` — percent of the returned goods value. */
  restockingFeePercent: number;
  /** `returns.returnShippingFee` — flat ₹ when the customer ships it back. */
  returnShippingFee: number;
}

export interface ReturnFees {
  restockingFee: number;
  returnShippingFee: number;
  /** What comes off the refund in total. */
  totalDeduction: number;
  /** True when fees were waived because the store was at fault. */
  waived: boolean;
  /** Who pays to get the goods back. Display only — no carrier integration. */
  returnPostagePaidBy: "store" | "customer";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What to deduct from a refund of `goodsValue` for this reason.
 *
 * `goodsValue` is the value of the returned lines EXCLUDING tax — a fee is
 * charged on the goods, not on the government's share.
 *
 * ★ Fees are waived WHOLESALE for a merchant-fault reason, not reduced. There
 * is no defensible fraction of "we sent you a broken thing" to bill for.
 */
export function feesFor(
  reason: ReturnReason | null | undefined,
  config: ReturnFeeConfig,
  goodsValue: number,
): ReturnFees {
  const def = reason ? RETURN_REASON_REGISTRY[reason] : undefined;
  // An unknown or missing reason is treated as NOT the merchant's fault, so
  // fees apply — the generous reading would let anyone waive them by simply
  // not answering. `returns.requireReason` is what stops that being silent.
  const waived = def?.merchantFault === true;

  if (waived) {
    return {
      restockingFee: 0,
      returnShippingFee: 0,
      totalDeduction: 0,
      waived: true,
      returnPostagePaidBy: "store",
    };
  }

  const value = Math.max(0, Number(goodsValue) || 0);
  const pct = Math.min(
    100,
    Math.max(0, Number(config.restockingFeePercent) || 0),
  );
  const restockingFee = round2((value * pct) / 100);
  const shipping = Math.max(0, Number(config.returnShippingFee) || 0);

  // ★ The deduction can never exceed the goods value. A ₹40 flat postage fee on
  // a ₹25 item would otherwise produce a NEGATIVE refund — i.e. the customer
  // owing money for sending something back, which is not a thing this system
  // is ever allowed to compute.
  const uncapped = round2(restockingFee + shipping);
  const totalDeduction = Math.min(uncapped, value);

  return {
    restockingFee,
    returnShippingFee: shipping,
    totalDeduction,
    waived: false,
    returnPostagePaidBy: "customer",
  };
}

/** Whether to ask for a photo: the store requires evidence AND a picture could
 *  actually settle this particular claim. */
export function wantsPhoto(
  reason: ReturnReason | null | undefined,
  requirePhotoForDamage: boolean,
): boolean {
  if (!requirePhotoForDamage || !reason) return false;
  return RETURN_REASON_REGISTRY[reason].photoHelps;
}
