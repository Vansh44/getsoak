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
  coupon_create: couponActionConfig("New disabled coupon"),
  coupon_update: couponActionConfig("Disabled coupon update"),
  customer_group_create: customerGroupActionConfig("New customer group"),
  customer_group_update: customerGroupActionConfig("Customer-group update"),
};

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
  return result;
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
    !/\b(draft|write|rewrite|create|add|update|edit|generate)\b/.test(value)
  ) {
    return null;
  }
  const kind: MinkDraftKind | null =
    /\b(coupon|campaign|promo).*\b(email|mail)|\bemail.*\b(coupon|campaign|promo)/.test(
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
                    : /\b(seo|meta title|meta description)\b/.test(value)
                      ? "product_seo"
                      : /\b(product|description|copy)\b/.test(value)
                        ? "product_description"
                        : null;
  if (!kind) return null;
  const config = MINK_DRAFT_CONFIG[kind];
  return { kind, label: config.label, expectedCredits: config.expectedCredits };
}
