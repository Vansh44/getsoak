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
    // The optional product-updates box at signup — a preference, not a
    // contract (see supabase/legal_01_schema.sql).
    marketingOptIn: boolean("marketing_opt_in").default(false).notNull(),
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
    invoiceId: uuid("invoice_id"),
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

// ─── Billing (docs/billing-architecture.md) ──────────────────────────────────
// Money is bigint PAISE everywhere, mode:"number" — JS integers are exact to
// 2^53, which is ₹90 trillion. Never numeric, never a float.
// All of these are service-role only (RLS on, no policies): they are financial
// records and carry merchant legal identity.

export const billingAccounts = pgTable(
  "billing_accounts",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    billingEmail: text("billing_email"),
    legalName: text("legal_name"),
    address: jsonb().default({}).notNull(),
    /** The MERCHANT's GSTIN — printed on their invoice so they can claim ITC. */
    gstin: text(),
    stateCode: text("state_code"),
    currency: text().default("INR").notNull(),
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
      name: "billing_accounts_store_id_fkey",
    }).onDelete("cascade"),
    check("billing_accounts_currency_check", sql`currency = 'INR'::text`),
    // ★★ NUMERIC GST state code ("07", "29"), never "DL"/"KA". A rejected code
    // makes isIntraState fall back to INTRA-state — the wrong tax head for
    // platform billing, silently, on every invoice.
    check(
      "billing_accounts_state_code_numeric",
      sql`(state_code IS NULL) OR (state_code ~ '^[0-9]{2}$'::text)`,
    ),
  ],
);

/** Append-only account credits. Chiefly: money that arrived AFTER a downgrade,
 *  which settles no service period and becomes credit instead (§7). */
export const billingCredits = pgTable(
  "billing_credits",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    deltaPaise: bigint("delta_paise", { mode: "number" }).notNull(),
    kind: text().notNull(),
    ref: text(),
    note: text(),
    invoiceId: uuid("invoice_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("billing_credits_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    // A replayed webhook credits once.
    uniqueIndex("billing_credits_ref_key")
      .using(
        "btree",
        table.storeId.asc().nullsLast().op("uuid_ops"),
        table.kind.asc().nullsLast().op("text_ops"),
        table.ref.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(ref IS NOT NULL)`),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "billing_credits_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.invoiceId],
      foreignColumns: [billingInvoices.id],
      name: "billing_credits_invoice_id_fkey",
    }).onDelete("set null"),
    check("billing_credits_delta_paise_check", sql`delta_paise <> 0`),
    check(
      "billing_credits_kind_check",
      sql`kind = ANY (ARRAY['late_payment'::text, 'goodwill'::text, 'adjustment'::text, 'applied'::text])`,
    ),
  ],
);

/** Gapless GST document series, one counter per Indian financial year. */
export const billingInvoiceCounters = pgTable(
  "billing_invoice_counters",
  {
    fyLabel: text("fy_label").primaryKey().notNull(),
    nextSeq: integer("next_seq").default(1).notNull(),
  },
  () => [check("billing_invoice_counters_next_seq_check", sql`next_seq >= 1`)],
);

export const billingInvoiceItems = pgTable(
  "billing_invoice_items",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    kind: text().notNull(),
    description: text().notNull(),
    quantity: integer().default(1).notNull(),
    unitAmountPaise: bigint("unit_amount_paise", { mode: "number" }).notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("billing_invoice_items_invoice_idx").using(
      "btree",
      table.invoiceId.asc().nullsLast().op("uuid_ops"),
      table.sortOrder.asc().nullsLast().op("int4_ops"),
    ),
    foreignKey({
      columns: [table.invoiceId],
      foreignColumns: [billingInvoices.id],
      name: "billing_invoice_items_invoice_id_fkey",
    }).onDelete("cascade"),
    check("billing_invoice_items_quantity_check", sql`quantity > 0`),
    check(
      "billing_invoice_items_kind_check",
      sql`kind = ANY (ARRAY['base_plan'::text, 'location'::text, 'addon'::text, 'proration'::text, 'discount'::text, 'tax'::text, 'account_credit'::text, 'ai_credits'::text])`,
    ),
  ],
);

export const billingInvoices = pgTable(
  "billing_invoices",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    /** 'subscription' | 'ai_credits' — never the same document (spec §1). */
    kind: text().notNull(),
    status: text().default("draft").notNull(),
    subtotalPaise: bigint("subtotal_paise", { mode: "number" })
      .default(0)
      .notNull(),
    discountPaise: bigint("discount_paise", { mode: "number" })
      .default(0)
      .notNull(),
    taxPaise: bigint("tax_paise", { mode: "number" }).default(0).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).default(0).notNull(),
    currency: text().default("INR").notNull(),
    /** Null until finalized. Allocated by trigger, never by app code (§6). */
    invoiceNo: integer("invoice_no"),
    invoiceRef: text("invoice_ref"),
    fyLabel: text("fy_label"),
    /** The renewal invoice's idempotency key. Null for ai_credits. */
    cycleSeq: integer("cycle_seq"),
    addonTargetCount: integer("addon_target_count"),
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "string",
    }),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "string" }),
    taxRateBps: integer("tax_rate_bps"),
    placeOfSupply: text("place_of_supply"),
    supplierGstin: text("supplier_gstin"),
    customerGstin: text("customer_gstin"),
    finalizedAt: timestamp("finalized_at", {
      withTimezone: true,
      mode: "string",
    }),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("billing_invoices_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("billing_invoices_open_idx")
      .using("btree", table.dueAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(status = ANY (ARRAY['open'::text, 'processing'::text]))`),
    // ★ Two renewal workers cannot both create an invoice for one cycle (§35).
    uniqueIndex("billing_invoices_one_per_cycle")
      .using(
        "btree",
        table.storeId.asc().nullsLast().op("uuid_ops"),
        table.kind.asc().nullsLast().op("text_ops"),
        table.cycleSeq.asc().nullsLast().op("int4_ops"),
      )
      .where(sql`(cycle_seq IS NOT NULL)`),
    uniqueIndex("billing_invoices_ref_key")
      .using("btree", table.invoiceRef.asc().nullsLast().op("text_ops"))
      .where(sql`(invoice_ref IS NOT NULL)`),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "billing_invoices_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "billing_invoices_kind_check",
      sql`kind = ANY (ARRAY['subscription'::text, 'ai_credits'::text])`,
    ),
    check(
      "billing_invoices_status_check",
      sql`status = ANY (ARRAY['draft'::text, 'open'::text, 'processing'::text, 'paid'::text, 'uncollectible'::text, 'void'::text, 'refunded'::text, 'partially_refunded'::text])`,
    ),
    check("billing_invoices_currency_check", sql`currency = 'INR'::text`),
    check("billing_invoices_subtotal_paise_check", sql`subtotal_paise >= 0`),
    check("billing_invoices_discount_paise_check", sql`discount_paise >= 0`),
    check("billing_invoices_tax_paise_check", sql`tax_paise >= 0`),
    check("billing_invoices_total_paise_check", sql`total_paise >= 0`),
    check(
      "billing_invoices_cycle_seq_check",
      sql`(cycle_seq IS NULL) OR (cycle_seq >= 0)`,
    ),
    // A finalized invoice HAS a number; a draft does not. Both directions.
    check(
      "billing_invoices_number_iff_finalized",
      sql`(finalized_at IS NULL) = (invoice_ref IS NULL)`,
    ),
    check(
      "billing_invoices_total_adds_up",
      sql`total_paise = ((subtotal_paise - discount_paise) + tax_paise)`,
    ),
    check(
      "billing_invoices_kind_shape",
      sql`((kind = 'subscription'::text) AND (cycle_seq IS NOT NULL)) OR ((kind = 'ai_credits'::text) AND (cycle_seq IS NULL))`,
    ),
  ],
);

export const billingMandates = pgTable(
  "billing_mandates",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    provider: text().default("razorpay").notNull(),
    providerCustomerId: text("provider_customer_id"),
    providerTokenId: text("provider_token_id"),
    /** card | upi | emandate | nach | unknown. `unknown` means VERIFY (§17). */
    method: text().default("unknown").notNull(),
    status: text().default("pending").notNull(),
    /** Read back from the token, never computed by us. */
    maxAmountPaise: bigint("max_amount_paise", { mode: "number" }),
    authenticatedAt: timestamp("authenticated_at", {
      withTimezone: true,
      mode: "string",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    /** Reconciliation fields only. NEVER credentials or card data. */
    providerMetadata: jsonb("provider_metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("billing_mandates_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    uniqueIndex("billing_mandates_token_key")
      .using(
        "btree",
        table.provider.asc().nullsLast().op("text_ops"),
        table.providerTokenId.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(provider_token_id IS NOT NULL)`),
    // ★ At most one active mandate per store — otherwise nothing knows which
    // instrument to debit.
    uniqueIndex("billing_mandates_one_active")
      .using("btree", table.storeId.asc().nullsLast().op("uuid_ops"))
      .where(sql`(status = 'active'::text)`),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "billing_mandates_store_id_fkey",
    }).onDelete("cascade"),
    check("billing_mandates_provider_check", sql`provider = 'razorpay'::text`),
    check(
      "billing_mandates_method_check",
      sql`method = ANY (ARRAY['card'::text, 'upi'::text, 'emandate'::text, 'nach'::text, 'unknown'::text])`,
    ),
    check(
      "billing_mandates_status_check",
      sql`status = ANY (ARRAY['pending'::text, 'active'::text, 'expired'::text, 'revoked'::text, 'failed'::text, 'unknown'::text])`,
    ),
    check(
      "billing_mandates_max_amount_paise_check",
      sql`(max_amount_paise IS NULL) OR (max_amount_paise > 0)`,
    ),
  ],
);

export const billingPaymentAttempts = pgTable(
  "billing_payment_attempts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    storeId: uuid("store_id").notNull(),
    /** OURS, minted BEFORE the gateway call — you cannot key on a provider id
     *  you do not have yet, and a timeout looks like a success you never read. */
    idempotencyKey: text("idempotency_key").notNull(),
    mode: text().notNull(),
    /** Monotonic: captured/refunded are terminal, so a late `failed` is
     *  rejected by the state machine rather than by comparing clocks (§4). */
    state: text().default("created").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    currency: text().default("INR").notNull(),
    mandateId: uuid("mandate_id"),
    provider: text().default("razorpay").notNull(),
    providerOrderId: text("provider_order_id"),
    providerPaymentId: text("provider_payment_id"),
    providerTokenId: text("provider_token_id"),
    failureCode: text("failure_code"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("billing_payment_attempts_invoice_idx").using(
      "btree",
      table.invoiceId.asc().nullsLast().op("uuid_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("billing_payment_attempts_unresolved_idx")
      .using("btree", table.updatedAt.asc().nullsLast().op("timestamptz_ops"))
      .where(
        sql`(state = ANY (ARRAY['processing'::text, 'authorized'::text, 'unknown'::text]))`,
      ),
    // ★★ Three clicks on Pay, or a retry racing a manual payment, cannot make
    // two in-flight attempts — the second INSERT fails (§28, §36).
    uniqueIndex("billing_payment_attempts_one_in_flight")
      .using("btree", table.invoiceId.asc().nullsLast().op("uuid_ops"))
      .where(
        sql`(state = ANY (ARRAY['created'::text, 'processing'::text, 'authorized'::text]))`,
      ),
    uniqueIndex("billing_payment_attempts_provider_payment_key")
      .using(
        "btree",
        table.provider.asc().nullsLast().op("text_ops"),
        table.providerPaymentId.asc().nullsLast().op("text_ops"),
      )
      .where(sql`(provider_payment_id IS NOT NULL)`),
    foreignKey({
      columns: [table.invoiceId],
      foreignColumns: [billingInvoices.id],
      name: "billing_payment_attempts_invoice_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "billing_payment_attempts_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.mandateId],
      foreignColumns: [billingMandates.id],
      name: "billing_payment_attempts_mandate_id_fkey",
    }).onDelete("set null"),
    unique("billing_payment_attempts_idempotency_key_key").on(
      table.idempotencyKey,
    ),
    check(
      "billing_payment_attempts_mode_check",
      sql`mode = ANY (ARRAY['automatic'::text, 'manual'::text])`,
    ),
    check(
      "billing_payment_attempts_state_check",
      sql`state = ANY (ARRAY['created'::text, 'processing'::text, 'authorized'::text, 'captured'::text, 'failed'::text, 'cancelled'::text, 'refunded'::text, 'unknown'::text])`,
    ),
    check(
      "billing_payment_attempts_currency_check",
      sql`currency = 'INR'::text`,
    ),
    check(
      "billing_payment_attempts_provider_check",
      sql`provider = 'razorpay'::text`,
    ),
    check("billing_payment_attempts_amount_paise_check", sql`amount_paise > 0`),
    check(
      "billing_payment_attempts_resolved_shape",
      sql`((state = ANY (ARRAY['captured'::text, 'failed'::text, 'cancelled'::text, 'refunded'::text])) AND (resolved_at IS NOT NULL)) OR ((state = ANY (ARRAY['created'::text, 'processing'::text, 'authorized'::text, 'unknown'::text])) AND (resolved_at IS NULL))`,
    ),
  ],
);

/** Ambiguity lands here and is never guessed (Rule 10). */
export const billingReconciliationItems = pgTable(
  "billing_reconciliation_items",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    /** Nullable: an orphan gateway payment may map to no store yet, which is
     *  exactly why it needs reviewing (§46, §47). */
    storeId: uuid("store_id"),
    kind: text().notNull(),
    status: text().default("open").notNull(),
    invoiceId: uuid("invoice_id"),
    attemptId: uuid("attempt_id"),
    providerPaymentId: text("provider_payment_id"),
    providerOrderId: text("provider_order_id"),
    expectedPaise: bigint("expected_paise", { mode: "number" }),
    observedPaise: bigint("observed_paise", { mode: "number" }),
    detail: jsonb().default({}).notNull(),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", {
      withTimezone: true,
      mode: "string",
    }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("billing_reconciliation_open_idx")
      .using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(status = ANY (ARRAY['open'::text, 'manual_review'::text]))`),
    // The detectors re-run continuously; without this one unresolved mismatch
    // would create a row every pass and bury the queue it exists to surface.
    uniqueIndex("billing_reconciliation_open_key")
      .using(
        "btree",
        table.kind.asc().nullsLast().op("text_ops"),
        table.providerPaymentId.asc().nullsLast().op("text_ops"),
      )
      .where(
        sql`((status = 'open'::text) AND (provider_payment_id IS NOT NULL))`,
      ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "billing_reconciliation_items_store_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.invoiceId],
      foreignColumns: [billingInvoices.id],
      name: "billing_reconciliation_items_invoice_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.attemptId],
      foreignColumns: [billingPaymentAttempts.id],
      name: "billing_reconciliation_items_attempt_id_fkey",
    }).onDelete("set null"),
    check(
      "billing_reconciliation_items_kind_check",
      sql`kind = ANY (ARRAY['unknown_payment'::text, 'orphan_payment'::text, 'amount_mismatch'::text, 'missing_webhook'::text, 'state_conflict'::text, 'wrong_association'::text, 'credit_grant_failed'::text])`,
    ),
    check(
      "billing_reconciliation_items_status_check",
      sql`status = ANY (ARRAY['open'::text, 'resolved'::text, 'manual_review'::text, 'ignored'::text])`,
    ),
    check(
      "billing_reconciliation_resolved_shape",
      sql`(status = 'resolved'::text) = (resolved_at IS NOT NULL)`,
    ),
  ],
);

export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    plan: text().notNull(),
    period: text().default("monthly").notNull(),
    /** OUR state machine, not Razorpay's (§4). */
    state: text().default("free").notNull(),
    /** Monotonic. The renewal invoice's idempotency key. */
    currentCycleSeq: integer("current_cycle_seq").default(0).notNull(),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
      mode: "string",
    }),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
      mode: "string",
    }),
    billedLocations: integer("billed_locations").default(0).notNull(),
    scheduledPlan: text("scheduled_plan"),
    scheduledPeriod: text("scheduled_period"),
    scheduledLocations: integer("scheduled_locations"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
    /** Set when a payment is KNOWN to have failed — never on invoice creation
     *  (§68) and never on an `unknown` outcome (Rule 6). */
    graceStartedAt: timestamp("grace_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    graceEndsAt: timestamp("grace_ends_at", {
      withTimezone: true,
      mode: "string",
    }),
    downgradedAt: timestamp("downgraded_at", {
      withTimezone: true,
      mode: "string",
    }),
    mandateId: uuid("mandate_id"),
    /** A comped store has no mandate and no invoice: the renewal worker skips
     *  it and the downgrade claim excludes it. */
    planSource: text("plan_source").default("comp").notNull(),
    planExpiresAt: timestamp("plan_expires_at", {
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
    index("billing_subscriptions_renewal_idx")
      .using(
        "btree",
        table.currentPeriodStart.asc().nullsLast().op("timestamptz_ops"),
      )
      .where(
        sql`(state = ANY (ARRAY['active'::text, 'past_due'::text, 'grace'::text]))`,
      ),
    index("billing_subscriptions_grace_idx")
      .using("btree", table.graceEndsAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(state = ANY (ARRAY['past_due'::text, 'grace'::text]))`),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "billing_subscriptions_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.mandateId],
      foreignColumns: [billingMandates.id],
      name: "billing_subscriptions_mandate_id_fkey",
    }).onDelete("set null"),
    check(
      "billing_subscriptions_plan_check",
      sql`plan = ANY (ARRAY['free'::text, 'basic'::text, 'pro'::text])`,
    ),
    check(
      "billing_subscriptions_period_check",
      sql`period = ANY (ARRAY['monthly'::text, 'yearly'::text])`,
    ),
    check(
      "billing_subscriptions_state_check",
      sql`state = ANY (ARRAY['free'::text, 'active'::text, 'past_due'::text, 'grace'::text, 'downgraded'::text, 'cancelled'::text])`,
    ),
    check(
      "billing_subscriptions_plan_source_check",
      sql`plan_source = ANY (ARRAY['comp'::text, 'paid'::text, 'trial'::text])`,
    ),
    check(
      "billing_subscriptions_current_cycle_seq_check",
      sql`current_cycle_seq >= 0`,
    ),
    check(
      "billing_subscriptions_billed_locations_check",
      sql`(billed_locations >= 0) AND (billed_locations <= 50)`,
    ),
    check(
      "billing_subscriptions_scheduled_plan_check",
      sql`(scheduled_plan IS NULL) OR (scheduled_plan = ANY (ARRAY['free'::text, 'basic'::text, 'pro'::text]))`,
    ),
    check(
      "billing_subscriptions_scheduled_period_check",
      sql`(scheduled_period IS NULL) OR (scheduled_period = ANY (ARRAY['monthly'::text, 'yearly'::text]))`,
    ),
    check(
      "billing_subscriptions_scheduled_locations_check",
      sql`(scheduled_locations IS NULL) OR ((scheduled_locations >= 0) AND (scheduled_locations <= 50))`,
    ),
    // Grace timestamps travel together or not at all.
    check(
      "billing_subscriptions_grace_pair",
      sql`(grace_started_at IS NULL) = (grace_ends_at IS NULL)`,
    ),
    // A paid state must have a cycle, or nothing could decide when to renew it.
    // ⚠ `<> ALL`, not `NOT (… = ANY …)`: Postgres NORMALISES the latter into the
    // former, so writing it the other way makes every future `drizzle-kit
    // introspect` report spurious drift on this constraint. Verified against the
    // applied schema — see supabase/billing_verify.sql.
    check(
      "billing_subscriptions_cycle_present",
      sql`(state <> ALL (ARRAY['active'::text, 'past_due'::text, 'grace'::text])) OR ((current_period_start IS NOT NULL) AND (current_period_end IS NOT NULL))`,
    ),
    check(
      "billing_subscriptions_cycle_order",
      sql`(current_period_end IS NULL) OR (current_period_start IS NULL) OR (current_period_end > current_period_start)`,
    ),
  ],
);

export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    eventId: text("event_id").primaryKey().notNull(),
    eventType: text("event_type"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    // ── billing_04_payments.sql: what makes the marker row a QUEUE row. ──
    /** Without the payload an event can be re-received but never REPLAYED. */
    payload: jsonb().default({}).notNull(),
    signatureVerified: boolean("signature_verified").default(false).notNull(),
    status: text().default("received").notNull(),
    attempts: integer().default(0).notNull(),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "string",
    }),
    leaseUntil: timestamp("lease_until", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    // The worker's claim scan (the data_jobs lease pattern). Processing moves
    // OFF the webhook request, so a failure just leaves the row claimable
    // rather than needing a compensating delete that can itself fail.
    index("billing_webhook_events_claimable_idx")
      .using("btree", table.receivedAt.asc().nullsLast().op("timestamptz_ops"))
      .where(sql`(status = ANY (ARRAY['received'::text, 'failed'::text]))`),
    // Retention: the original table had no timestamp index, so §32 had nothing
    // to sweep with and it grew forever.
    index("billing_webhook_events_received_idx").using(
      "btree",
      table.receivedAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    check(
      "billing_webhook_events_status_check",
      sql`status = ANY (ARRAY['received'::text, 'processed'::text, 'failed'::text, 'ignored'::text])`,
    ),
  ],
);

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
    // Per-line markdown (supabase/pos_07_line_discount.sql). `total` is
    // already net of it — this records WHY the line is cheaper, so the
    // receipt adds up and markdowns stay auditable.
    lineDiscount: numeric("line_discount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    // India GST split (pos_06). tax_amount stays the TOTAL for this line;
    // these three are how it divides — cgst+sgst (intra-state) XOR igst.
    taxCgst: numeric("tax_cgst", { precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    taxSgst: numeric("tax_sgst", { precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    taxIgst: numeric("tax_igst", { precision: 12, scale: 2, mode: "number" })
      .default(0)
      .notNull(),
    hsnCode: text("hsn_code"),
    // Logistics snapshots (logistics_01). These belong to the ORDER LINE, not
    // a live product: changing a product tomorrow must not change the parcel
    // already waiting on today's packing bench.
    sku: text(),
    requiresShipping: boolean("requires_shipping").default(true).notNull(),
    weightGrams: integer("weight_grams"),
    lengthCm: numeric("length_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    widthCm: numeric("width_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    heightCm: numeric("height_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
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

// Split tenders for one sale (pos_06). orders.payment_method/payment_status
// remain the SUMMARY; this is the itemised breakdown (cash + card + …).
// Writes go through placePosSale under the service role, like order_items.
export const orderPayments = pgTable(
  "order_payments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    orderId: uuid("order_id").notNull(),
    storeId: uuid("store_id").notNull(),
    method: text().notNull(),
    amount: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
    tendered: numeric({ precision: 12, scale: 2, mode: "number" }),
    changeDue: numeric("change_due", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    reference: text(),
    capturedAt: timestamp("captured_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("order_payments_order_idx").using(
      "btree",
      table.orderId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [orders.id],
      name: "order_payments_order_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "order_payments_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "order_payments_method_check",
      sql`method = ANY (ARRAY['cash'::text, 'card'::text, 'upi'::text, 'gift_card'::text, 'store_credit'::text, 'razorpay'::text])`,
    ),
    pgPolicy("Store admins read order_payments", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`( SELECT is_store_admin(order_payments.store_id) AS is_store_admin)`,
    }),
  ],
);

export const orders = pgTable(
  "orders",
  {
    // Which cash-drawer period this sale belongs to (pos_10_shifts.sql).
    // Explicit rather than inferred from a time window: a sale rung a second
    // before midnight must not land in tomorrow's drawer.
    shiftId: uuid("shift_id"),
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    // Nullable since pos_06: a walk-in POS sale has no account and no
    // delivery address. The customer-own RLS policy (customer_id = auth.uid())
    // never matches NULL, so those orders stay admin-only.
    customerId: text("customer_id"),
    status: text().default("pending").notNull(),
    paymentMethod: text("payment_method").default("cash_on_delivery").notNull(),
    paymentStatus: text("payment_status").default("pending").notNull(),
    shippingAddress: jsonb("shipping_address"),
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
    // The checkout promise, frozen at purchase time. Carrier rates and ETAs
    // change; support and fulfilment must see what this customer selected.
    shippingOption: jsonb("shipping_option"),
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
    // Pick up in store (supabase/locations_05_pickup.sql). fulfilment_type is
    // TEXT, not a boolean — ship-from-store and lockers are on the roadmap.
    // pickupLocationId is where the shopper COLLECTS, distinct from locationId
    // (where stock came from); for a pickup they match, for ship-from-store
    // they will not.
    fulfilmentType: text("fulfilment_type").default("delivery").notNull(),
    pickupLocationId: uuid("pickup_location_id"),
    pickupStatus: text("pickup_status"),
    pickupExpiresAt: timestamp("pickup_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    collectedAt: timestamp("collected_at", {
      withTimezone: true,
      mode: "string",
    }),
    collectedBy: text("collected_by"),
    // How much of `total` was settled with store credit
    // (store_credit_01_schema.sql). `total` stays the FULL goods value —
    // credit is a PAYMENT, not a discount, so netting it off would understate
    // the sale on the invoice and compute GST on the wrong base.
    storeCreditUsed: numeric("store_credit_used", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    // When the parcel actually LANDED (refunds_01_gateway.sql). The return
    // window starts here — measured from created_at, a 7-day window on a
    // 10-day delivery expires before the customer has the goods.
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "string",
    }),
    // The collection code a customer shows at the counter (locations_11).
    // A LOOKUP key, not a bearer token — see lib/fulfilment/collection-code.ts.
    pickupCode: text("pickup_code"),
    // ── Cancellation (orders_01_cancellation.sql) ──────────────────────────
    // WHOLE-ORDER only: there is deliberately no per-item equivalent, because
    // this system has no partial fulfilment. Lifecycle in
    // lib/orders/cancellation.ts. NULL status = nobody has ever asked.
    cancellationStatus: text("cancellation_status"),
    cancellationRequestedAt: timestamp("cancellation_requested_at", {
      withTimezone: true,
      mode: "string",
    }),
    /** The customer's own words, shown to the merchant when deciding. */
    cancellationReason: text("cancellation_reason"),
    /** The merchant's words on a decline — shown TO the customer. */
    cancellationDeclineReason: text("cancellation_decline_reason"),
    cancellationDecidedAt: timestamp("cancellation_decided_at", {
      withTimezone: true,
      mode: "string",
    }),
    cancellationDecidedBy: text("cancellation_decided_by"),
    /** A code from CANCEL_REASONS, never free text. */
    cancelReason: text("cancel_reason"),
    /** ★ INTERNAL. Never rendered to a customer, anywhere. */
    cancelStaffNote: text("cancel_staff_note"),
    cancelRefundDestination: text("cancel_refund_destination"),
    // Claimed by the reminder job so the nudge fires exactly once
    // (locations_06_pickup_reminder.sql).
    // When the shop expects it ready (locations_09). The hold window is
    // measured FROM this, not from order time.
    pickupReadyAt: timestamp("pickup_ready_at", {
      withTimezone: true,
      mode: "string",
    }),
    pickupWarnedAt: timestamp("pickup_warned_at", {
      withTimezone: true,
      mode: "string",
    }),
    stockStatus: text("stock_status").default("none").notNull(),
    orderNo: integer("order_no").notNull(),
    orderRef: text("order_ref").notNull(),
    taxInclusive: boolean("tax_inclusive").default(false).notNull(),
    razorpayOrderId: text("razorpay_order_id"),
    razorpayPaymentId: text("razorpay_payment_id"),
    // POS Phase 2 (pos_06_sell_path.sql). In-person sales share this table,
    // tagged sales_channel='pos'; customerId/shippingAddress are nullable above
    // because a walk-in has neither.
    salesChannel: text("sales_channel").default("online").notNull(),
    locationId: uuid("location_id"),
    deviceId: uuid("device_id"),
    cashierId: uuid("cashier_id"),
    cashierName: text("cashier_name"),
    receiptNo: text("receipt_no"),
    placeOfSupplyState: text("place_of_supply_state"),
    supplierState: text("supplier_state"),
    customerGstin: text("customer_gstin"),
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

/**
 * StoreMink's OWN tax identity, edited by an operator (owner decision: GST is
 * operator-configured, not merchant-facing).
 *
 * One row, enforced by a boolean PK with a CHECK — the cheapest singleton in
 * Postgres, and a second insert cannot defeat it.
 *
 * ★ `taxEnabled` defaults FALSE: there is no platform GSTIN yet, so invoices
 * must render correctly with no tax and no GSTIN block. Turning it on is NEVER
 * retroactive — invoices are immutable once finalized, so an April invoice
 * cannot sprout GST in September.
 */
export const platformBillingSettings = pgTable(
  "platform_billing_settings",
  {
    id: boolean().default(true).primaryKey().notNull(),
    legalName: text("legal_name"),
    gstin: text(),
    address: jsonb().default({}).notNull(),
    /** Place-of-supply ORIGIN, compared against the merchant's state to decide
     *  CGST+SGST (intra) vs IGST (inter). */
    stateCode: text("state_code"),
    taxEnabled: boolean("tax_enabled").default(false).notNull(),
    /**
     * true = listed plan prices already include GST (carve it out);
     * false = GST is added on top. billing_05_tax_mode.sql.
     *
     * ★ Under INCLUSIVE, enabling GST later changes nothing a merchant pays.
     * Under EXCLUSIVE the same switch raises every bill 18%, which is why
     * `mandateSizePaise` provisions for tax only in that mode.
     */
    taxInclusive: boolean("tax_inclusive").default(false).notNull(),
    /** Basis points, so 18% is 1800 and no float touches a tax rate. */
    taxRateBps: integer("tax_rate_bps").default(1800).notNull(),
    invoicePrefix: text("invoice_prefix").default("SM").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedBy: text("updated_by"),
  },
  () => [
    check("platform_billing_settings_id_check", sql`id`),
    check(
      "platform_billing_settings_tax_rate_bps_check",
      sql`(tax_rate_bps >= 0) AND (tax_rate_bps <= 10000)`,
    ),
    check(
      "platform_billing_settings_invoice_prefix_check",
      sql`invoice_prefix <> ''::text`,
    ),
    // ★ Tax cannot be enabled without a GSTIN: an invoice charging GST while
    // naming no GSTIN is not a valid tax invoice, and the merchant cannot claim
    // input tax credit against it. A data-integrity rule, not a UI nicety.
    check(
      "platform_billing_tax_needs_gstin",
      sql`(tax_enabled = false) OR ((gstin IS NOT NULL) AND (gstin <> ''::text))`,
    ),
    // ★★ See billing_accounts_state_code_numeric — the same hazard, on the
    // supplier side of the same comparison.
    check(
      "platform_billing_state_code_numeric",
      sql`(state_code IS NULL) OR (state_code ~ '^[0-9]{2}$'::text)`,
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
    // Stock at locations that fulfil ONLINE orders — what the storefront may
    // promise (supabase/locations_03_fulfilment.sql). `stock` stays the
    // all-locations total, which the dashboard and POS want. Both are
    // maintained by _recompute_stock_aggregate; never write either directly.
    onlineStock: integer("online_stock").default(0).notNull(),
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
    barcode: text(),
    // Nullable = inherit the product's logistics value. A size/pack variant
    // can override any physical measurement without duplicating the rest.
    requiresShipping: boolean("requires_shipping"),
    weightGrams: integer("weight_grams"),
    lengthCm: numeric("length_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    widthCm: numeric("width_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    heightCm: numeric("height_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
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
    // Moves only when a visitor-visible column changes — NOT on a sale. See
    // supabase/seo_01_product_content_timestamp.sql: updated_at is bumped by
    // _recompute_stock_aggregate on every inventory movement, so it cannot be
    // used as the sitemap's lastmod. Trigger-maintained; never written by app code.
    contentUpdatedAt: timestamp("content_updated_at", {
      withTimezone: true,
      mode: "string",
    })
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
    // Stock at locations that fulfil ONLINE orders — what the storefront may
    // promise (supabase/locations_03_fulfilment.sql). `stock` stays the
    // all-locations total, which the dashboard and POS want. Both are
    // maintained by _recompute_stock_aggregate; never write either directly.
    onlineStock: integer("online_stock").default(0).notNull(),
    lowStockThreshold: integer("low_stock_threshold"),
    allowBackorder: boolean("allow_backorder").default(false).notNull(),
    sku: text().notNull(),
    skuNo: integer("sku_no").notNull(),
    variantSeq: integer("variant_seq").default(0).notNull(),
    taxClassId: uuid("tax_class_id"),
    // Return policy (returns_01_product_policy.sql). `returnable` FALSE = final
    // sale; `returnWindowDays` NULL = use the store's returns.windowDays.
    returnable: boolean().notNull().default(true),
    returnWindowDays: integer("return_window_days"),
    // pos_06: the SUPPLIER barcode a cashier scans — distinct from the
    // system-generated Luhn `sku`, which is ours and immutable.
    barcode: text(),
    hsnCode: text("hsn_code"),
    // Physical shipping data (logistics_01). Weight is stored in grams; the
    // Shiprocket adapter converts to kilograms only at its API boundary.
    requiresShipping: boolean("requires_shipping").default(true).notNull(),
    weightGrams: integer("weight_grams"),
    lengthCm: numeric("length_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    widthCm: numeric("width_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
    heightCm: numeric("height_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }),
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
    locationId: uuid("location_id"),
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
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "stock_movements_location_id_fkey",
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
    // pos_06 — India GST identity. The state code drives place-of-supply.
    gstEnabled: boolean("gst_enabled").default(false).notNull(),
    businessStateCode: text("business_state_code"),
    legalName: text("legal_name"),
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

// What the CUSTOMER pays for delivery. Provider credentials remain in
// store_logistics_providers; this policy deliberately lives separately so a
// merchant can use Shiprocket operationally while charging a flat or free rate.
export const storeShippingSettings = pgTable(
  "store_shipping_settings",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    mode: text().default("free").notNull(),
    flatRate: numeric("flat_rate", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    freeAbove: numeric("free_above", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    manualMinDays: integer("manual_min_days").default(3).notNull(),
    manualMaxDays: integer("manual_max_days").default(7).notNull(),
    handlingDays: integer("handling_days").default(1).notNull(),
    carrierAdjustmentType: text("carrier_adjustment_type")
      .default("none")
      .notNull(),
    carrierAdjustmentValue: numeric("carrier_adjustment_value", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    showAllCouriers: boolean("show_all_couriers").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_shipping_settings_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "store_shipping_settings_mode_check",
      sql`mode = ANY (ARRAY['free'::text, 'flat'::text, 'shiprocket'::text])`,
    ),
    check(
      "store_shipping_settings_adjustment_check",
      sql`carrier_adjustment_type = ANY (ARRAY['none'::text, 'fixed'::text, 'percentage'::text])`,
    ),
    check(
      "store_shipping_settings_values_check",
      sql`flat_rate >= 0 AND (free_above IS NULL OR free_above > 0) AND manual_min_days BETWEEN 0 AND 60 AND manual_max_days BETWEEN manual_min_days AND 90 AND handling_days BETWEEN 0 AND 30 AND carrier_adjustment_value >= 0`,
    ),
  ],
);

// POS Phase 0: physical/warehouse locations per store (supabase/pos_00_locations.sql).
export const storeLocations = pgTable(
  "store_locations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    name: text().notNull(),
    type: text().default("shop").notNull(),
    address: jsonb(),
    gstin: text(),
    stateCode: text("state_code"),
    receiptPrefix: text("receipt_prefix"),
    // What this location may DO (supabase/locations_01_capabilities.sql).
    // jsonb rather than one boolean per capability so a new capability is a
    // registry entry in lib/locations/capabilities.ts, not a migration plus a
    // check to forget in every consumer. Read it through
    // normalizeCapabilities() — never index into the raw blob.
    // PUBLIC: the storefront reads it to decide whether to offer pickup.
    capabilities: jsonb().default({}).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    active: boolean().default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("store_locations_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
      table.sortOrder.asc().nullsLast().op("int4_ops"),
    ),
    // At most one default location per store (partial unique index in SQL).
    uniqueIndex("store_locations_one_default")
      .using("btree", table.storeId.asc().nullsLast().op("uuid_ops"))
      .where(sql`is_default`),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_locations_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "store_locations_type_check",
      sql`type = ANY (ARRAY['shop'::text, 'warehouse'::text])`,
    ),
    pgPolicy("Store admins manage store_locations", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(store_locations.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(store_locations.store_id) AS is_store_admin)`,
    }),
  ],
);

// POS Phase 0: per-location stock — the source of truth; products.stock /
// product_variants.stock are a trigger-maintained aggregate (SUM of on_hand).
// Writes go only through the location-aware RPCs (supabase/pos_02_rpc_location.sql).
// Note: the single-row-per-SKU-per-location UNIQUE index uses a COALESCE
// expression on variant_id (see pos_01_inventory_levels.sql) — not modelled here.
export const inventoryLevels = pgTable(
  "inventory_levels",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    locationId: uuid("location_id").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id"),
    onHand: integer("on_hand").default(0).notNull(),
    reserved: integer().default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("inventory_levels_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    index("inventory_levels_product_idx").using(
      "btree",
      table.productId.asc().nullsLast().op("uuid_ops"),
      table.variantId.asc().nullsLast().op("uuid_ops"),
    ),
    index("inventory_levels_location_idx").using(
      "btree",
      table.locationId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "inventory_levels_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "inventory_levels_location_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.productId],
      foreignColumns: [products.id],
      name: "inventory_levels_product_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.variantId],
      foreignColumns: [productVariants.id],
      name: "inventory_levels_variant_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Store admins read inventory_levels", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`( SELECT is_store_admin(inventory_levels.store_id) AS is_store_admin)`,
    }),
  ],
);

// POS Phase 1: in-store operators (cashier/manager). PIN-authenticated; NOT
// dashboard admins. pin_hash is sensitive (scrypt) — admin-only via RLS.
export const posStaff = pgTable(
  "pos_staff",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    userId: text("user_id"),
    name: text().notNull(),
    email: text().notNull(),
    role: text().default("cashier").notNull(),
    pinHash: text("pin_hash"),
    status: text().default("invited").notNull(),
    inviteToken: text("invite_token"),
    inviteExpiresAt: timestamp("invite_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    resetToken: text("reset_token"),
    resetExpiresAt: timestamp("reset_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    active: boolean().default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("pos_staff_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "pos_staff_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "pos_staff_role_check",
      sql`role = ANY (ARRAY['cashier'::text, 'manager'::text])`,
    ),
    pgPolicy("Store admins manage pos_staff", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(pos_staff.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(pos_staff.store_id) AS is_store_admin)`,
    }),
  ],
);

export const posStaffLocations = pgTable(
  "pos_staff_locations",
  {
    staffId: uuid("staff_id").notNull(),
    locationId: uuid("location_id").notNull(),
    storeId: uuid("store_id").notNull(),
    isPrimary: boolean("is_primary").default(false).notNull(),
  },
  (table) => [
    index("pos_staff_locations_staff_idx").using(
      "btree",
      table.staffId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [posStaff.id],
      name: "pos_staff_locations_staff_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "pos_staff_locations_location_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "pos_staff_locations_store_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.staffId, table.locationId],
      name: "pos_staff_locations_pkey",
    }),
    pgPolicy("Store admins manage pos_staff_locations", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(pos_staff_locations.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(pos_staff_locations.store_id) AS is_store_admin)`,
    }),
  ],
);

// A register paired to a location (a signed pos_device cookie references one).
export const posDevices = pgTable(
  "pos_devices",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    locationId: uuid("location_id").notNull(),
    label: text().default("").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    // Rotation state for clone detection (pos_05_device_hardening.sql).
    tokenNonce: text("token_nonce"),
    prevNonce: text("prev_nonce"),
    prevNonceUntil: timestamp("prev_nonce_until", {
      withTimezone: true,
      mode: "string",
    }),
    revokedReason: text("revoked_reason"),
    revokedBy: text("revoked_by"),
    authorizedBy: text("authorized_by"),
    lastIp: text("last_ip"),
  },
  (table) => [
    index("pos_devices_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "pos_devices_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "pos_devices_location_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Store admins manage pos_devices", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(pos_devices.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(pos_devices.store_id) AS is_store_admin)`,
    }),
  ],
);

// Append-only POS security trail (pos_05_device_hardening.sql). Admin-readable;
// written only via the service role.
// Manager-arranged register grid, per location (supabase/pos_09_register_layout.sql).
// NO ROW = NO LAYOUT = show the whole catalogue, so adding this feature could
// not blank an existing register. `items` is deliberately not FK-checked —
// a deleted product drops out at render rather than wedging the layout.
// Restricts a dashboard admin to specific locations (locations_02_admin_scope.sql).
// NO ROWS = UNRESTRICTED — absence is not restriction, so this changes nothing
// until a merchant deliberately assigns someone. Read through
// lib/locations/scope.ts getViewerLocations(), never inline.
export const adminLocations = pgTable(
  "admin_locations",
  {
    adminId: text("admin_id").notNull(),
    locationId: uuid("location_id").notNull(),
    storeId: uuid("store_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("admin_locations_admin_idx").using(
      "btree",
      table.adminId.asc().nullsLast().op("text_ops"),
    ),
    index("admin_locations_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.adminId],
      foreignColumns: [admins.id],
      name: "admin_locations_admin_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "admin_locations_location_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "admin_locations_store_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.adminId, table.locationId],
      name: "admin_locations_pkey",
    }),
  ],
);

// Where online orders ship from (supabase/locations_03_fulfilment.sql).
// `strategy` names a resolver in lib/fulfilment/strategies.ts, so adding
// "nearest" later needs no schema change. `priority` is an ordered array of
// location ids, deliberately not FK-checked: a deleted location drops out of
// the order rather than blocking the delete. NO ROW = fall back to the default
// location, which is every store's behaviour before Phase D.
export const storeFulfilmentRules = pgTable(
  "store_fulfilment_rules",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    strategy: text().default("priority").notNull(),
    priority: jsonb().default([]).notNull(),
    skipInactive: boolean("skip_inactive").default(true).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_fulfilment_rules_store_id_fkey",
    }).onDelete("cascade"),
  ],
);

// Units held but not sold (supabase/locations_04_reservations.sql).
// available = inventory_levels.on_hand - reserved. `owner_type` is text rather
// than a column per kind so pickup, marketplace and anything later need no
// migration. Every read/write goes through the atomic RPCs in
// lib/inventory/reservations.ts — never UPDATE this from application code.
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    locationId: uuid("location_id").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id"),
    quantity: integer().notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id"),
    status: text().default("held").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("stock_reservations_owner_idx").using(
      "btree",
      table.ownerType.asc().nullsLast().op("text_ops"),
      table.ownerId.asc().nullsLast().op("text_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "stock_reservations_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "stock_reservations_location_id_fkey",
    }).onDelete("cascade"),
    check("stock_reservations_qty_check", sql`quantity > 0`),
    check(
      "stock_reservations_status_check",
      sql`status = ANY (ARRAY['held'::text, 'committed'::text, 'released'::text, 'expired'::text])`,
    ),
  ],
);

export const posLayouts = pgTable(
  "pos_layouts",
  {
    storeId: uuid("store_id").notNull(),
    locationId: uuid("location_id").primaryKey().notNull(),
    items: jsonb().default([]).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => [
    index("idx_pos_layouts_store").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "pos_layouts_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "pos_layouts_location_id_fkey",
    }).onDelete("cascade"),
  ],
);

// Per-location receipt numbers (supabase/pos_06_sell_path.sql). Allocated
// ONLY through the next_pos_receipt_no() RPC — a single atomic UPDATE, the
// same allocator pattern as next_order_no — so nothing reads or writes this
// table through Drizzle. Declared for completeness: a live counter leaks sales
// volume, which is why it is service-role only, and a schema file that omits
// it invites someone to "add" it later with different semantics.
export const posLocationCounters = pgTable(
  "pos_location_counters",
  {
    locationId: uuid("location_id").primaryKey().notNull(),
    receiptSeq: integer("receipt_seq").default(0).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "pos_location_counters_location_id_fkey",
    }).onDelete("cascade"),
  ],
);

// POS Phase 3 — one cash-drawer accounting period per location
// (supabase/pos_10_shifts.sql). At most one open at a time, enforced by a
// partial unique index rather than by application logic.
export const posShifts = pgTable(
  "pos_shifts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    locationId: uuid("location_id").notNull(),
    status: text().default("open").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    openedBy: text("opened_by"),
    // Denormalised so a report still names whoever opened it after that staff
    // member is deleted — the audit outlives the employment.
    openedByName: text("opened_by_name"),
    openingFloat: numeric("opening_float", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "string" }),
    closedBy: text("closed_by"),
    closedByName: text("closed_by_name"),
    // Snapshotted at close so a historical Z-report can never drift.
    countedCash: numeric("counted_cash", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    expectedCash: numeric("expected_cash", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    variance: numeric({ precision: 12, scale: 2, mode: "number" }),
    note: text(),
  },
  (table) => [
    index("idx_pos_shifts_store_opened").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "pos_shifts_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "pos_shifts_location_id_fkey",
    }).onDelete("cascade"),
    check(
      "pos_shifts_status_check",
      sql`status = ANY (ARRAY['open'::text, 'closed'::text])`,
    ),
  ],
);

// Cash into or out of the drawer that ISN'T a sale. `amount` is always
// positive; `type` carries the direction.
export const posCashMovements = pgTable(
  "pos_cash_movements",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    shiftId: uuid("shift_id").notNull(),
    storeId: uuid("store_id").notNull(),
    type: text().notNull(),
    amount: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
    reason: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by"),
    createdByName: text("created_by_name"),
  },
  (table) => [
    index("idx_pos_cash_movements_shift").using(
      "btree",
      table.shiftId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.shiftId],
      foreignColumns: [posShifts.id],
      name: "pos_cash_movements_shift_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "pos_cash_movements_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "pos_cash_movements_type_check",
      sql`type = ANY (ARRAY['drop'::text, 'payout'::text, 'paid_in'::text])`,
    ),
  ],
);

export const posAuditLog = pgTable(
  "pos_audit_log",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    event: text().notNull(),
    // Deliberately no FK — the trail must outlive the device/staff it describes.
    deviceId: uuid("device_id"),
    staffId: uuid("staff_id"),
    locationId: uuid("location_id"),
    actor: text(),
    ip: text(),
    detail: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("pos_audit_log_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "pos_audit_log_store_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Store admins read pos_audit_log", {
      as: "permissive",
      for: "select",
      to: ["public"],
      using: sql`( SELECT is_store_admin(pos_audit_log.store_id) AS is_store_admin)`,
    }),
  ],
);

export const posPairingCodes = pgTable(
  "pos_pairing_codes",
  {
    code: text().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    locationId: uuid("location_id").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("pos_pairing_codes_store_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "pos_pairing_codes_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "pos_pairing_codes_location_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("Store admins manage pos_pairing_codes", {
      as: "permissive",
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(pos_pairing_codes.store_id) AS is_store_admin)`,
      withCheck: sql`( SELECT is_store_admin(pos_pairing_codes.store_id) AS is_store_admin)`,
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
    /** GST credit note serial (returns_04_credit_notes.sql). */
    creditNoteSeq: integer("credit_note_seq").default(0).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_counters_store_id_fkey",
    }).onDelete("cascade"),
  ],
);

// The site-wide header + footer, with the same draft/published contract as
// store_pages (supabase/builder_01_store_chrome.sql). Supersedes store_menus,
// which is left in place unread until the builder has shipped a release.
// `draft` is REVOKED from anon at the DB layer — storefront reads must select
// named columns and never `*`.
export const storeChrome = pgTable(
  "store_chrome",
  {
    storeId: uuid("store_id").primaryKey().notNull(),
    draft: jsonb().default({}).notNull(),
    published: jsonb(),
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
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_chrome_store_id_fkey",
    }).onDelete("cascade"),
  ],
);

// Store-scoped mailing-list consent captured by the footer and newsletter
// page section (supabase/themes_01_newsletter_subscribers.sql). Public forms
// write through a validated, rate-limited server action using service scope;
// RLS exposes rows only to the owning store's admins.
export const newsletterSubscribers = pgTable(
  "newsletter_subscribers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    email: text().notNull(),
    status: text().default("active").notNull(),
    source: text().default("section").notNull(),
    consentText: text("consent_text").notNull(),
    consentedAt: timestamp("consented_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("newsletter_subscribers_store_email_key").on(
      table.storeId,
      table.email,
    ),
    index("idx_newsletter_subscribers_store_status").on(
      table.storeId,
      table.status,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "newsletter_subscribers_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "newsletter_subscribers_status_check",
      sql`status = ANY (ARRAY['active'::text, 'unsubscribed'::text])`,
    ),
    check(
      "newsletter_subscribers_source_check",
      sql`source = ANY (ARRAY['footer'::text, 'section'::text])`,
    ),
    check(
      "newsletter_subscribers_email_normalized_check",
      sql`email = lower(btrim(email))`,
    ),
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
    // Razorpay HMACs the request body, so this must be reversible (encrypted)
    // rather than hashed like the logistics webhook token. See
    // supabase/payments_02_store_webhook.sql.
    webhookSecretEnc: text("webhook_secret_enc"),
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

// Logistics credentials are separate from payment credentials: a merchant can
// pause Shiprocket without touching Razorpay, and every provider connection has
// its own webhook identity. Service-role only (logistics_01_shiprocket.sql).
export const storeLogisticsProviders = pgTable(
  "store_logistics_providers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    provider: text().notNull(),
    accountEmail: text("account_email"),
    credentialSecretEnc: text("credential_secret_enc"),
    tokenEnc: text("token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    webhookSecretHash: text("webhook_secret_hash"),
    enabled: boolean().default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("store_logistics_providers_store_provider_key").on(
      table.storeId,
      table.provider,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "store_logistics_providers_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "store_logistics_providers_provider_check",
      sql`provider = ANY (ARRAY['shiprocket'::text, 'manual'::text])`,
    ),
  ],
);

export const locationLogisticsMappings = pgTable(
  "location_logistics_mappings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    locationId: uuid("location_id").notNull(),
    provider: text().notNull(),
    externalPickupCode: text("external_pickup_code").notNull(),
    externalLocationId: text("external_location_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("location_logistics_mappings_location_provider_key").on(
      table.locationId,
      table.provider,
    ),
    unique("location_logistics_mappings_store_pickup_key").on(
      table.storeId,
      table.provider,
      table.externalPickupCode,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "location_logistics_mappings_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "location_logistics_mappings_location_id_fkey",
    }).onDelete("cascade"),
    check(
      "location_logistics_mappings_provider_check",
      sql`provider = 'shiprocket'::text`,
    ),
  ],
);

// Shopify calls this the work assigned to a location. It is intentionally not
// the same row as an Order: one order may later split across locations.
export const fulfilmentOrders = pgTable(
  "fulfilment_orders",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    locationId: uuid("location_id"),
    status: text().default("open").notNull(),
    holdReason: text("hold_reason"),
    assignedAt: timestamp("assigned_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
    fulfilledAt: timestamp("fulfilled_at", {
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
    index("fulfilment_orders_store_status_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
      table.status.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    index("fulfilment_orders_order_idx").using(
      "btree",
      table.orderId.asc().nullsLast().op("uuid_ops"),
    ),
    unique("fulfilment_orders_order_location_key").on(
      table.orderId,
      table.locationId,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "fulfilment_orders_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [orders.id],
      name: "fulfilment_orders_order_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "fulfilment_orders_location_id_fkey",
    }).onDelete("set null"),
    check(
      "fulfilment_orders_status_check",
      sql`status = ANY (ARRAY['open'::text, 'in_progress'::text, 'on_hold'::text, 'fulfilled'::text, 'cancelled'::text])`,
    ),
  ],
);

export const fulfilmentOrderItems = pgTable(
  "fulfilment_order_items",
  {
    fulfilmentOrderId: uuid("fulfilment_order_id").notNull(),
    orderItemId: uuid("order_item_id").notNull(),
    quantity: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fulfilmentOrderId, table.orderItemId] }),
    foreignKey({
      columns: [table.fulfilmentOrderId],
      foreignColumns: [fulfilmentOrders.id],
      name: "fulfilment_order_items_fulfilment_order_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orderItemId],
      foreignColumns: [orderItems.id],
      name: "fulfilment_order_items_order_item_id_fkey",
    }).onDelete("cascade"),
    check("fulfilment_order_items_quantity_check", sql`quantity > 0`),
  ],
);

export const shipments = pgTable(
  "shipments",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    fulfilmentOrderId: uuid("fulfilment_order_id").notNull(),
    locationId: uuid("location_id"),
    connectionId: uuid("connection_id"),
    provider: text().notNull(),
    status: text().default("draft").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    externalOrderId: text("external_order_id"),
    externalShipmentId: text("external_shipment_id"),
    awb: text(),
    courierId: text("courier_id"),
    courierName: text("courier_name"),
    trackingUrl: text("tracking_url"),
    labelUrl: text("label_url"),
    manifestUrl: text("manifest_url"),
    weightGrams: integer("weight_grams").notNull(),
    lengthCm: numeric("length_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),
    widthCm: numeric("width_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),
    heightCm: numeric("height_cm", {
      precision: 10,
      scale: 2,
      mode: "number",
    }).notNull(),
    shippingCost: numeric("shipping_cost", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    codAmount: numeric("cod_amount", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .default(0)
      .notNull(),
    estimatedDeliveryAt: timestamp("estimated_delivery_at", {
      withTimezone: true,
      mode: "string",
    }),
    pickupScheduledAt: timestamp("pickup_scheduled_at", {
      withTimezone: true,
      mode: "string",
    }),
    pickedUpAt: timestamp("picked_up_at", {
      withTimezone: true,
      mode: "string",
    }),
    deliveredAt: timestamp("delivered_at", {
      withTimezone: true,
      mode: "string",
    }),
    ndrReason: text("ndr_reason"),
    lastError: text("last_error"),
    operationToken: text("operation_token"),
    operationLeaseUntil: timestamp("operation_lease_until", {
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
    index("shipments_order_idx").using(
      "btree",
      table.orderId.asc().nullsLast().op("uuid_ops"),
      table.createdAt.asc().nullsLast().op("timestamptz_ops"),
    ),
    index("shipments_store_status_idx").using(
      "btree",
      table.storeId.asc().nullsLast().op("uuid_ops"),
      table.status.asc().nullsLast().op("text_ops"),
      table.createdAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    uniqueIndex("shipments_provider_awb_idx")
      .using(
        "btree",
        table.provider.asc().nullsLast().op("text_ops"),
        table.awb.asc().nullsLast().op("text_ops"),
      )
      .where(sql`provider = 'shiprocket' AND awb IS NOT NULL`),
    uniqueIndex("shipments_external_shipment_idx")
      .using(
        "btree",
        table.connectionId.asc().nullsLast().op("uuid_ops"),
        table.externalShipmentId.asc().nullsLast().op("text_ops"),
      )
      .where(
        sql`connection_id IS NOT NULL AND external_shipment_id IS NOT NULL`,
      ),
    unique("shipments_idempotency_key_key").on(table.idempotencyKey),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "shipments_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [orders.id],
      name: "shipments_order_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.fulfilmentOrderId],
      foreignColumns: [fulfilmentOrders.id],
      name: "shipments_fulfilment_order_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [storeLocations.id],
      name: "shipments_location_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [storeLogisticsProviders.id],
      name: "shipments_connection_id_fkey",
    }).onDelete("set null"),
    check(
      "shipments_provider_check",
      sql`provider = ANY (ARRAY['shiprocket'::text, 'manual'::text])`,
    ),
    check(
      "shipments_status_check",
      sql`status = ANY (ARRAY['draft'::text, 'booking'::text, 'ready_to_ship'::text, 'pickup_scheduled'::text, 'picked_up'::text, 'in_transit'::text, 'out_for_delivery'::text, 'delivered'::text, 'ndr'::text, 'rto_initiated'::text, 'rto_in_transit'::text, 'rto_delivered'::text, 'cancelled'::text, 'lost'::text, 'damaged'::text, 'error'::text])`,
    ),
    check("shipments_weight_check", sql`weight_grams > 0`),
    check(
      "shipments_dimensions_check",
      sql`length_cm > 0 AND width_cm > 0 AND height_cm > 0`,
    ),
  ],
);

export const shipmentItems = pgTable(
  "shipment_items",
  {
    shipmentId: uuid("shipment_id").notNull(),
    orderItemId: uuid("order_item_id").notNull(),
    quantity: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shipmentId, table.orderItemId] }),
    foreignKey({
      columns: [table.shipmentId],
      foreignColumns: [shipments.id],
      name: "shipment_items_shipment_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orderItemId],
      foreignColumns: [orderItems.id],
      name: "shipment_items_order_item_id_fkey",
    }).onDelete("cascade"),
    check("shipment_items_quantity_check", sql`quantity > 0`),
  ],
);

export const shipmentEvents = pgTable(
  "shipment_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    shipmentId: uuid("shipment_id").notNull(),
    storeId: uuid("store_id").notNull(),
    eventHash: text("event_hash").notNull(),
    status: text().notNull(),
    externalStatus: text("external_status"),
    externalCode: text("external_code"),
    description: text(),
    location: text(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    payload: jsonb().default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("shipment_events_event_hash_key").on(table.eventHash),
    index("shipment_events_shipment_time_idx").using(
      "btree",
      table.shipmentId.asc().nullsLast().op("uuid_ops"),
      table.occurredAt.desc().nullsFirst().op("timestamptz_ops"),
    ),
    foreignKey({
      columns: [table.shipmentId],
      foreignColumns: [shipments.id],
      name: "shipment_events_shipment_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "shipment_events_store_id_fkey",
    }).onDelete("cascade"),
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
    // Billing period taking effect at the next renewal (plans_04). Needed
    // separately from scheduledPlan: a same-tier period change never moves the
    // plan, so scheduledPlan alone cannot express it.
    scheduledPeriod: text("scheduled_period"),
    // Extra POS locations this subscription pays for, ON TOP OF the plan's
    // included count — additive, never a total (subscriptions_03). The cost is
    // folded into the subscription amount rather than billed separately; see
    // lib/plans/location-billing.ts.
    billedLocations: integer("billed_locations").default(0).notNull(),
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

// ---------------------------------------------------------------------------
// Notifications & activity (supabase/notifications_01_schema.sql).
// `storeId` is NULLABLE on all three: NULL means a PLATFORM-level row (an
// operator event / an operator's preferences), mirroring platform_admins.
// Writes are service-role only — see the migration's header for why.
// ---------------------------------------------------------------------------
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id"),
    type: text().notNull(),
    actorType: text("actor_type").default("system").notNull(),
    actorId: text("actor_id"),
    actorLabel: text("actor_label"),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    subjectLabel: text("subject_label"),
    payload: jsonb().default({}).notNull(),
    ip: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("activity_events_store_idx").on(table.storeId, table.createdAt),
    index("activity_events_store_type_idx").on(
      table.storeId,
      table.type,
      table.createdAt,
    ),
    index("activity_events_created_idx").on(table.createdAt),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "activity_events_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "activity_events_actor_type_check",
      sql`actor_type = ANY (ARRAY['customer'::text, 'admin'::text, 'operator'::text, 'system'::text])`,
    ),
    pgPolicy("Read activity_events", {
      for: "select",
      to: ["public"],
      using: sql`CASE WHEN store_id IS NULL THEN ( SELECT is_platform_admin()) ELSE ( SELECT is_store_admin(store_id)) END`,
    }),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id"),
    eventId: uuid("event_id").notNull(),
    recipientType: text("recipient_type").notNull(),
    recipientId: text("recipient_id").notNull(),
    type: text().notNull(),
    title: text().notNull(),
    body: text(),
    url: text(),
    severity: text().default("info").notNull(),
    readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
    archivedAt: timestamp("archived_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("notifications_event_recipient_key").on(
      table.eventId,
      table.recipientId,
    ),
    index("notifications_recipient_idx").on(table.recipientId, table.createdAt),
    index("notifications_created_idx").on(table.createdAt),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "notifications_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.eventId],
      foreignColumns: [activityEvents.id],
      name: "notifications_event_id_fkey",
    }).onDelete("cascade"),
    check(
      "notifications_recipient_type_check",
      sql`recipient_type = ANY (ARRAY['admin'::text, 'customer'::text, 'operator'::text])`,
    ),
    check(
      "notifications_severity_check",
      sql`severity = ANY (ARRAY['info'::text, 'success'::text, 'warning'::text, 'critical'::text])`,
    ),
    // Operators are keyed by lowercased email (platform_admins is an email
    // allowlist with no uid); everyone else by Firebase uid.
    pgPolicy("Read own notifications", {
      for: "select",
      to: ["public"],
      using: sql`CASE WHEN recipient_type = 'operator'::text THEN lower(( SELECT auth.email())) = recipient_id ELSE ( SELECT auth.uid() AS uid) = recipient_id END`,
    }),
    pgPolicy("Update own notifications", {
      for: "update",
      to: ["public"],
      using: sql`CASE WHEN recipient_type = 'operator'::text THEN lower(( SELECT auth.email())) = recipient_id ELSE ( SELECT auth.uid() AS uid) = recipient_id END`,
      withCheck: sql`CASE WHEN recipient_type = 'operator'::text THEN lower(( SELECT auth.email())) = recipient_id ELSE ( SELECT auth.uid() AS uid) = recipient_id END`,
    }),
  ],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id"),
    scope: text().default("user").notNull(),
    recipientId: text("recipient_id").default("").notNull(),
    eventKey: text("event_key").notNull(),
    // Nullable on purpose: NULL = "no override at this level", so a store
    // default doesn't freeze every staff member's personal choice.
    inApp: boolean("in_app"),
    email: boolean(),
    digest: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("notification_preferences_lookup_idx").on(
      table.recipientId,
      table.storeId,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "notification_preferences_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "notification_preferences_scope_check",
      sql`scope = ANY (ARRAY['store'::text, 'user'::text])`,
    ),
    check(
      "notification_preferences_digest_check",
      sql`digest IS NULL OR digest = ANY (ARRAY['instant'::text, 'hourly'::text, 'daily'::text])`,
    ),
    check(
      "notification_preferences_scope_recipient_check",
      sql`(scope = 'store'::text AND recipient_id = ''::text) OR (scope = 'user'::text AND recipient_id <> ''::text)`,
    ),
    pgPolicy("Manage own notification_preferences", {
      for: "all",
      to: ["public"],
      using: sql`scope = 'user'::text AND ( SELECT auth.uid() AS uid) = recipient_id`,
      withCheck: sql`scope = 'user'::text AND ( SELECT auth.uid() AS uid) = recipient_id`,
    }),
    pgPolicy("Manage store notification_preferences", {
      for: "all",
      to: ["public"],
      using: sql`scope = 'store'::text AND store_id IS NOT NULL AND ( SELECT is_store_admin(store_id))`,
      withCheck: sql`scope = 'store'::text AND store_id IS NOT NULL AND ( SELECT is_store_admin(store_id))`,
    }),
  ],
);

// Notification EMAIL queue (supabase/notifications_02_email_queue.sql).
// Worker-only: RLS is enabled with NO policies, so only the service scope can
// touch it — the rows hold recipients' addresses.
// StoreMink's OWN policies, versioned and immutable once published — see
// supabase/legal_01_schema.sql. Platform-global: no store_id.
export const legalDocuments = pgTable("legal_documents", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  kind: text().notNull(),
  version: integer().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  checksum: text().notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  publishedAt: timestamp("published_at", {
    withTimezone: true,
    mode: "string",
  }),
  isCurrent: boolean("is_current").default(false).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

// Who agreed to what, when, from where. APPEND-ONLY (DB trigger).
export const legalAcceptances = pgTable("legal_acceptances", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  // Anchored to EITHER a platform document OR a store policy page — exactly
  // one, enforced by legal_acceptances_anchor_check (legal_02_store_consent).
  documentId: uuid("document_id"),
  kind: text().notNull(),
  version: integer().notNull(),
  userId: text("user_id").notNull(),
  email: text(),
  actorType: text("actor_type").notNull(),
  storeId: uuid("store_id"),
  context: text().notNull(),
  /** Store-policy anchor: the page slug, and a hash of the text they saw. */
  policySlug: text("policy_slug"),
  policyChecksum: text("policy_checksum"),
  ip: text(),
  userAgent: text("user_agent"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

// Every email the platform sends — see supabase/email_logs.sql. A LOG, not a
// queue: nothing reads it to decide what to do next.
export const emailLogs = pgTable("email_logs", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  storeId: uuid("store_id"),
  toEmail: text("to_email").notNull(),
  fromEmail: text("from_email").notNull(),
  cc: text(),
  bcc: text(),
  subject: text(),
  mailer: text().notNull(),
  provider: text().default("resend").notNull(),
  status: text().notNull(),
  error: text(),
  providerMessageId: text("provider_message_id"),
  bodyHtml: text("body_html"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

// Global, NOT tenant-scoped, on purpose — see supabase/notifications_05_suppressions.sql.
export const emailSuppressions = pgTable("email_suppressions", {
  email: text().primaryKey().notNull(),
  reason: text().notNull(),
  detail: text(),
  source: text().default("resend").notNull(),
  lastEventAt: timestamp("last_event_at", {
    withTimezone: true,
    mode: "string",
  })
    .defaultNow()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const notificationEmailQueue = pgTable(
  "notification_email_queue",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id"),
    eventId: uuid("event_id").notNull(),
    recipientId: text("recipient_id").notNull(),
    recipientType: text("recipient_type").notNull(),
    email: text().notNull(),
    eventKey: text("event_key").notNull(),
    digest: text().default("instant").notNull(),
    title: text().notNull(),
    body: text(),
    url: text(),
    severity: text().default("info").notNull(),
    // Snapshotted at enqueue, like subject/body — see notifications_04_email_cc.sql.
    cc: text(),
    bcc: text(),
    // Display-only order summary, snapshotted at enqueue — see
    // supabase/notifications_06_email_items.sql for why it isn't in the payload.
    lineItems: jsonb("line_items"),
    status: text().default("pending").notNull(),
    sendAfter: timestamp("send_after", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "string" }),
    attempts: integer().default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("notification_email_queue_event_recipient_key").on(
      table.eventId,
      table.recipientId,
    ),
    index("notification_email_queue_recipient_idx").on(
      table.recipientId,
      table.sendAfter,
    ),
    index("notification_email_queue_created_idx").on(table.createdAt),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "notification_email_queue_store_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.eventId],
      foreignColumns: [activityEvents.id],
      name: "notification_email_queue_event_id_fkey",
    }).onDelete("cascade"),
    check(
      "notification_email_queue_status_check",
      sql`status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text])`,
    ),
    check(
      "notification_email_queue_digest_check",
      sql`digest = ANY (ARRAY['instant'::text, 'hourly'::text, 'daily'::text])`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Notification CONSOLE (supabase/notifications_03_console.sql).
// notification_definitions is PLATFORM-GLOBAL (no store_id — the
// platform_admins model); notification_settings is per store.
// Resolution: code registry ← definition ← store settings.
// ---------------------------------------------------------------------------
export const notificationDefinitions = pgTable(
  "notification_definitions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    key: text().notNull(),
    displayName: text("display_name"),
    description: text(),
    category: text(),
    group: text(),
    // NULL = defer to the code registry's defaults.
    channels: jsonb(),
    isActive: boolean("is_active").default(true).notNull(),
    // Operator-registered but not emitted by any code path yet.
    isCustom: boolean("is_custom").default(false).notNull(),
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
    uniqueIndex("notification_definitions_key_key").on(table.key),
    index("notification_definitions_category_idx").on(
      table.category,
      table.key,
    ),
    pgPolicy("Read notification_definitions", {
      for: "select",
      to: ["public"],
      using: sql`true`,
    }),
    pgPolicy("Write notification_definitions", {
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_platform_admin())`,
      withCheck: sql`( SELECT is_platform_admin())`,
    }),
  ],
);

export const notificationSettings = pgTable(
  "notification_settings",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    storeId: uuid("store_id").notNull(),
    eventKey: text("event_key").notNull(),
    /** {"email": true, "web": false} — absent keys defer to the default. */
    channels: jsonb().default({}).notNull(),
    /** permission | roles | admins. Targeting NARROWS, never widens. */
    routing: text().default("permission").notNull(),
    // Location axis for routing (supabase/notifications_07_routing_scope.sql).
    // 'store' (default) = today's behaviour; 'event_location' = only staff
    // assigned where the event happened. See lib/notifications/routing.ts.
    routingScope: text("routing_scope").default("store").notNull(),
    targetRoles: text("target_roles").array().default([]).notNull(),
    targetAdmins: text("target_admins").array().default([]).notNull(),
    /** Merchant copy per channel; absent channels use the built-in copy. */
    templates: jsonb().default({}).notNull(),
    digest: text().default("instant").notNull(),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("notification_settings_store_event_key").on(
      table.storeId,
      table.eventKey,
    ),
    foreignKey({
      columns: [table.storeId],
      foreignColumns: [stores.id],
      name: "notification_settings_store_id_fkey",
    }).onDelete("cascade"),
    check(
      "notification_settings_routing_check",
      sql`routing = ANY (ARRAY['permission'::text, 'roles'::text, 'admins'::text])`,
    ),
    check(
      "notification_settings_digest_check",
      sql`digest = ANY (ARRAY['instant'::text, 'hourly'::text, 'daily'::text])`,
    ),
    pgPolicy("Manage notification_settings", {
      for: "all",
      to: ["public"],
      using: sql`( SELECT is_store_admin(store_id))`,
      withCheck: sql`( SELECT is_store_admin(store_id))`,
    }),
  ],
);

// Operator-editable plan pricing (supabase/plans_03_pricing.sql). Platform-
// global — no store_id, like platformAdmins and legalDocuments.
export const planPrices = pgTable("plan_prices", {
  plan: text().primaryKey().notNull(),
  monthlyInr: integer("monthly_inr").notNull(),
  yearlyInr: integer("yearly_inr").notNull(),
  baseMonthlyInr: integer("base_monthly_inr"),
  baseYearlyInr: integer("base_yearly_inr"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updatedBy: text("updated_by"),
});

// ---- Returns & refunds (supabase/pos_12_returns.sql) ----------------------
// Two tables because they are two facts: a return can be refunded across
// several tenders, and a refund can happen with no return (a cancellation).

export const orderReturns = pgTable("order_returns", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  storeId: uuid("store_id").notNull(),
  orderId: uuid("order_id").notNull(),
  /** Where the goods came back TO — not necessarily where they were sold. */
  locationId: uuid("location_id"),
  shiftId: uuid("shift_id"),
  amount: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
  tax: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
  total: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
  /** The customer's own words. `reasonCode` is the one that decides fees. */
  reason: text(),
  actor: text(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).defaultNow(),
  // ── Request lifecycle (returns_02_requests.sql) ─────────────────────────
  /** requested → approved → received → completed, or rejected/cancelled.
   *  DEFAULTS to 'completed': every pre-existing row is a finished till
   *  return, and pos-return-actions still doesn't set it. */
  status: text().notNull().default("completed"),
  /** 'pos' (rung at a counter) | 'online' (asked from the order page). */
  channel: text().notNull().default("pos"),
  requestedBy: text("requested_by"),
  /** A key from lib/returns/reasons.ts — decides fees and who pays postage. */
  reasonCode: text("reason_code"),
  photos: jsonb().notNull().default([]),
  /** Snapshotted at decision time, never recomputed. */
  restockingFee: numeric("restocking_fee", {
    precision: 12,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  returnShippingFee: numeric("return_shipping_fee", {
    precision: 12,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(0),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", {
    withTimezone: true,
    mode: "string",
  }),
  /** Shown to the CUSTOMER, so a rejection is never a silent no. */
  reviewNote: text("review_note"),
  receivedAt: timestamp("received_at", {
    withTimezone: true,
    mode: "string",
  }),
  /** The replacement order (returns_03_exchanges.sql). An exchange is a return
   *  PLUS a new order, never a third entity. NULL until the goods arrive. */
  exchangeOrderId: uuid("exchange_order_id"),
});

export const orderReturnItems = pgTable("order_return_items", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  returnId: uuid("return_id").notNull(),
  orderItemId: uuid("order_item_id").notNull(),
  quantity: integer().notNull(),
  amount: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
  tax: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
  total: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
  /** 'sellable' goes back on the shelf, 'damaged' does not. */
  condition: text().notNull(),
  restocked: boolean().notNull(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).defaultNow(),
  // ── Exchange target (returns_03_exchanges.sql) ──────────────────────────
  /** What they want instead. Per LINE, so one return can mix exchanged and
   *  refunded items. */
  exchangeProductId: uuid("exchange_product_id"),
  exchangeVariantId: uuid("exchange_variant_id"),
  /** Its price WHEN THEY ASKED — re-reading it at receipt would bill them for
   *  a repricing they were never quoted. */
  exchangePrice: numeric("exchange_price", {
    precision: 12,
    scale: 2,
    mode: "number",
  }),
  /** stock_reservations.id — units held so the size can't sell out in transit. */
  exchangeHoldId: uuid("exchange_hold_id"),
});

// Store credit (store_credit_01_schema.sql). A balance a store owes a
// customer, spendable at checkout. The LEDGER is the truth; this is a cached
// sum of it, kept non-negative by a CHECK.
export const customerCreditBalances = pgTable(
  "customer_credit_balances",
  {
    storeId: uuid("store_id").notNull(),
    /** Firebase uid — TEXT, per phase6_01. */
    customerId: text("customer_id").notNull(),
    balance: numeric({ precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.customerId] })],
);

export const customerCreditLedger = pgTable("customer_credit_ledger", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  storeId: uuid("store_id").notNull(),
  customerId: text("customer_id").notNull(),
  /** Positive issues, negative spends. Never zero. */
  delta: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
  /** refund | grant | spend | reinstate | expire (reserved). */
  kind: text().notNull(),
  /** An order_refunds.id, an orders.id, or an operator's email. UNIQUE per
   *  (store, customer, kind) so a double-confirmed refund credits once. */
  ref: text(),
  note: text(),
  actor: text(),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  }).defaultNow(),
});

export const orderRefunds = pgTable("order_refunds", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  storeId: uuid("store_id").notNull(),
  orderId: uuid("order_id").notNull(),
  returnId: uuid("return_id"),
  locationId: uuid("location_id"),
  shiftId: uuid("shift_id"),
  method: text().notNull(),
  amount: numeric({ precision: 12, scale: 2, mode: "number" }).notNull(),
  /** Razorpay refund id — UNIQUE, so a replay can't record it twice. */
  gatewayRefundId: text("gateway_refund_id"),
  /** Ours, generated BEFORE the gateway call — UNIQUE. The gateway id can only
   *  make the RECORD idempotent; this makes the CALL idempotent. */
  idempotencyKey: text("idempotency_key"),
  /** Why the money went back (a cancellation has no order_returns row). */
  reason: text(),
  /** Proof for money moved outside a gateway — a typed UPI transaction id. */
  reference: text(),
  // ── GST credit note (returns_04_credit_notes.sql) ───────────────────────
  /** Per-store serial, allocated by a TRIGGER on settlement — never by app
   *  code, because a gap in a GST series is what an audit flags. */
  creditNoteNo: integer("credit_note_no"),
  creditNoteRef: text("credit_note_ref"),
  creditNoteAt: timestamp("credit_note_at", {
    withTimezone: true,
    mode: "string",
  }),
  status: text().notNull(),
  actor: text(),
  // `supabase/pos_12_returns.sql` declares this `timestamptz NOT NULL DEFAULT
  // now()` and that migration has run, so the column is non-null in every
  // environment. The introspected type was missing `.notNull()` — drift, not a
  // real nullable — which made every reader carry a null branch that cannot
  // happen.
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "string",
  })
    .defaultNow()
    .notNull(),
});

// ---------------------------------------------------------------------------
// CSV import/export jobs + their per-row error log
// (supabase/import_export_01_jobs.sql, CODEBASE.md §31).
//
// Service-role only, like email_logs: the rows quote raw cells from the
// merchant's file, and for an orders export that means customer names and
// addresses. Reads are gated at the app layer on the `activity` section.
// ---------------------------------------------------------------------------

export const dataJobs = pgTable("data_jobs", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  storeId: uuid("store_id").notNull(),
  /** 'import' | 'export'. */
  kind: text().notNull(),
  /** A lib/import-export/resources.ts id. Free text so an old row keeps its
   *  meaning after a resource is renamed. */
  resource: text().notNull(),
  /** pending | running | completed | partial | failed | cancelled. `partial`
   *  is a real outcome, not a failure — see the SQL header. */
  status: text().default("pending").notNull(),
  filename: text(),
  totalRows: integer("total_rows").default(0).notNull(),
  processedRows: integer("processed_rows").default(0).notNull(),
  createdCount: integer("created_count").default(0).notNull(),
  updatedCount: integer("updated_count").default(0).notNull(),
  skippedCount: integer("skipped_count").default(0).notNull(),
  failedCount: integer("failed_count").default(0).notNull(),
  warningCount: integer("warning_count").default(0).notNull(),
  /** Issues NOT written because the per-job cap was hit. Without this the log
   *  silently looks complete. */
  droppedIssues: integer("dropped_issues").default(0).notNull(),
  /** The failure that killed the WHOLE job, as opposed to the per-row issues. */
  error: text(),
  options: jsonb().default({}).notNull(),
  /** Next DATA row to read, 0-based. Deliberately distinct from
   *  processedRows: "where to resume" and "how much got done" move together
   *  today, and conflating them is how a resumed job skips a slice. */
  cursor: integer().default(0).notNull(),
  /** Worker claim. Only a job whose lease has EXPIRED is claimable, which is
   *  what stops the self-chain and the cron sweep double-importing a slice. */
  leaseUntil: timestamp("lease_until", {
    withTimezone: true,
    mode: "string",
  }),
  /** Claims so far — bounded retries, so a job that reliably dies gives up. */
  attempts: integer().default(0).notNull(),
  /** Firebase uid — TEXT, not UUID (phase6_01_uid_columns_to_text.sql). */
  createdBy: text("created_by"),
  actorEmail: text("actor_email"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

/** The uploaded file, held server-side so the import survives a closed tab.
 *  In Postgres rather than the media bucket because that bucket is public —
 *  see supabase/import_export_02_background.sql. Service-role only. */
export const dataJobPayloads = pgTable("data_job_payloads", {
  jobId: uuid("job_id").primaryKey().notNull(),
  storeId: uuid("store_id").notNull(),
  header: jsonb().default([]).notNull(),
  csv: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const dataJobIssues = pgTable("data_job_issues", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  jobId: uuid("job_id").notNull(),
  /** Denormalised from the job so a read is store-scoped without a join. */
  storeId: uuid("store_id").notNull(),
  /** 1-based line in the merchant's ORIGINAL file. 0 = a problem with the file
   *  itself (a missing column) rather than any one row. */
  line: integer().default(0).notNull(),
  /** `column` is reserved in SQL — this is the CSV header involved. */
  columnName: text("column_name"),
  code: text().notNull(),
  /** 'error' skips the row; 'warning' imports it and says what was assumed. */
  severity: text().notNull(),
  message: text().notNull(),
  value: text(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});
