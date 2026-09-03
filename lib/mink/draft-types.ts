import { parseMinkBulkPriceDraftLines } from "./bulk-price-policy";
export {
  MAX_MINK_BULK_PRICE_LINES,
  parseMinkBulkPriceDraftLines,
  type MinkBulkPriceDraftLine,
} from "./bulk-price-policy";

export const MINK_DRAFT_KINDS = [
  "product_description",
  "product_seo",
  "blog",
  "coupon_email",
  "customer_message",
  "product_create",
  "coupon_create",
  "coupon_update",
  "customer_group_create",
  "customer_group_update",
  "inventory_adjustment",
  "bulk_inventory_adjustment",
  "order_status_transition",
  "bulk_price_update",
  "offer_create",
  "offer_update",
  "offer_activate",
] as const;

export type MinkDraftKind = (typeof MINK_DRAFT_KINDS)[number];
export type MinkDraftStatus = "proposed" | "draft";
export type MinkDraftCreditSource =
  | "plan"
  | "credit"
  | "mixed"
  | "plan_unlimited";

export interface MinkDraftField {
  key: string;
  label: string;
  value: string;
  multiline: boolean;
  maxLength: number;
}

export type MinkDraftContent = Record<string, string>;

export interface MinkDraftVersionSummary {
  version: number;
  action: "save" | "rollback";
  createdAt: string;
  createdBy: string;
}

export const MINK_DRAFT_CONFIG: Record<
  MinkDraftKind,
  {
    label: string;
    expectedCredits: number;
    fields: Array<{
      key: string;
      label: string;
      required: boolean;
      multiline: boolean;
      maxLength: number;
    }>;
  }
> = {
  product_description: {
    label: "Product description",
    expectedCredits: 2,
    fields: [
      {
        key: "description",
        label: "Description",
        required: true,
        multiline: true,
        maxLength: 3_000,
      },
    ],
  },
  product_seo: {
    label: "Product SEO",
    expectedCredits: 1,
    fields: [
      {
        key: "seo_title",
        label: "SEO title",
        required: true,
        multiline: false,
        maxLength: 70,
      },
      {
        key: "seo_description",
        label: "SEO description",
        required: true,
        multiline: true,
        maxLength: 180,
      },
    ],
  },
  blog: {
    label: "Blog post",
    expectedCredits: 5,
    fields: [
      {
        key: "title",
        label: "Title",
        required: true,
        multiline: false,
        maxLength: 200,
      },
      {
        key: "excerpt",
        label: "Excerpt",
        required: true,
        multiline: true,
        maxLength: 500,
      },
      {
        key: "content",
        label: "Draft content",
        required: true,
        multiline: true,
        maxLength: 12_000,
      },
      {
        key: "seo_title",
        label: "SEO title",
        required: false,
        multiline: false,
        maxLength: 70,
      },
      {
        key: "seo_description",
        label: "SEO description",
        required: false,
        multiline: true,
        maxLength: 180,
      },
    ],
  },
  coupon_email: {
    label: "Coupon email",
    expectedCredits: 2,
    fields: [
      {
        key: "subject",
        label: "Subject",
        required: true,
        multiline: false,
        maxLength: 200,
      },
      {
        key: "body",
        label: "Email body",
        required: true,
        multiline: true,
        maxLength: 5_000,
      },
    ],
  },
  customer_message: {
    label: "Customer message",
    expectedCredits: 2,
    fields: [
      {
        key: "subject",
        label: "Subject",
        required: false,
        multiline: false,
        maxLength: 200,
      },
      {
        key: "body",
        label: "Message",
        required: true,
        multiline: true,
        maxLength: 4_000,
      },
    ],
  },
  product_create: {
    label: "Draft product",
    expectedCredits: 3,
    fields: [
      {
        key: "name",
        label: "Product name",
        required: true,
        multiline: false,
        maxLength: 200,
      },
      {
        key: "slug",
        label: "URL slug",
        required: true,
        multiline: false,
        maxLength: 200,
      },
      {
        key: "description",
        label: "Description",
        required: true,
        multiline: true,
        maxLength: 3_000,
      },
      {
        key: "seo_title",
        label: "SEO title",
        required: true,
        multiline: false,
        maxLength: 70,
      },
      {
        key: "seo_description",
        label: "SEO description",
        required: true,
        multiline: true,
        maxLength: 180,
      },
      {
        key: "base_price",
        label: "Base price (INR)",
        required: true,
        multiline: false,
        maxLength: 16,
      },
      {
        key: "selling_price",
        label: "Selling price (INR)",
        required: true,
        multiline: false,
        maxLength: 16,
      },
    ],
  },
  offer_create: offerActionConfig("New disabled offer"),
  offer_update: offerActionConfig("Offer changes"),
  offer_activate: {
    label: "Turn an offer on",
    // ★ NO CREDITS. Activation writes one boolean; charging for it a second
    // time would bill the merchant twice for one piece of work, and the
    // proposal it activates has already been paid for.
    expectedCredits: 0,
    fields: [
      {
        key: "offer_id",
        label: "Offer",
        required: true,
        multiline: false,
        maxLength: 64,
      },
    ],
  },
  coupon_create: couponActionConfig("New disabled coupon"),
  coupon_update: couponActionConfig("Disabled coupon update"),
  customer_group_create: customerGroupActionConfig("New customer group"),
  customer_group_update: customerGroupActionConfig("Customer-group update"),
  inventory_adjustment: {
    label: "Inventory adjustment",
    expectedCredits: 1,
    fields: [
      {
        key: "quantity_change",
        label: "Quantity change (+ add, - remove)",
        required: true,
        multiline: false,
        maxLength: 8,
      },
      {
        key: "reason",
        label: "Reason",
        required: true,
        multiline: false,
        maxLength: 20,
      },
      {
        key: "note",
        label: "Audit note",
        required: false,
        multiline: true,
        maxLength: 200,
      },
    ],
  },
  bulk_inventory_adjustment: {
    label: "Bulk inventory adjustment",
    expectedCredits: 5,
    fields: [
      {
        key: "lines_json",
        label: "Inventory adjustment lines",
        required: true,
        multiline: true,
        maxLength: 16_000,
      },
    ],
  },
  order_status_transition: {
    label: "Order-status transition",
    expectedCredits: 1,
    fields: [
      {
        key: "target_status",
        label: "Target status",
        required: true,
        multiline: false,
        maxLength: 20,
      },
      {
        key: "note",
        label: "Internal audit note",
        required: false,
        multiline: true,
        maxLength: 200,
      },
    ],
  },
  bulk_price_update: {
    label: "Bulk price update",
    expectedCredits: 5,
    fields: [
      {
        key: "lines_json",
        label: "Bulk price lines",
        required: true,
        multiline: true,
        maxLength: 12_000,
      },
    ],
  },
};

/**
 * The fields Mink may set on an offer.
 *
 * ★★ A BUDGET CAP IS MANDATORY (plan §14c). A coupon needs a customer to type
 * it; an automatic offer applies itself to every qualifying order from the
 * instant it goes live, and under best-offer-wins it applies whenever it is the
 * most generous rule present. The cap is the difference between a mistake that
 * costs a bounded amount and one that costs whatever the weekend's traffic was.
 * `required: true` here, and re-checked server-side at preview and execution —
 * the form is not the boundary.
 *
 * ★ THE REWARD SHAPE IS DELIBERATELY NARROW: a percentage or a rupee amount off
 * the order, with an optional minimum. Every richer reward — bundles, gifts,
 * ladders, free delivery — changes stock, liability or delivery cost in ways a
 * single approval screen cannot show honestly, so they stay a human's job. The
 * tool declaration says so, rather than letting the model attempt one and be
 * refused.
 */
function offerActionConfig(label: string) {
  return {
    label,
    expectedCredits: 1,
    fields: [
      {
        key: "name",
        label: "Offer name",
        required: true,
        multiline: false,
        maxLength: 120,
      },
      {
        key: "description",
        label: "Description",
        required: false,
        multiline: true,
        maxLength: 500,
      },
      {
        key: "reward_type",
        label: "Reward",
        required: true,
        multiline: false,
        maxLength: 20,
      },
      {
        key: "reward_value",
        label: "Discount",
        required: true,
        multiline: false,
        maxLength: 16,
      },
      {
        key: "min_subtotal",
        label: "Minimum order value",
        required: false,
        multiline: false,
        maxLength: 16,
      },
      {
        key: "budget",
        label: "Total budget",
        required: true,
        multiline: false,
        maxLength: 16,
      },
      {
        key: "max_redemptions",
        label: "Maximum uses",
        required: false,
        multiline: false,
        maxLength: 16,
      },
      {
        key: "valid_until",
        label: "Ends",
        required: false,
        multiline: false,
        maxLength: 40,
      },
    ],
  };
}

function couponActionConfig(label: string) {
  return {
    label,
    expectedCredits: 1,
    fields: [
      {
        key: "code",
        label: "Coupon code",
        required: true,
        multiline: false,
        maxLength: 100,
      },
      {
        key: "description",
        label: "Description",
        required: false,
        multiline: true,
        maxLength: 500,
      },
      {
        key: "discount_type",
        label: "Discount type",
        required: true,
        multiline: false,
        maxLength: 10,
      },
      {
        key: "discount_value",
        label: "Discount value",
        required: true,
        multiline: false,
        maxLength: 16,
      },
      {
        key: "min_order_amount",
        label: "Minimum order amount",
        required: true,
        multiline: false,
        maxLength: 16,
      },
      {
        key: "max_uses",
        label: "Maximum uses (0 = unlimited)",
        required: true,
        multiline: false,
        maxLength: 12,
      },
      {
        key: "valid_from",
        label: "Valid from (ISO date or empty)",
        required: false,
        multiline: false,
        maxLength: 40,
      },
      {
        key: "valid_until",
        label: "Valid until (ISO date or empty)",
        required: false,
        multiline: false,
        maxLength: 40,
      },
    ],
  };
}

function customerGroupActionConfig(label: string) {
  return {
    label,
    expectedCredits: 1,
    fields: [
      {
        key: "name",
        label: "Group name",
        required: true,
        multiline: false,
        maxLength: 120,
      },
      {
        key: "description",
        label: "Description",
        required: false,
        multiline: true,
        maxLength: 500,
      },
      {
        key: "color",
        label: "Colour",
        required: true,
        multiline: false,
        maxLength: 20,
      },
    ],
  };
}

export function isMinkDraftKind(value: unknown): value is MinkDraftKind {
  return MINK_DRAFT_KINDS.includes(value as MinkDraftKind);
}

export function normalizeMinkDraftContent(
  kind: MinkDraftKind,
  value: unknown,
): MinkDraftContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Draft content must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const result: MinkDraftContent = {};
  for (const field of MINK_DRAFT_CONFIG[kind].fields) {
    const input = raw[field.key];
    if (input !== undefined && typeof input !== "string") {
      throw new Error(`${field.label} must be text.`);
    }
    const text =
      typeof input === "string" ? input.normalize("NFKC").trim() : "";
    if (field.required && !text) {
      throw new Error(`${field.label} is required.`);
    }
    if (text.length > field.maxLength) {
      throw new Error(
        `${field.label} must be at most ${field.maxLength.toLocaleString("en-IN")} characters.`,
      );
    }
    result[field.key] = text;
  }
  if (kind === "inventory_adjustment") {
    const quantityChange = Number(result.quantity_change);
    if (
      !Number.isInteger(quantityChange) ||
      quantityChange === 0 ||
      Math.abs(quantityChange) > 1_000_000
    ) {
      throw new Error(
        "Quantity change must be a non-zero whole number between -1,000,000 and 1,000,000.",
      );
    }
    if (!INVENTORY_ADJUSTMENT_REASONS.includes(result.reason as never)) {
      throw new Error(
        `Reason must be one of: ${INVENTORY_ADJUSTMENT_REASONS.join(", ")}.`,
      );
    }
    if (result.reason === "other" && !result.note) {
      throw new Error("An audit note is required when the reason is other.");
    }
  }
  if (kind === "bulk_inventory_adjustment") {
    const lines = parseMinkBulkInventoryDraftLines(result.lines_json);
    result.lines_json = JSON.stringify(lines);
  }
  if (kind === "bulk_price_update") {
    const lines = parseMinkBulkPriceDraftLines(result.lines_json);
    result.lines_json = JSON.stringify(lines);
  }
  if (
    kind === "order_status_transition" &&
    !["processing", "shipped", "delivered"].includes(result.target_status)
  ) {
    throw new Error(
      "Target status must be one of: processing, shipped, delivered.",
    );
  }
  return result;
}

export const INVENTORY_ADJUSTMENT_REASONS = [
  "correction",
  "received",
  "damaged",
  "found",
  "other",
] as const;

export const MAX_MINK_BULK_INVENTORY_LINES = 20;

export interface MinkBulkInventoryDraftLine {
  sku: string;
  location: string;
  quantity_change: number;
  reason: (typeof INVENTORY_ADJUSTMENT_REASONS)[number];
  note: string;
}

export function parseMinkBulkInventoryDraftLines(
  value: string,
): MinkBulkInventoryDraftLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Bulk inventory lines must be valid JSON.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > MAX_MINK_BULK_INVENTORY_LINES
  ) {
    throw new Error(
      `Bulk inventory requires 1-${MAX_MINK_BULK_INVENTORY_LINES} lines.`,
    );
  }
  const seen = new Set<string>();
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Bulk inventory line ${index + 1} must be an object.`);
    }
    const row = item as Record<string, unknown>;
    const allowed = new Set([
      "sku",
      "location",
      "quantity_change",
      "reason",
      "note",
    ]);
    if (Object.keys(row).some((key) => !allowed.has(key))) {
      throw new Error(
        `Bulk inventory line ${index + 1} contains unsupported fields.`,
      );
    }
    const sku = normalizedBulkText(row.sku, "SKU", index, 100, true);
    const location = normalizedBulkText(
      row.location,
      "location",
      index,
      100,
      true,
    );
    const quantityChange = Number(row.quantity_change);
    if (
      !Number.isInteger(quantityChange) ||
      quantityChange === 0 ||
      Math.abs(quantityChange) > 1_000_000
    ) {
      throw new Error(
        `Bulk inventory line ${index + 1} quantity change must be a non-zero whole number between -1,000,000 and 1,000,000.`,
      );
    }
    const reason = normalizedBulkText(row.reason, "reason", index, 20, true);
    if (!INVENTORY_ADJUSTMENT_REASONS.includes(reason as never)) {
      throw new Error(
        `Bulk inventory line ${index + 1} reason must be one of: ${INVENTORY_ADJUSTMENT_REASONS.join(", ")}.`,
      );
    }
    const note = normalizedBulkText(row.note, "note", index, 200, false);
    if (reason === "other" && !note) {
      throw new Error(
        `Bulk inventory line ${index + 1} needs an audit note when the reason is other.`,
      );
    }
    const key = JSON.stringify([sku, location]);
    if (seen.has(key)) {
      throw new Error(
        `Bulk inventory line ${index + 1} duplicates the same SKU and location. Combine duplicate lines.`,
      );
    }
    seen.add(key);
    return {
      sku,
      location,
      quantity_change: quantityChange,
      reason: reason as MinkBulkInventoryDraftLine["reason"],
      note,
    };
  });
}

function normalizedBulkText(
  value: unknown,
  field: string,
  index: number,
  maxLength: number,
  required: boolean,
) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") {
    throw new Error(`Bulk inventory line ${index + 1} ${field} must be text.`);
  }
  const text = value.normalize("NFKC").trim();
  if ((required && !text) || text.length > maxLength) {
    throw new Error(
      `Bulk inventory line ${index + 1} ${field} must be ${required ? "between 1 and" : "at most"} ${maxLength} characters.`,
    );
  }
  return text;
}

export function minkDraftFields(
  kind: MinkDraftKind,
  content: MinkDraftContent,
): MinkDraftField[] {
  return MINK_DRAFT_CONFIG[kind].fields.map((field) => ({
    key: field.key,
    label: field.label,
    value: content[field.key] ?? "",
    multiline: field.multiline,
    maxLength: field.maxLength,
  }));
}

/** Browser-only hint for the composer. Server-side charging never trusts it. */
export function estimateMinkDraftIntent(message: string): {
  kind: MinkDraftKind;
  label: string;
  expectedCredits: number;
} | null {
  const value = message.trim().toLocaleLowerCase("en-IN");
  if (
    !value ||
    !/\b(draft|write|rewrite|create|add|update|edit|generate|adjust|set|restock|remove|mark|advance|move)\b/.test(
      value,
    )
  ) {
    return null;
  }
  const kind: MinkDraftKind | null =
    /\b(bulk|multiple|many|all)\b.*\b(price|prices|pricing|mrp)\b|\b(price|prices|pricing|mrp)\b.*\b(bulk|multiple|many|all)\b/.test(
      value,
    )
      ? "bulk_price_update"
      : /\b(mark|advance|move|update|set)\b.*\b(order|delivery)\b.*\b(processing|shipped|delivered)\b|\b(order|delivery)\b.*\b(processing|shipped|delivered)\b/.test(
            value,
          )
        ? "order_status_transition"
        : /\b(bulk|multiple|many|all)\b.*\b(stock|inventory|skus?|products?|items?)\b|\b(stock|inventory)\b.*\b(bulk|multiple|many|all)\b/.test(
              value,
            )
          ? "bulk_inventory_adjustment"
          : /\b(adjust|set|restock|remove|add|update)\b.*\b(stock|inventory|units?)\b|\b(stock|inventory)\b.*\b(adjust|set|restock|remove|add|update)\b/.test(
                value,
              )
            ? "inventory_adjustment"
            : /\b(coupon|campaign|promo).*\b(email|mail)|\bemail.*\b(coupon|campaign|promo)/.test(
                  value,
                )
              ? "coupon_email"
              : /\b(create|add|new)\b.*\b(customer )?group\b|\b(customer )?group\b.*\b(create|add|new)\b/.test(
                    value,
                  )
                ? "customer_group_create"
                : /\b(update|edit|rewrite)\b.*\b(customer )?group\b|\b(customer )?group\b.*\b(update|edit|rewrite)\b/.test(
                      value,
                    )
                  ? "customer_group_update"
                  : /\b(create|add|new)\b.*\b(coupon|promo code)\b|\b(coupon|promo code)\b.*\b(create|add|new)\b/.test(
                        value,
                      )
                    ? "coupon_create"
                    : /\b(update|edit)\b.*\b(coupon|promo code)\b|\b(coupon|promo code)\b.*\b(update|edit)\b/.test(
                          value,
                        )
                      ? "coupon_update"
                      : /\b(create|add|new)\b.*\bproduct\b|\bproduct\b.*\b(create|add|new)\b/.test(
                            value,
                          ) && !/\b(description|copy|seo|meta)\b/.test(value)
                        ? "product_create"
                        : /\b(customer|shopper).*\b(message|reply)|\bmessage.*\b(customer|shopper)/.test(
                              value,
                            )
                          ? "customer_message"
                          : /\b(blog|article|post)\b/.test(value)
                            ? "blog"
                            : /\b(seo|meta title|meta description)\b/.test(
                                  value,
                                )
                              ? "product_seo"
                              : /\b(product|description|copy)\b/.test(value)
                                ? "product_description"
                                : null;
  if (!kind) return null;
  const config = MINK_DRAFT_CONFIG[kind];
  return { kind, label: config.label, expectedCredits: config.expectedCredits };
}
