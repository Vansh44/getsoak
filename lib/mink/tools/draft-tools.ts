import "server-only";

import { and, count, eq } from "drizzle-orm";
import { coupons, products, userGroups } from "@/drizzle/schema";
import { withUser } from "@/lib/db/client";
import { slugify } from "@/lib/slug";
import { limitsFor } from "@/lib/plans";
import { createMinkDraftProposal } from "../drafts";
import { MinkToolInputError } from "../errors";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

const draftingAvailable = (actor: MinkActorContext) =>
  actor.draftingEnabled === true;
const currentProductAvailable = (actor: MinkActorContext) =>
  draftingAvailable(actor) && actor.selectedResource?.type === "product";
const customerGroupCreateAvailable = (actor: MinkActorContext) =>
  draftingAvailable(actor) && limitsFor(actor.effectivePlan).customerGroups;

export const proposeCurrentProductDescriptionTool: MinkTool = {
  declaration: {
    name: "propose_current_product_description",
    description:
      "Create a charged, private product-description proposal for the product currently selected in the dashboard. Use only supplied facts and the trusted brand voice. This does not edit or publish the product; the admin must separately save the private proposal.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Honest product description using only verified facts.",
          minLength: 1,
          maxLength: 3_000,
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "manage" },
  available: currentProductAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const product = await readCurrentProduct(actor);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "product_description",
        title: `Description for ${product.name}`,
        destinationType: "product",
        destinationId: product.id,
        destinationLabel: product.name,
        destinationPath: `/dashboard/products/${product.id}`,
        before: { description: product.description ?? "" },
        content: {
          description: readString(args.description, "description", 3_000),
        },
      }),
    );
  },
};

export const proposeCurrentProductSeoTool: MinkTool = {
  declaration: {
    name: "propose_current_product_seo",
    description:
      "Create a charged, private SEO-title and meta-description proposal for the product currently selected in the dashboard. Never invent product claims. This does not edit or publish the product.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        seo_title: {
          type: "string",
          minLength: 1,
          maxLength: 70,
          description: "Search title, at most 70 characters.",
        },
        seo_description: {
          type: "string",
          minLength: 1,
          maxLength: 180,
          description: "Search description, at most 180 characters.",
        },
      },
      required: ["seo_title", "seo_description"],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "manage" },
  available: currentProductAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const product = await readCurrentProduct(actor);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "product_seo",
        title: `SEO for ${product.name}`,
        destinationType: "product",
        destinationId: product.id,
        destinationLabel: product.name,
        destinationPath: `/dashboard/products/${product.id}`,
        before: {
          seo_title: product.seoTitle ?? "",
          seo_description: product.seoDescription ?? "",
        },
        content: {
          seo_title: readString(args.seo_title, "seo_title", 70),
          seo_description: readString(
            args.seo_description,
            "seo_description",
            180,
          ),
        },
      }),
    );
  },
};

export const proposeBlogDraftTool: MinkTool = {
  declaration: {
    name: "propose_blog_draft",
    description:
      "Create a charged, private and editable blog proposal in the store's brand voice. Use only facts in the conversation or trusted tool results. This does not create or publish a blog post.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        excerpt: { type: "string", minLength: 1, maxLength: 500 },
        content: {
          type: "string",
          minLength: 1,
          maxLength: 12_000,
          description: "Plain Markdown blog body. Do not output HTML.",
        },
        seo_title: { type: "string", maxLength: 70 },
        seo_description: { type: "string", maxLength: 180 },
      },
      required: ["title", "excerpt", "content"],
      additionalProperties: false,
    },
  },
  permission: { section: "blogs", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const title = readString(args.title, "title", 200);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "blog",
        title: `Blog draft: ${title}`,
        destinationType: "blog",
        destinationLabel: "Blogs",
        destinationPath: "/dashboard/blogs",
        content: {
          title,
          excerpt: readString(args.excerpt, "excerpt", 500),
          content: readString(args.content, "content", 12_000),
          seo_title: readOptionalString(args.seo_title, "seo_title", 70),
          seo_description: readOptionalString(
            args.seo_description,
            "seo_description",
            180,
          ),
        },
      }),
    );
  },
};

export const proposeCouponEmailTool: MinkTool = {
  declaration: {
    name: "propose_coupon_email",
    description:
      "Create a charged, private coupon-email proposal for an existing coupon in this store. First call get_coupon_for_draft, then pass its opaque coupon_snapshot unchanged. Pass the visible coupon code, never an ID. Do not claim the email was sent or scheduled.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        coupon_code: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Exact visible coupon code from the user or tool data.",
        },
        coupon_snapshot: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          description:
            "Opaque snapshot returned by get_coupon_for_draft. Pass it unchanged.",
        },
        subject: { type: "string", minLength: 1, maxLength: 200 },
        body: {
          type: "string",
          minLength: 1,
          maxLength: 5_000,
          description: "Plain-text or Markdown email body; never raw HTML.",
        },
      },
      required: ["coupon_code", "coupon_snapshot", "subject", "body"],
      additionalProperties: false,
    },
  },
  permission: { section: "marketing", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const code = readString(args.coupon_code, "coupon_code", 100);
    const coupon = await readCoupon(actor, code);
    const snapshot = readString(args.coupon_snapshot, "coupon_snapshot", 64);
    if (snapshot !== (await couponSnapshot(actor, coupon))) {
      throw new MinkToolInputError(
        "Coupon details changed or were not checked. Call get_coupon_for_draft again before drafting.",
      );
    }
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "coupon_email",
        title: `Coupon email for ${coupon.code}`,
        destinationType: "coupon",
        destinationId: coupon.id,
        destinationLabel: `Coupon ${coupon.code}`,
        destinationPath: `/dashboard/marketing/coupons/${coupon.id}/edit`,
        before: { subject: "", body: "" },
        content: {
          subject: readString(args.subject, "subject", 200),
          body: readString(args.body, "body", 5_000),
        },
      }),
    );
  },
};

export const getCouponForDraftTool: MinkTool = {
  declaration: {
    name: "get_coupon_for_draft",
    description:
      "Read exact existing coupon facts before drafting a coupon email or coupon update. Returns an opaque coupon_snapshot that must be passed unchanged to the matching proposal tool. Never infer or alter coupon terms.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        coupon_code: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Exact visible coupon code, never an ID.",
        },
      },
      required: ["coupon_code"],
      additionalProperties: false,
    },
  },
  permission: { section: "marketing", action: "view" },
  available: draftingAvailable,
  timeoutMs: 5_000,
  async execute(actor, args) {
    const coupon = await readCoupon(
      actor,
      readString(args.coupon_code, "coupon_code", 100),
    );
    return {
      code: coupon.code,
      description: coupon.description,
      status: coupon.status,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      minimumOrderAmount: coupon.minOrderAmount,
      maximumUses: coupon.maxUses,
      validFrom: coupon.validFrom,
      validUntil: coupon.validUntil,
      showOnStorefront: coupon.showOnStorefront,
      coupon_snapshot: await couponSnapshot(actor, coupon),
    };
  },
};

export const proposeCustomerMessageTool: MinkTool = {
  declaration: {
    name: "propose_customer_message",
    description:
      "Create a charged, private reusable customer-message template. Do not accept customer identifiers or personal data, and do not claim it was sent. The admin must copy approved text into a normal StoreMink workflow.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        subject: { type: "string", maxLength: 200 },
        body: {
          type: "string",
          minLength: 1,
          maxLength: 4_000,
          description:
            "Generic message body without a customer's email, phone, address, or account ID.",
        },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  permission: { section: "users", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "customer_message",
        title: "Customer message template",
        destinationType: "customer_message",
        destinationLabel: "Customers",
        destinationPath: "/dashboard/users",
        content: {
          subject: readOptionalString(args.subject, "subject", 200),
          body: readString(args.body, "body", 4_000),
        },
      }),
    );
  },
};

export const proposeProductCreateTool: MinkTool = {
  declaration: {
    name: "propose_product_create",
    description:
      "Create a charged, private proposal for a new draft product. The proposal can later create only an unpublished product with inventory tracking disabled; it cannot publish, add stock, variants, images, categories or tax/shipping settings.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", minLength: 1, maxLength: 3_000 },
        seo_title: { type: "string", minLength: 1, maxLength: 70 },
        seo_description: { type: "string", minLength: 1, maxLength: 180 },
        base_price: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 99_999_999.99,
        },
        selling_price: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 99_999_999.99,
        },
      },
      required: [
        "name",
        "description",
        "seo_title",
        "seo_description",
        "base_price",
        "selling_price",
      ],
      additionalProperties: false,
    },
  },
  permission: { section: "products", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    await assertProductProposalCapacity(actor);
    const name = readString(args.name, "name", 200);
    const proposedSlug = slugify(name).slice(0, 200);
    if (!proposedSlug) {
      throw new MinkToolInputError(
        "The product name must contain letters or numbers so StoreMink can create a URL slug.",
      );
    }
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "product_create",
        title: `New draft product: ${name}`,
        destinationType: "product",
        destinationLabel: "New draft product",
        destinationPath: "/dashboard/products/new",
        content: {
          name,
          slug: proposedSlug,
          description: readString(args.description, "description", 3_000),
          seo_title: readString(args.seo_title, "seo_title", 70),
          seo_description: readString(
            args.seo_description,
            "seo_description",
            180,
          ),
          base_price: readNumberString(args.base_price, "base_price"),
          selling_price: readNumberString(args.selling_price, "selling_price"),
        },
      }),
    );
  },
};

export const proposeCouponCreateTool: MinkTool = {
  declaration: {
    name: "propose_coupon_create",
    description:
      "Create a charged, private proposal for a new coupon. Any later approved action creates it disabled, hidden from the storefront, unused and unrestricted; this tool cannot activate or publish it.",
    parametersJsonSchema: couponActionSchema(false),
  },
  permission: { section: "marketing", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const content = couponProposalContent(args);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "coupon_create",
        title: `New disabled coupon: ${content.code}`,
        destinationType: "coupon",
        destinationLabel: `New coupon ${content.code}`,
        destinationPath: "/dashboard/marketing/coupons/new",
        content,
      }),
    );
  },
};

export const proposeCouponUpdateTool: MinkTool = {
  declaration: {
    name: "propose_coupon_update",
    description:
      "Create a charged, private proposal to edit the terms of an existing disabled coupon. First call get_coupon_for_draft and pass its coupon_snapshot unchanged. This cannot activate, publish, restrict, send or change usage for a coupon.",
    parametersJsonSchema: couponActionSchema(true),
  },
  permission: { section: "marketing", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const currentCode = readString(
      args.current_coupon_code,
      "current_coupon_code",
      100,
    );
    const coupon = await readCoupon(actor, currentCode);
    if (coupon.status !== "disabled" || coupon.showOnStorefront) {
      throw new MinkToolInputError(
        "Coupon terms can be proposed for a live action only after the coupon is disabled and hidden from the storefront.",
      );
    }
    const snapshot = readString(args.coupon_snapshot, "coupon_snapshot", 64);
    if (snapshot !== (await couponSnapshot(actor, coupon))) {
      throw new MinkToolInputError(
        "Coupon details changed or were not checked. Call get_coupon_for_draft again before proposing an update.",
      );
    }
    const content = couponProposalContent(args);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "coupon_update",
        title: `Update disabled coupon ${coupon.code}`,
        destinationType: "coupon",
        destinationId: coupon.id,
        destinationLabel: `Coupon ${coupon.code}`,
        destinationPath: `/dashboard/marketing/coupons/${coupon.id}/edit`,
        before: couponDraftValues(coupon),
        content,
      }),
    );
  },
};

export const getCustomerGroupForDraftTool: MinkTool = {
  declaration: {
    name: "get_customer_group_for_draft",
    description:
      "Read an exact customer group by visible name before proposing a metadata update. Returns an opaque group_snapshot. This does not return or change group membership.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        group_name: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["group_name"],
      additionalProperties: false,
    },
  },
  permission: { section: "users", action: "view" },
  available: draftingAvailable,
  timeoutMs: 5_000,
  async execute(actor, args) {
    const group = await readCustomerGroup(
      actor,
      readString(args.group_name, "group_name", 120),
    );
    return {
      name: group.name,
      description: group.description,
      color: group.color,
      group_snapshot: await customerGroupSnapshot(actor, group),
    };
  },
};

export const proposeCustomerGroupCreateTool: MinkTool = {
  declaration: {
    name: "propose_customer_group_create",
    description:
      "Create a charged, private proposal for new customer-group metadata. This does not add customers, restrict coupons or contact anyone.",
    parametersJsonSchema: customerGroupSchema(false),
  },
  permission: { section: "users", action: "manage" },
  available: customerGroupCreateAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const content = customerGroupProposalContent(args);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "customer_group_create",
        title: `New customer group: ${content.name}`,
        destinationType: "customer_group",
        destinationLabel: `New group ${content.name}`,
        destinationPath: "/dashboard/users/user_groups/new",
        content,
      }),
    );
  },
};

export const proposeCustomerGroupUpdateTool: MinkTool = {
  declaration: {
    name: "propose_customer_group_update",
    description:
      "Create a charged, private proposal to update an existing customer group's name, description or colour. First call get_customer_group_for_draft and pass group_snapshot unchanged. This cannot change membership, coupon audiences or contact customers.",
    parametersJsonSchema: customerGroupSchema(true),
  },
  permission: { section: "users", action: "manage" },
  available: draftingAvailable,
  timeoutMs: 8_000,
  artifact: proposalArtifact,
  async execute(actor, args) {
    const currentName = readString(
      args.current_group_name,
      "current_group_name",
      120,
    );
    const group = await readCustomerGroup(actor, currentName);
    const snapshot = readString(args.group_snapshot, "group_snapshot", 64);
    if (snapshot !== (await customerGroupSnapshot(actor, group))) {
      throw new MinkToolInputError(
        "Customer-group details changed or were not checked. Call get_customer_group_for_draft again before proposing an update.",
      );
    }
    const content = customerGroupProposalContent(args);
    return proposalOutput(
      await createMinkDraftProposal({
        actor,
        kind: "customer_group_update",
        title: `Update customer group ${group.name}`,
        destinationType: "customer_group",
        destinationId: group.id,
        destinationLabel: `Customer group ${group.name}`,
        destinationPath: `/dashboard/users/user_groups/${group.id}/edit`,
        before: customerGroupDraftValues(group),
        content,
      }),
    );
  },
};

export const minkDraftTools = [
  proposeCurrentProductDescriptionTool,
  proposeCurrentProductSeoTool,
  proposeBlogDraftTool,
  getCouponForDraftTool,
  proposeCouponEmailTool,
  proposeCustomerMessageTool,
  proposeProductCreateTool,
  proposeCouponCreateTool,
  proposeCouponUpdateTool,
  getCustomerGroupForDraftTool,
  proposeCustomerGroupCreateTool,
  proposeCustomerGroupUpdateTool,
];

async function readCoupon(actor: MinkActorContext, code: string) {
  const rows = await withActor(actor, (db) =>
    db
      .select({
        id: coupons.id,
        code: coupons.code,
        description: coupons.description,
        status: coupons.status,
        discountType: coupons.discountType,
        discountValue: coupons.discountValue,
        minOrderAmount: coupons.minOrderAmount,
        maxUses: coupons.maxUses,
        validFrom: coupons.validFrom,
        validUntil: coupons.validUntil,
        showOnStorefront: coupons.showOnStorefront,
        updatedAt: coupons.updatedAt,
      })
      .from(coupons)
      .where(
        and(
          eq(coupons.storeId, actor.storeId),
          eq(coupons.code, normalizeCouponCode(code)),
        ),
      )
      .limit(1),
  );
  if (!rows[0]) {
    throw new MinkToolInputError(
      "That coupon code was not found in the current store.",
    );
  }
  return rows[0];
}

async function couponSnapshot(
  actor: MinkActorContext,
  coupon: Awaited<ReturnType<typeof readCoupon>>,
) {
  const encoded = new TextEncoder().encode(
    JSON.stringify([
      actor.storeId,
      coupon.id,
      coupon.code,
      coupon.description,
      coupon.status,
      coupon.discountType,
      coupon.discountValue,
      coupon.minOrderAmount,
      coupon.maxUses,
      coupon.validFrom,
      coupon.validUntil,
      coupon.showOnStorefront,
      coupon.updatedAt,
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function readCustomerGroup(actor: MinkActorContext, name: string) {
  const rows = await withActor(actor, (db) =>
    db
      .select({
        id: userGroups.id,
        name: userGroups.name,
        description: userGroups.description,
        color: userGroups.color,
        updatedAt: userGroups.updatedAt,
      })
      .from(userGroups)
      .where(
        and(eq(userGroups.storeId, actor.storeId), eq(userGroups.name, name)),
      )
      .limit(1),
  );
  if (!rows[0]) {
    throw new MinkToolInputError(
      "That customer-group name was not found in the current store.",
    );
  }
  return rows[0];
}

async function customerGroupSnapshot(
  actor: MinkActorContext,
  group: Awaited<ReturnType<typeof readCustomerGroup>>,
) {
  return sha256([
    actor.storeId,
    group.id,
    group.name,
    group.description,
    group.color,
    group.updatedAt,
  ]);
}

async function readCurrentProduct(actor: MinkActorContext) {
  if (actor.selectedResource?.type !== "product") {
    throw new MinkToolInputError(
      "Open a product before requesting this draft.",
    );
  }
  const rows = await withActor(actor, (db) =>
    db
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        description: products.description,
        seoTitle: products.seoTitle,
        seoDescription: products.seoDescription,
      })
      .from(products)
      .where(
        and(
          eq(products.id, actor.selectedResource!.id),
          eq(products.storeId, actor.storeId),
        ),
      )
      .limit(1),
  );
  if (!rows[0]) {
    throw new MinkToolInputError(
      "The selected product is not available in this store.",
    );
  }
  return rows[0];
}

function withActor<T>(
  actor: MinkActorContext,
  fn: Parameters<typeof withUser<T>>[1],
): Promise<T> {
  return withUser({ uid: actor.adminId, email: actor.email }, fn);
}

function proposalOutput(proposal: MinkArtifact): Record<string, unknown> {
  return { proposal };
}

function proposalArtifact(output: Record<string, unknown>) {
  const proposal = output.proposal as MinkArtifact | undefined;
  return proposal?.type === "proposal" ? proposal : undefined;
}

function readString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string") {
    throw new MinkToolInputError(`${field} must be text.`);
  }
  const result = value.normalize("NFKC").trim();
  if (!result || result.length > maxLength) {
    throw new MinkToolInputError(
      `${field} must be between 1 and ${maxLength.toLocaleString("en-IN")} characters.`,
    );
  }
  return result;
}

function readOptionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > maxLength) {
    throw new MinkToolInputError(
      `${field} must be at most ${maxLength.toLocaleString("en-IN")} characters.`,
    );
  }
  return value.normalize("NFKC").trim();
}

function readNumberString(value: unknown, field: string) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new MinkToolInputError(`${field} must be a number.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 99_999_999.99) {
    throw new MinkToolInputError(`${field} is outside the supported range.`);
  }
  return String(Math.round(number * 100) / 100);
}

function readIntegerString(value: unknown, field: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1_000_000_000) {
    throw new MinkToolInputError(
      `${field} must be a non-negative whole number.`,
    );
  }
  return String(number);
}

function couponActionSchema(updating: boolean) {
  const properties: Record<string, unknown> = {
    code: { type: "string", minLength: 1, maxLength: 100 },
    description: { type: "string", maxLength: 500 },
    discount_type: { type: "string", enum: ["percentage", "fixed"] },
    discount_value: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
    },
    min_order_amount: { type: "number", minimum: 0, maximum: 99_999_999.99 },
    max_uses: { type: "integer", minimum: 0, maximum: 1_000_000_000 },
    valid_from: { type: "string", maxLength: 40 },
    valid_until: { type: "string", maxLength: 40 },
  };
  const required = [
    "code",
    "discount_type",
    "discount_value",
    "min_order_amount",
    "max_uses",
  ];
  if (updating) {
    properties.current_coupon_code = {
      type: "string",
      minLength: 1,
      maxLength: 100,
    };
    properties.coupon_snapshot = {
      type: "string",
      minLength: 64,
      maxLength: 64,
    };
    required.push("current_coupon_code", "coupon_snapshot");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function couponProposalContent(args: Record<string, unknown>) {
  const type = readString(args.discount_type, "discount_type", 10);
  if (type !== "percentage" && type !== "fixed") {
    throw new MinkToolInputError("discount_type must be percentage or fixed.");
  }
  return {
    code: normalizeCouponCode(readString(args.code, "code", 100)),
    description: readOptionalString(args.description, "description", 500),
    discount_type: type,
    discount_value: readNumberString(args.discount_value, "discount_value"),
    min_order_amount: readNumberString(
      args.min_order_amount,
      "min_order_amount",
    ),
    max_uses: readIntegerString(args.max_uses, "max_uses"),
    valid_from: readOptionalString(args.valid_from, "valid_from", 40),
    valid_until: readOptionalString(args.valid_until, "valid_until", 40),
  };
}

function couponDraftValues(coupon: Awaited<ReturnType<typeof readCoupon>>) {
  return {
    code: coupon.code,
    description: coupon.description ?? "",
    discount_type: coupon.discountType,
    discount_value: String(coupon.discountValue),
    min_order_amount: String(coupon.minOrderAmount),
    max_uses: String(coupon.maxUses),
    valid_from: coupon.validFrom ?? "",
    valid_until: coupon.validUntil ?? "",
  };
}

function customerGroupSchema(updating: boolean) {
  const properties: Record<string, unknown> = {
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", maxLength: 500 },
    color: {
      type: "string",
      enum: ["blue", "green", "amber", "violet", "grey"],
    },
  };
  const required = ["name", "color"];
  if (updating) {
    properties.current_group_name = {
      type: "string",
      minLength: 1,
      maxLength: 120,
    };
    properties.group_snapshot = {
      type: "string",
      minLength: 64,
      maxLength: 64,
    };
    required.push("current_group_name", "group_snapshot");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function customerGroupProposalContent(args: Record<string, unknown>) {
  return {
    name: readString(args.name, "name", 120),
    description: readOptionalString(args.description, "description", 500),
    color: readString(args.color, "color", 20),
  };
}

function customerGroupDraftValues(
  group: Awaited<ReturnType<typeof readCustomerGroup>>,
) {
  return {
    name: group.name,
    description: group.description ?? "",
    color: group.color,
  };
}

function normalizeCouponCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

async function assertProductProposalCapacity(actor: MinkActorContext) {
  const limit = limitsFor(actor.effectivePlan).maxProducts;
  if (limit === null) return;
  const rows = await withActor(actor, (db) =>
    db
      .select({ n: count() })
      .from(products)
      .where(eq(products.storeId, actor.storeId)),
  );
  if ((rows[0]?.n ?? 0) >= limit) {
    throw new MinkToolInputError(
      "This store has reached its current product limit. Upgrade before creating a product proposal so no draft credits are charged for an action that cannot run.",
    );
  }
}

async function sha256(value: unknown[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
