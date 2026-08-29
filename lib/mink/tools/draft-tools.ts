import "server-only";

import { and, eq } from "drizzle-orm";
import { coupons, products } from "@/drizzle/schema";
import { withUser } from "@/lib/db/client";
import { createMinkDraftProposal } from "../drafts";
import { MinkToolInputError } from "../errors";
import type { MinkActorContext, MinkArtifact } from "../types";
import type { MinkTool } from "./registry";

const draftingAvailable = (actor: MinkActorContext) =>
  actor.draftingEnabled === true;
const currentProductAvailable = (actor: MinkActorContext) =>
  draftingAvailable(actor) && actor.selectedResource?.type === "product";

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
      "Read the exact existing coupon facts required before drafting a coupon email. Returns an opaque coupon_snapshot that must be passed unchanged to propose_coupon_email. Never infer or alter coupon terms.",
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

export const minkDraftTools = [
  proposeCurrentProductDescriptionTool,
  proposeCurrentProductSeoTool,
  proposeBlogDraftTool,
  getCouponForDraftTool,
  proposeCouponEmailTool,
  proposeCustomerMessageTool,
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
      })
      .from(coupons)
      .where(and(eq(coupons.storeId, actor.storeId), eq(coupons.code, code)))
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
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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
