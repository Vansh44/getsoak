import {
  pgTable,
  index,
  foreignKey,
  pgPolicy,
  check,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  uniqueIndex,
  unique,
  numeric,
  jsonb,
  primaryKey,
  pgView,
  bigint,
  pgSequence,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const storeNoSeq = pgSequence("store_no_seq", {
  startWith: "1000",
  increment: "1",
  minValue: "1000",
  maxValue: "2147483647",
  cache: "1",
  cycle: false,
});

export const admins = pgTable(
  "admins",
  {
    id: text().primaryKey().notNull(),
    email: text().notNull(),
    role: text().default("member").notNull(),
    forcePasswordReset: boolean("force_password_reset").default(true).notNull(),
    invitedBy: text("invited_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    isSuspended: boolean("is_suspended").default(false),
    firstName: text("first_name").default("").notNull(),
    lastName: text("last_name"),
    phone: text(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_admins_invited_by").using(
      "btree",
      table.invitedBy.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_admins_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "admins_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.invitedBy],
      foreignColumns: [table.id],
      name: "profiles_invited_by_fkey",
    }).onDelete("set null"),
    pgPolicy("Update admins", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`(( SELECT is_store_superadmin(admins.store_id) AS is_store_superadmin) OR (( SELECT auth.uid() AS uid) = id))`,
    }),
    pgPolicy("Superadmins can insert profiles", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Superadmins can delete profiles", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Read admins", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Auth admin can read admins for token hook", {
      as: "permissive",
      for: "select",
      to: ["supabase_auth_admin"],
    }),
    check(
      "profiles_role_check",
      sql`role = ANY (ARRAY['superadmin'::text, 'member'::text])`,
    ),
  ],
);

export const aiCreditBalances = pgTable(
  "ai_credit_balances",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    balance: integer().default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "ai_credit_balances_store_id_fkey",
    }).onDelete("cascade"),
    check("ai_credit_balances_balance_check", sql`balance >= 0`),
  ],
);

export const aiCreditLedger = pgTable(
  "ai_credit_ledger",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    delta: integer().notNull(),
    kind: text().notNull(),
    ref: text(),
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("ai_credit_ledger_purchase_ref_idx")
      .using(
        "btree",
        table.kind.asc().nullsLast().op("text_ops"),
        table.ref.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(kind = 'purchase'::text)`),
    index("ai_credit_ledger_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "ai_credit_ledger_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "ai_credit_ledger_kind_check",
      sql`kind = ANY (ARRAY['purchase'::text, 'grant'::text, 'spend'::text])`,
    ),
  ],
);

export const aiCreditPurchases = pgTable(
  "ai_credit_purchases",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    packId: text("pack_id").notNull(),
    credits: integer().notNull(),
    amountInr: integer("amount_inr").notNull(),
    rzpOrderId: text("rzp_order_id"),
    rzpPaymentId: text("rzp_payment_id"),
    status: text().default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("ai_credit_purchases_pending_idx")
      .using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(status = 'pending'::text)`),
    index("ai_credit_purchases_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "ai_credit_purchases_store_id_fkey",
    }).onDelete("cascade"),
    unique("ai_credit_purchases_rzp_order_id_key").on(table.rzpOrderId),
    check("ai_credit_purchases_amount_inr_check", sql`amount_inr > 0`),
    check("ai_credit_purchases_credits_check", sql`credits > 0`),
    check(
      "ai_credit_purchases_status_check",
      sql`status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text])`,
    ),
  ],
);

export const billingWebhookEvents = pgTable("billing_webhook_events", {
  eventId: text("event_id").primaryKey().notNull(),
  eventType: text("event_type"),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const blogCategories = pgTable(
  "blog_categories",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    name: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_blog_categories_store_name").using(
      "btree",
      sql`store_id`,
      sql`lower(name)`,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "blog_categories_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Public can read blog categories", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`true`,
    }),
    pgPolicy("Admins can update blog categories", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins can insert blog categories", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins can delete blog categories", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    check(
      "blog_categories_name_check",
      sql`(char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 40)`,
    ),
  ],
);

export const blogComments = pgTable(
  "blog_comments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    blogId: uuid("blog_id").notNull(),
    userId: text("user_id").notNull(),
    authorName: text("author_name").default("").notNull(),
    body: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_blog_comments_blog").using(
      "btree",
      table.blogId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("idx_blog_comments_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_blog_comments_user_id").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.blogId],
      foreignColumns: [blogs.id],
      name: "blog_comments_blog_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "blog_comments_customer_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "blog_comments_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Customers can insert own comment", {
      as: "permissive",
      for: "insert",
      to: ["public"],
      withCheck: sql`((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM users
  WHERE ((users.id = ( SELECT auth.uid() AS uid)) AND (users.store_id = blog_comments.store_id)))))`,
    }),
    pgPolicy("Customers can delete own comment", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Anyone can read blog comments", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    check(
      "blog_comments_body_check",
      sql`(char_length(body) >= 1) AND (char_length(body) <= 2000)`,
    ),
  ],
);

export const blogLikes = pgTable(
  "blog_likes",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    blogId: uuid("blog_id").notNull(),
    visitorId: text("visitor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    reaction: text().default("like").notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_blog_likes_blog").using(
      "btree",
      table.blogId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_blog_likes_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.blogId],
      foreignColumns: [blogs.id],
      name: "blog_likes_blog_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "blog_likes_store_id_fkey",
    }).onDelete("cascade"),
    unique("blog_likes_blog_visitor_reaction_key").on(
      table.blogId,
      table.visitorId,
      table.reaction,
    ),
    pgPolicy("Anyone can read blog likes", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`true`,
    }),
    check(
      "blog_likes_reaction_check",
      sql`reaction = ANY (ARRAY['like'::text, 'love'::text, 'haha'::text, 'wow'::text, 'celebrate'::text])`,
    ),
  ],
);

export const blogTags = pgTable(
  "blog_tags",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    name: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_blog_tags_store_name").using(
      "btree",
      sql`store_id`,
      sql`lower(name)`,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "blog_tags_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Public can read blog tags", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`true`,
    }),
    pgPolicy("Admins can update blog tags", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins can insert blog tags", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins can delete blog tags", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    check(
      "blog_tags_name_check",
      sql`(char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 40)`,
    ),
  ],
);

export const blogs = pgTable(
  "blogs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    title: text().notNull(),
    slug: text().notNull(),
    excerpt: text(),
    content: text(),
    coverImageUrl: text("cover_image_url"),
    author: text(),
    status: text().default("draft").notNull(),
    tags: text().array().default([""]),
    featured: boolean().default(false).notNull(),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    readingTime: integer("reading_time"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    categories: text().array().default([""]),
    submittedBy: text("submitted_by"),
    isCustomerSubmission: boolean("is_customer_submission")
      .default(false)
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_blogs_categories_gin")
      .using("gin", table.categories.asc().nullsLast().op("array_ops"))
      .where(sql`(status = 'published'::text)`),
    index("idx_blogs_created_at").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("idx_blogs_created_by").using(
      "btree",
      table.createdBy.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_blogs_customer_submissions")
      .using("btree", table.submittedBy.asc().nullsLast().op("uuid_ops"))
      .where(sql`(is_customer_submission = true)`),
    index("idx_blogs_featured")
      .using("btree", table.featured.asc().nullsLast().op("bool_ops"))
      .where(sql`(featured = true)`),
    index("idx_blogs_pending_review")
      .using(
        "btree",
        table.status.asc().nullsLast().op("text_ops"),
        table.createdAt.desc().nullsFirst().op("text_ops"),
      )
      .where(sql`(status = 'pending_review'::text)`),
    index("idx_blogs_published")
      .using(
        "btree",
        table.status.asc().nullsLast().op("text_ops"),
        table.publishedAt.desc().nullsFirst().op("text_ops"),
      )
      .where(sql`(status = 'published'::text)`),
    index("idx_blogs_slug").using(
      "btree",
      table.slug.asc().nullsLast().op("text_ops"),
    ),
    index("idx_blogs_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_blogs_submitted_created")
      .using(
        "btree",
        table.submittedBy.asc().nullsLast().op("timestamptz_ops"),
        table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
      )
      .where(sql`(submitted_by IS NOT NULL)`),
    index("idx_blogs_updated_by").using(
      "btree",
      table.updatedBy.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "blogs_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.submittedBy],
      foreignColumns: [users.id],
      name: "blogs_submitted_by_fkey",
    }).onDelete("set null"),
    unique("blogs_store_slug_key").on(table.slug, table.storeId),
    pgPolicy("Update blogs", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`(( SELECT is_store_admin(blogs.store_id) AS is_store_admin) OR ((submitted_by = ( SELECT auth.uid() AS uid)) AND (is_customer_submission = true) AND (status = ANY (ARRAY['draft'::text, 'pending_review'::text]))))`,
      withCheck: sql`(( SELECT is_store_admin(blogs.store_id) AS is_store_admin) OR ((submitted_by = ( SELECT auth.uid() AS uid)) AND (is_customer_submission = true) AND (status = ANY (ARRAY['draft'::text, 'pending_review'::text]))))`,
    }),
    pgPolicy("Read blogs", { as: "permissive", for: "select", to: ["public"] }),
    pgPolicy("Insert blogs", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Delete blogs", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);

export const cardColors = pgTable(
  "card_colors",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    hex: text().notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_card_colors_sort").using(
      "btree",
      table.sortOrder.asc().nullsLast().op("int4_ops"),
    ),
    index("idx_card_colors_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "card_colors_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Anyone can read card_colors", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`true`,
    }),
    pgPolicy("Admins can update card_colors", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins can insert card_colors", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins can delete card_colors", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    description: text(),
    imageUrl: text("image_url"),
    sortOrder: integer("sort_order").default(0).notNull(),
    status: text().default("active").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_categories_slug").using(
      "btree",
      table.slug.asc().nullsLast().op("text_ops"),
    ),
    index("idx_categories_sort").using(
      "btree",
      table.sortOrder.asc().nullsLast().op("int4_ops"),
    ),
    index("idx_categories_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "categories_store_id_fkey",
    }).onDelete("cascade"),
    unique("categories_store_slug_key").on(table.slug, table.storeId),
    pgPolicy("Read categories", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`((status = 'active'::text) OR ( SELECT is_store_admin(categories.store_id) AS is_store_admin))`,
    }),
    pgPolicy("Admins can update categories", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins can insert categories", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins can delete categories", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);

export const coupons = pgTable(
  "coupons",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    code: text().notNull(),
    description: text(),
    discountType: text("discount_type").default("percentage").notNull(),
    discountValue: numeric("discount_value", {
      precision: 10,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    minOrderAmount: numeric("min_order_amount", {
      precision: 10,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    maxUses: integer("max_uses").default(0).notNull(),
    usedCount: integer("used_count").default(0).notNull(),
    status: text().default("active").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "string" }),
    validUntil: timestamp("valid_until", {
      withTimezone: true,
      mode: "string",
    }),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
    showOnStorefront: boolean("show_on_storefront").default(false).notNull(),
  },
  (table) => [
    index("idx_coupons_code").using(
      "btree",
      table.code.asc().nullsLast().op("text_ops"),
    ),
    index("idx_coupons_created_at").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("idx_coupons_created_by").using(
      "btree",
      table.createdBy.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_coupons_status").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("idx_coupons_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_coupons_updated_by").using(
      "btree",
      table.updatedBy.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "coupons_store_id_fkey",
    }).onDelete("cascade"),
    unique("coupons_store_code_key").on(table.code, table.storeId),
    pgPolicy("Read coupons", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`((status = 'active'::text) OR ( SELECT is_store_admin(coupons.store_id) AS is_store_admin))`,
    }),
    pgPolicy("Admins can update coupons", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins can insert coupons", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins can delete coupons", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);

export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: text("user_id").notNull(),
    storeId: uuid("store_id").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text(),
    phone: text(),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    city: text().notNull(),
    state: text().notNull(),
    postalCode: text("postal_code").notNull(),
    country: text().default("India").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_customer_addresses_user").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "customer_addresses_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "customer_addresses_user_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Customers delete own addresses", {
      as: "permissive",
      for: "delete",
      to: ["authenticated"],
      using: sql`(user_id = auth.uid())`,
    }),
    pgPolicy("Customers update own addresses", {
      as: "permissive",
      for: "update",
      to: ["authenticated"],
    }),
    pgPolicy("Customers read own addresses", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
    }),
    pgPolicy("Customers insert own addresses", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
    }),
  ],
);

export const emailCampaignRecipients = pgTable(
  "email_campaign_recipients",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    campaignId: uuid("campaign_id").notNull(),
    email: text().notNull(),
    firstName: text("first_name").default("").notNull(),
    status: text().default("pending").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_ecr_campaign").using(
      "btree",
      table.campaignId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_ecr_pending")
      .using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(status = 'pending'::text)`),
    index("idx_email_campaign_recipients_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.campaignId],
      foreignColumns: [emailCampaigns.id],
      name: "email_campaign_recipients_campaign_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "email_campaign_recipients_store_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const emailCampaigns = pgTable(
  "email_campaigns",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    subject: text().notNull(),
    body: text().notNull(),
    code: text().notNull(),
    discountLabel: text("discount_label").notNull(),
    validUntilLabel: text("valid_until_label"),
    status: text().default("pending").notNull(),
    total: integer().default(0).notNull(),
    sent: integer().default(0).notNull(),
    failed: integer().default(0).notNull(),
    skippedNoEmail: integer("skipped_no_email").default(0).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_email_campaigns_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "email_campaigns_store_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const enquiries = pgTable(
  "enquiries",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    phone: text().notNull(),
    subject: text(),
    message: text().notNull(),
    status: text().default("new").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    subjectDetail: text("subject_detail"),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_enquiries_created_at").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("idx_enquiries_created_by").using(
      "btree",
      table.createdBy.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_enquiries_status").using(
      "btree",
      table.status.asc().nullsLast().op("text_ops"),
    ),
    index("idx_enquiries_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "enquiries_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Users can read own enquiries", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`(( SELECT auth.uid() AS uid) = created_by)`,
    }),
    pgPolicy("Users can insert own enquiry", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins read store enquiries", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
    }),
  ],
);

export const homepageSections = pgTable(
  "homepage_sections",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    type: text().notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    enabled: boolean().default(true).notNull(),
    config: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_homepage_sections_order").using(
      "btree",
      table.sortOrder.asc().nullsLast().op("int4_ops"),
    ),
    index("idx_homepage_sections_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "homepage_sections_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Anyone can read homepage_sections", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`true`,
    }),
    pgPolicy("Admins can update homepage_sections", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins can insert homepage_sections", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins can delete homepage_sections", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    orderId: uuid("order_id").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id"),
    name: text().notNull(),
    variantName: text("variant_name"),
    price: numeric({ precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    quantity: integer().default(1).notNull(),
    total: numeric({ precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    taxRate: numeric("tax_rate", { precision: 6, scale: 3, mode: "number" })
      .default(0)
      .notNull(),
    taxAmount: numeric("tax_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    taxClassName: text("tax_class_name"),
  },
  (table) => [
    index("idx_order_items_order_id").using(
      "btree",
      table.orderId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [orders.id],
      name: "order_items_order_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.productId],
      foreignColumns: [products.id],
      name: "order_items_product_id_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.variantId],
      foreignColumns: [productVariants.id],
      name: "order_items_variant_id_fkey",
    }).onDelete("restrict"),
    pgPolicy("Customers can view own order items", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`(order_id IN ( SELECT orders.id
   FROM orders
  WHERE (orders.customer_id = auth.uid())))`,
    }),
    pgPolicy("Admins can view and manage store order items", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
    }),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    customerId: text("customer_id").notNull(),
    status: text().default("pending").notNull(),
    paymentMethod: text("payment_method").default("cash_on_delivery").notNull(),
    paymentStatus: text("payment_status").default("pending").notNull(),
    shippingAddress: jsonb("shipping_address").notNull(),
    billingAddress: jsonb("billing_address"),
    subtotal: numeric({ precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    tax: numeric({ precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    shipping: numeric({ precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    discount: numeric({ precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    total: numeric({ precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    currency: text().default("INR").notNull(),
    appliedCouponCode: text("applied_coupon_code"),
    notes: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    stockStatus: text("stock_status").default("none").notNull(),
    orderNo: integer("order_no").notNull(),
    orderRef: text("order_ref").notNull(),
    taxInclusive: boolean("tax_inclusive").default(false).notNull(),
    razorpayOrderId: text("razorpay_order_id"),
    razorpayPaymentId: text("razorpay_payment_id"),
  },
  (table) => [
    index("idx_orders_customer_id").using(
      "btree",
      table.customerId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_orders_store_created").using(
      "btree",
      table.storeId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("idx_orders_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("orders_pending_payment_idx")
      .using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops"))
      .where(
        sql`((payment_method = 'razorpay'::text) AND (payment_status = 'pending'::text))`,
      ),
    uniqueIndex("orders_razorpay_order_idx")
      .using("btree", table.razorpayOrderId.asc().nullsLast().op("text_ops"))
      .where(sql`(razorpay_order_id IS NOT NULL)`),
    uniqueIndex("orders_store_order_no_key").using(
      "btree",
      table.storeId.asc().nullsLast().op("int4_ops"),
      table.orderNo.asc().nullsLast().op("int4_ops"),
    ),
    foreignKey({
      columns: [table.customerId],
      foreignColumns: [users.id],
      name: "orders_customer_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "orders_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Customers can view own orders", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`(customer_id = auth.uid())`,
    }),
    pgPolicy("Admins can view and manage store orders", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
    }),
    check(
      "orders_stock_status_check",
      sql`stock_status = ANY (ARRAY['none'::text, 'reserved'::text, 'released'::text])`,
    ),
  ],
);

export const planEvents = pgTable(
  "plan_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    fromPlan: text("from_plan"),
    toPlan: text("to_plan").notNull(),
    source: text().notNull(),
    actor: text(),
    note: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("plan_events_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "plan_events_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "plan_events_source_check",
      sql`source = ANY (ARRAY['operator'::text, 'billing'::text, 'system'::text])`,
    ),
  ],
);

export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    email: text().notNull(),
    role: text().default("member").notNull(),
    permissions: jsonb().default({}).notNull(),
    invitedBy: uuid("invited_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("platform_admins_email_key").on(table.email),
    pgPolicy("Update platform_admins", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`( SELECT is_platform_superadmin() AS is_platform_superadmin)`,
      withCheck: sql`( SELECT is_platform_superadmin() AS is_platform_superadmin)`,
    }),
    pgPolicy("Read platform_admins", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Insert platform_admins", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Delete platform_admins", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    check(
      "platform_admins_role_check",
      sql`role = ANY (ARRAY['superadmin'::text, 'member'::text])`,
    ),
  ],
);

export const productReviews = pgTable(
  "product_reviews",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    productId: uuid("product_id").notNull(),
    userId: text("user_id").notNull(),
    authorName: text("author_name").default("").notNull(),
    rating: integer().notNull(),
    comment: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_product_reviews_product").using(
      "btree",
      table.productId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("uuid_ops"),
    ),
    index("idx_product_reviews_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_product_reviews_user_created").using(
      "btree",
      table.userId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "product_reviews_customer_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.productId],
      foreignColumns: [products.id],
      name: "product_reviews_product_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "product_reviews_store_id_fkey",
    }).onDelete("cascade"),
    unique("product_reviews_product_id_customer_id_key").on(
      table.productId,
      table.userId,
    ),
    pgPolicy("Customers can update own review", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`(user_id = ( SELECT auth.uid() AS uid))`,
      withCheck: sql`(user_id = ( SELECT auth.uid() AS uid))`,
    }),
    pgPolicy("Customers can insert own review", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Customers can delete own review", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Anyone can read reviews", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    check("product_reviews_rating_check", sql`(rating >= 1) AND (rating <= 5)`),
  ],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    productId: uuid("product_id").notNull(),
    name: text().notNull(),
    stock: integer().default(0).notNull(),
    sku: text().notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    basePrice: numeric("base_price", {
      precision: 10,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    sellingPrice: numeric("selling_price", {
      precision: 10,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    imageUrl: text("image_url"),
    images: text().array().default([""]).notNull(),
    specialPrice: numeric("special_price", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    storeId: uuid("store_id").notNull(),
    trackInventory: boolean("track_inventory").default(true).notNull(),
    lowStockThreshold: integer("low_stock_threshold"),
    allowBackorder: boolean("allow_backorder").default(false).notNull(),
    variantNo: integer("variant_no").notNull(),
  },
  (table) => [
    index("idx_product_variants_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_variants_product").using(
      "btree",
      table.productId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_variants_stock").using(
      "btree",
      table.storeId.asc().nullsLast().op("int4_ops"),
      table.stock.asc().nullsLast().op("uuid_ops"),
    ),
    uniqueIndex("pv_store_sku_key").using(
      "btree",
      table.storeId.asc().nullsLast().op("text_ops"),
      table.sku.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.productId],
      foreignColumns: [products.id],
      name: "product_variants_product_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "product_variants_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Read product_variants", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`((EXISTS ( SELECT 1
   FROM products
  WHERE ((products.id = product_variants.product_id) AND (products.status = 'published'::text)))) OR ( SELECT is_store_admin(product_variants.store_id) AS is_store_admin))`,
    }),
    pgPolicy("Admins can update variants", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins can insert variants", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins can delete variants", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    description: text(),
    categoryId: uuid("category_id"),
    imageUrl: text("image_url"),
    images: text().array().default([""]).notNull(),
    status: text().default("draft").notNull(),
    featured: boolean().default(false).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    basePrice: numeric("base_price", {
      precision: 10,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    sellingPrice: numeric("selling_price", {
      precision: 10,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    cardColor: text("card_color"),
    storeId: uuid("store_id").notNull(),
    trackInventory: boolean("track_inventory").default(false).notNull(),
    stock: integer().default(0).notNull(),
    lowStockThreshold: integer("low_stock_threshold"),
    allowBackorder: boolean("allow_backorder").default(false).notNull(),
    sku: text().notNull(),
    skuNo: integer("sku_no").notNull(),
    variantSeq: integer("variant_seq").default(0).notNull(),
    taxClassId: uuid("tax_class_id"),
  },
  (table) => [
    index("idx_products_category").using(
      "btree",
      table.categoryId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_products_created_at").using(
      "btree",
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("idx_products_created_by").using(
      "btree",
      table.createdBy.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_products_featured")
      .using("btree", table.featured.asc().nullsLast().op("bool_ops"))
      .where(sql`(featured = true)`),
    index("idx_products_low_stock")
      .using(
        "btree",
        table.storeId.asc().nullsLast().op("int4_ops"),
        table.stock.asc().nullsLast().op("uuid_ops"),
      )
      .where(sql`track_inventory`),
    index("idx_products_published")
      .using(
        "btree",
        table.status.asc().nullsLast().op("text_ops"),
        table.publishedAt.desc().nullsFirst().op("timestamptz_ops"),
      )
      .where(sql`(status = 'published'::text)`),
    index("idx_products_slug").using(
      "btree",
      table.slug.asc().nullsLast().op("text_ops"),
    ),
    index("idx_products_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_products_store_sort").using(
      "btree",
      table.storeId.asc().nullsLast().op("int4_ops"),
      table.sortOrder.asc().nullsLast().op("uuid_ops"),
      table.createdAt.desc().nullsFirst().op("int4_ops"),
    ),
    index("idx_products_tax_class").using(
      "btree",
      table.taxClassId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_products_updated_by").using(
      "btree",
      table.updatedBy.asc().nullsLast().op("uuid_ops"),
    ),
    uniqueIndex("products_store_sku_key").using(
      "btree",
      table.storeId.asc().nullsLast().op("text_ops"),
      table.sku.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [categories.id],
      name: "products_category_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "products_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.taxClassId],
      foreignColumns: [taxClasses.id],
      name: "products_tax_class_id_fkey",
    }).onDelete("set null"),
    unique("products_store_slug_key").on(table.slug, table.storeId),
    pgPolicy("Read products", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`((status = 'published'::text) OR ( SELECT is_store_admin(products.store_id) AS is_store_admin))`,
    }),
    pgPolicy("Admins can update products", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins can insert products", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins can delete products", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text().primaryKey().notNull(),
    count: integer().default(0).notNull(),
    windowStart: timestamp("window_start", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_rate_limits_window").using(
      "btree",
      table.windowStart.asc().nullsLast().op("timestamptz_ops"),
    ),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    description: text(),
    permissions: jsonb().default({}).notNull(),
    color: text().default("grey").notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_roles_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    uniqueIndex("idx_roles_store_name_lower").using(
      "btree",
      sql`store_id`,
      sql`lower(name)`,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "roles_store_id_fkey",
    }).onDelete("cascade"),
    unique("roles_store_slug_key").on(table.slug, table.storeId),
    pgPolicy("Superadmins can update roles", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`( SELECT is_store_superadmin(roles.store_id) AS is_store_superadmin)`,
      withCheck: sql`( SELECT is_store_superadmin(roles.store_id) AS is_store_superadmin)`,
    }),
    pgPolicy("Superadmins can insert roles", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Superadmins can delete roles", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Authenticated can read roles", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
  ],
);

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id"),
    delta: integer().notNull(),
    reason: text().notNull(),
    balanceAfter: integer("balance_after").notNull(),
    orderId: uuid("order_id"),
    note: text(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_stock_movements_sku").using(
      "btree",
      table.productId.asc().nullsLast().op("timestamptz_ops"),
      table.variantId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("uuid_ops"),
    ),
    index("idx_stock_movements_store").using(
      "btree",
      table.storeId.asc().nullsLast().op("timestamptz_ops"),
      table.createdAt.desc().nullsFirst().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [orders.id],
      name: "stock_movements_order_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.productId],
      foreignColumns: [products.id],
      name: "stock_movements_product_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "stock_movements_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.variantId],
      foreignColumns: [productVariants.id],
      name: "stock_movements_variant_id_fkey",
    }).onDelete("set null"),
    pgPolicy("Store admins can read stock_movements", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`( SELECT is_store_admin(stock_movements.store_id) AS is_store_admin)`,
    }),
  ],
);

export const storeBillingSettings = pgTable(
  "store_billing_settings",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    taxEnabled: boolean("tax_enabled").default(false).notNull(),
    pricesIncludeTax: boolean("prices_include_tax").default(false).notNull(),
    defaultTaxClassId: uuid("default_tax_class_id"),
    businessName: text("business_name"),
    businessAddress: text("business_address"),
    taxId: text("tax_id"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    logoUrl: text("logo_url"),
    invoicePrefix: text("invoice_prefix").default("INV").notNull(),
    accentColor: text("accent_color").default("#111111").notNull(),
    footerNote: text("footer_note"),
    terms: text(),
    template: jsonb().default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.defaultTaxClassId],
      foreignColumns: [taxClasses.id],
      name: "store_billing_settings_default_tax_class_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_billing_settings_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Store admins manage store_billing_settings", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(store_billing_settings.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(store_billing_settings.store_id) AS is_store_admin)`,
    }),
    pgPolicy("Anyone can read store_billing_settings", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
  ],
);

export const storeBrandProfiles = pgTable(
  "store_brand_profiles",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    contentMd: text("content_md").default("").notNull(),
    structured: jsonb().default({}).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_brand_profiles_store_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const storeCounters = pgTable(
  "store_counters",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    orderSeq: integer("order_seq").default(999).notNull(),
    productSeq: integer("product_seq").default(0).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_counters_store_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const storeMenus = pgTable(
  "store_menus",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    header: jsonb().default([]).notNull(),
    footerGroups: jsonb("footer_groups").default([]).notNull(),
    footerLegal: jsonb("footer_legal").default([]).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_menus_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Store admins manage store_menus", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(store_menus.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(store_menus.store_id) AS is_store_admin)`,
    }),
    pgPolicy("Anyone can read store_menus", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
  ],
);

// Per-store media library (images uploaded via /dashboard/media). See
// supabase/media_assets.sql. The object URL is public (public GCS bucket); the
// listing is admin-only (RLS: is_store_admin).
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    url: text().notNull(),
    path: text().notNull(),
    filename: text().default("").notNull(),
    contentType: text("content_type").default("").notNull(),
    sizeBytes: integer("size_bytes").default(0).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("media_assets_store_created_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "media_assets_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Store admins manage media_assets", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(media_assets.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(media_assets.store_id) AS is_store_admin)`,
    }),
  ],
);

export const storePages = pgTable(
  "store_pages",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    slug: text().notNull(),
    title: text().default("").notNull(),
    status: text().default("draft").notNull(),
    seoTitle: text("seo_title").default("").notNull(),
    seoDescription: text("seo_description").default("").notNull(),
    seoNoindex: boolean("seo_noindex").default(false).notNull(),
    sections: jsonb().default([]).notNull(),
    publishedSections: jsonb("published_sections").default([]).notNull(),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_store_pages_store").using(
      "btree",
      table.storeId.asc().nullsLast().op("text_ops"),
      table.status.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_pages_store_id_fkey",
    }).onDelete("cascade"),
    unique("store_pages_store_id_slug_key").on(table.storeId, table.slug),
    pgPolicy("Public read published store_pages", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`((status = 'published'::text) OR ( SELECT is_store_admin(store_pages.store_id) AS is_store_admin))`,
    }),
    pgPolicy("Admins update store_pages", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins insert store_pages", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins delete store_pages", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    check(
      "store_pages_slug_check",
      sql`(slug = ''::text) OR (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)`,
    ),
    check(
      "store_pages_status_check",
      sql`status = ANY (ARRAY['draft'::text, 'published'::text])`,
    ),
  ],
);

export const storePaymentProviders = pgTable(
  "store_payment_providers",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    provider: text().default("razorpay").notNull(),
    keyId: text("key_id").notNull(),
    keySecretEnc: text("key_secret_enc").notNull(),
    enabled: boolean().default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_payment_providers_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "store_payment_providers_provider_check",
      sql`provider = 'razorpay'::text`,
    ),
  ],
);

export const storeSubscriptions = pgTable(
  "store_subscriptions",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    plan: text().notNull(),
    period: text().notNull(),
    rzpSubscriptionId: text("rzp_subscription_id"),
    rzpPlanId: text("rzp_plan_id"),
    status: text().default("created").notNull(),
    currentStart: timestamp("current_start", {
      withTimezone: true,
      mode: "string",
    }),
    currentEnd: timestamp("current_end", {
      withTimezone: true,
      mode: "string",
    }),
    mandateMaxPaise: integer("mandate_max_paise"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    scheduledPlan: text("scheduled_plan"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("store_subscriptions_rzp_idx").using(
      "btree",
      table.rzpSubscriptionId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_subscriptions_store_id_fkey",
    }).onDelete("cascade"),
    unique("store_subscriptions_rzp_subscription_id_key").on(
      table.rzpSubscriptionId,
    ),
    check(
      "store_subscriptions_period_check",
      sql`period = ANY (ARRAY['monthly'::text, 'yearly'::text])`,
    ),
    check(
      "store_subscriptions_plan_check",
      sql`plan = ANY (ARRAY['basic'::text, 'pro'::text])`,
    ),
    check(
      "store_subscriptions_status_check",
      sql`status = ANY (ARRAY['created'::text, 'authenticated'::text, 'active'::text, 'pending'::text, 'halted'::text, 'cancelled'::text, 'completed'::text])`,
    ),
  ],
);

export const stores = pgTable(
  "stores",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    status: text().default("active").notNull(),
    plan: text().default("free").notNull(),
    customDomain: text("custom_domain"),
    settings: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeNo: integer("store_no")
      .default(sql`nextval('store_no_seq'::regclass)`)
      .notNull(),
    planSource: text("plan_source").default("comp").notNull(),
    planExpiresAt: timestamp("plan_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("stores_plan_expiry_idx")
      .using(
        "btree",
        table.planExpiresAt.asc().nullsLast().op("timestamptz_ops"),
      )
      .where(sql`(plan_expires_at IS NOT NULL)`),
    uniqueIndex("stores_store_no_key").using(
      "btree",
      table.storeNo.asc().nullsLast().op("int4_ops"),
    ),
    unique("stores_slug_key").on(table.slug),
    unique("stores_custom_domain_key").on(table.customDomain),
    pgPolicy("Update stores", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`( SELECT is_store_superadmin(stores.id) AS is_store_superadmin)`,
      withCheck: sql`( SELECT is_store_superadmin(stores.id) AS is_store_superadmin)`,
    }),
    pgPolicy("Read stores", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Insert stores", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Delete stores", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    check(
      "stores_plan_check",
      sql`plan = ANY (ARRAY['free'::text, 'basic'::text, 'pro'::text])`,
    ),
    check(
      "stores_plan_source_check",
      sql`plan_source = ANY (ARRAY['comp'::text, 'paid'::text, 'trial'::text])`,
    ),
    check(
      "stores_status_check",
      sql`status = ANY (ARRAY['active'::text, 'suspended'::text, 'pending'::text])`,
    ),
  ],
);

export const taxClasses = pgTable(
  "tax_classes",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    name: text().notNull(),
    rate: numeric({ precision: 6, scale: 3, mode: "number" })
      .default(0)
      .notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_tax_classes_store").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    uniqueIndex("idx_tax_classes_store_name").using(
      "btree",
      sql`store_id`,
      sql`lower(name)`,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "tax_classes_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Store admins manage tax_classes", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(tax_classes.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(tax_classes.store_id) AS is_store_admin)`,
    }),
    pgPolicy("Anyone can read tax_classes", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    check(
      "tax_classes_rate_range",
      sql`(rate >= (0)::numeric) AND (rate <= (100)::numeric)`,
    ),
  ],
);

export const userGroups = pgTable(
  "user_groups",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    description: text(),
    color: text().default("blue").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_user_groups_created_by").using(
      "btree",
      table.createdBy.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_user_groups_name").using(
      "btree",
      table.name.asc().nullsLast().op("text_ops"),
    ),
    index("idx_user_groups_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "user_groups_store_id_fkey",
    }).onDelete("cascade"),
    unique("user_groups_store_name_key").on(table.name, table.storeId),
    pgPolicy("Admins update user_groups", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`( SELECT is_store_admin(user_groups.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(user_groups.store_id) AS is_store_admin)`,
    }),
    pgPolicy("Admins insert user_groups", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins delete user_groups", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
    pgPolicy("Admins can read user_groups", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
  ],
);

export const users = pgTable(
  "users",
  {
    id: text().primaryKey().notNull(),
    phone: text().notNull(),
    email: text(),
    firstName: text("first_name").default("").notNull(),
    lastName: text("last_name"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_users_email_trgm").using(
      "gin",
      table.email.asc().nullsLast().op("gin_trgm_ops"),
    ),
    index("idx_users_first_name_trgm").using(
      "gin",
      table.firstName.asc().nullsLast().op("gin_trgm_ops"),
    ),
    index("idx_users_last_name_trgm").using(
      "gin",
      table.lastName.asc().nullsLast().op("gin_trgm_ops"),
    ),
    index("idx_users_phone_trgm").using(
      "gin",
      table.phone.asc().nullsLast().op("gin_trgm_ops"),
    ),
    index("idx_users_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "users_store_id_fkey",
    }).onDelete("cascade"),
    unique("users_store_phone_key").on(table.phone, table.storeId),
    unique("users_store_email_key").on(table.email, table.storeId),
    pgPolicy("Customers can update own row", {
      as: "permissive",
      for: "update",
      to: ["public"],
      using: sql`(( SELECT auth.uid() AS uid) = id)`,
      withCheck: sql`(( SELECT auth.uid() AS uid) = id)`,
    }),
    pgPolicy("Customers can read own row", {
      as: "permissive",
      for: "select",
      to: ["public"],
    }),
    pgPolicy("Customers can insert own row", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Auth admin can read users for token hook", {
      as: "permissive",
      for: "select",
      to: ["supabase_auth_admin"],
    }),
  ],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    storeId: uuid("store_id").notNull(),
    period: text().notNull(),
    used: integer().default(0).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "ai_usage_store_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.storeId, table.period],
      name: "ai_usage_pkey",
    }),
  ],
);

export const couponUserGroups = pgTable(
  "coupon_user_groups",
  {
    couponId: uuid("coupon_id").notNull(),
    groupId: uuid("group_id").notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_coupon_user_groups_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_cug_coupon").using(
      "btree",
      table.couponId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_cug_group").using(
      "btree",
      table.groupId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.couponId],
      foreignColumns: [coupons.id],
      name: "coupon_user_groups_coupon_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [userGroups.id],
      name: "coupon_user_groups_group_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "coupon_user_groups_store_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.couponId, table.groupId],
      name: "coupon_user_groups_pkey",
    }),
    pgPolicy("Public can read coupon group links", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`true`,
    }),
    pgPolicy("Admins update coupon group links", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins insert coupon group links", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins delete coupon group links", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);

export const razorpayPlans = pgTable(
  "razorpay_plans",
  {
    plan: text().notNull(),
    period: text().notNull(),
    amountPaise: integer("amount_paise").notNull(),
    rzpPlanId: text("rzp_plan_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.plan, table.period, table.amountPaise],
      name: "razorpay_plans_pkey",
    }),
    check(
      "razorpay_plans_period_check",
      sql`period = ANY (ARRAY['monthly'::text, 'yearly'::text])`,
    ),
    check(
      "razorpay_plans_plan_check",
      sql`plan = ANY (ARRAY['basic'::text, 'pro'::text])`,
    ),
  ],
);

export const userGroupMembers = pgTable(
  "user_group_members",
  {
    groupId: uuid("group_id").notNull(),
    userId: text("user_id").notNull(),
    addedBy: text("added_by"),
    addedAt: timestamp("added_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    storeId: uuid("store_id").notNull(),
  },
  (table) => [
    index("idx_ugm_group").using(
      "btree",
      table.groupId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_ugm_user").using(
      "btree",
      table.userId.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_user_group_members_added_by").using(
      "btree",
      table.addedBy.asc().nullsLast().op("uuid_ops"),
    ),
    index("idx_user_group_members_store_id").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "user_group_members_customer_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [userGroups.id],
      name: "user_group_members_group_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "user_group_members_store_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.groupId, table.userId],
      name: "user_group_members_pkey",
    }),
    pgPolicy("Read memberships", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`((( SELECT auth.uid() AS uid) = user_id) OR ( SELECT is_store_admin(user_group_members.store_id) AS is_store_admin))`,
    }),
    pgPolicy("Admins update memberships", {
      as: "permissive",
      for: "update",
      to: ["public"],
    }),
    pgPolicy("Admins insert memberships", {
      as: "permissive",
      for: "insert",
      to: ["public"],
    }),
    pgPolicy("Admins delete memberships", {
      as: "permissive",
      for: "delete",
      to: ["public"],
    }),
  ],
);
export const customerAdmin = pgView("customer_admin", {
  id: text(),
  phone: text(),
  email: text(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  reviewCount: bigint("review_count", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  blogCount: bigint("blog_count", { mode: "number" }),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  activityCount: bigint("activity_count", { mode: "number" }),
  storeId: uuid("store_id"),
}).as(
  sql`SELECT u.id, u.phone, u.email, u.first_name, u.last_name, u.created_at, u.updated_at, COALESCE(r.cnt, 0::bigint) AS review_count, COALESCE(b.cnt, 0::bigint) AS blog_count, COALESCE(r.cnt, 0::bigint) + COALESCE(b.cnt, 0::bigint) AS activity_count, u.store_id FROM users u LEFT JOIN ( SELECT product_reviews.user_id, count(*) AS cnt FROM product_reviews GROUP BY product_reviews.user_id) r ON r.user_id = u.id LEFT JOIN ( SELECT blogs.submitted_by, count(*) AS cnt FROM blogs WHERE blogs.is_customer_submission GROUP BY blogs.submitted_by) b ON b.submitted_by = u.id`,
);

export const enquiryAdmin = pgView("enquiry_admin", {
  id: uuid(),
  name: text(),
  email: text(),
  phone: text(),
  subject: text(),
  message: text(),
  status: text(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }),
  subjectDetail: text("subject_detail"),
  statusRank: integer("status_rank"),
  storeId: uuid("store_id"),
}).as(
  sql`SELECT id, name, email, phone, subject, message, status, created_by, created_at, updated_at, subject_detail, CASE status WHEN 'new'::text THEN 0 WHEN 'in_progress'::text THEN 1 WHEN 'resolved'::text THEN 2 WHEN 'archived'::text THEN 3 ELSE 4 END AS status_rank, store_id FROM enquiries e`,
);

// ─── Help Centre (platform-global; help.storemink.com) ──────────────────────
// StoreMink's own product docs — NOT per-store data, so no store_id (mirrors
// platform_admins). Managed by operators, read publicly. Schema + RLS +
// FTS vector + seed live in supabase/help_centre.sql. The generated `search`
// tsvector column is intentionally absent here (GENERATED ALWAYS, never
// written by the app; search uses a raw sql`` predicate against it).
export const helpCategories = pgTable(
  "help_categories",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    slug: text().notNull(),
    title: text().notNull(),
    description: text(),
    icon: text(),
    position: integer().default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("help_categories_slug_key").on(table.slug),
    index("help_categories_position_idx").on(table.position, table.title),
    pgPolicy("Read help_categories", { for: "select", to: ["public"] }),
    pgPolicy("Write help_categories", {
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_platform_admin())`,
      withCheck: sql`( SELECT is_platform_admin())`,
    }),
  ],
);

export const helpArticles = pgTable(
  "help_articles",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    categoryId: uuid("category_id"),
    slug: text().notNull(),
    title: text().notNull(),
    excerpt: text(),
    body: text(),
    status: text().default("draft").notNull(),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    position: integer().default(0).notNull(),
    viewCount: integer("view_count").default(0).notNull(),
    helpfulYes: integer("helpful_yes").default(0).notNull(),
    helpfulNo: integer("helpful_no").default(0).notNull(),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("help_articles_slug_key").on(table.slug),
    index("help_articles_category_idx").on(
      table.categoryId,
      table.position,
      table.title,
    ),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [helpCategories.id],
      name: "help_articles_category_id_fkey",
    }).onDelete("set null"),
    check(
      "help_articles_status_check",
      sql`status = ANY (ARRAY['draft'::text, 'published'::text])`,
    ),
    pgPolicy("Read help_articles", {
      for: "select",
      to: ["public"],
      using: sql`(status = 'published'::text) OR ( SELECT is_platform_admin())`,
    }),
    pgPolicy("Write help_articles", {
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_platform_admin())`,
      withCheck: sql`( SELECT is_platform_admin())`,
    }),
  ],
);
