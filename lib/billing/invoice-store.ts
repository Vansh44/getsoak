import "server-only";

/**
 * The invoice repository — turning a BuiltInvoice into rows, idempotently.
 *
 * Design: docs/billing-architecture.md §5, §6, §7.
 *
 * ★ THE PURE HALF DECIDES THE MONEY; THIS HALF ONLY PERSISTS IT. Every amount
 * comes from `lib/billing/invoice.ts`, so the renewal worker, an upgrade and a
 * merchant-facing preview cannot disagree about what a cycle costs.
 *
 * ⚠ WHAT THESE FUNCTIONS CANNOT GUARANTEE ON THEIR OWN. Exactly-once creation
 * is the `billing_invoices_one_per_cycle` UNIQUE index, immutability is a
 * trigger, and the invoice number comes from another trigger. All three live in
 * Postgres and are verified by `supabase/billing_verify.sql` against a real
 * database — never by the unit tests here, which can only prove that this layer
 * asks for the right thing and reads the answer correctly.
 */

import { and, eq, sql } from "drizzle-orm";
import { withService, type Db } from "@/lib/db/client";
import {
  billingAccounts,
  billingCredits,
  billingInvoiceItems,
  billingInvoices,
  platformBillingSettings,
} from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import type { BuiltInvoice, TaxContext } from "./invoice";

export interface InvoiceRow {
  id: string;
  storeId: string;
  kind: "subscription" | "ai_credits";
  status: string;
  totalPaise: number;
  cycleSeq: number | null;
  invoiceRef: string | null;
  finalizedAt: string | null;
}

/**
 * The tax configuration to stamp on ONE invoice.
 *
 * ★ Read at build time and SNAPSHOTTED onto the invoice, never re-read when it
 * is displayed. An operator turning GST on, changing the rate, or correcting a
 * state code must not rewrite what a merchant was already charged — which the
 * immutability trigger enforces, but which starts here by capturing the values
 * rather than referencing them.
 *
 * Falls back to tax-OFF on any read failure. That is the safe direction: a
 * transient database error must never invent a tax charge, and the alternative
 * — failing the renewal — costs the merchant their plan over an outage.
 */
export async function loadTaxContext(storeId: string): Promise<TaxContext> {
  const off: TaxContext = {
    enabled: false,
    rateBps: 0,
    inclusive: false,
    supplierStateCode: null,
    placeOfSupply: null,
  };
  try {
    return await withService(async (db) => {
      const [settings] = await db
        .select({
          taxEnabled: platformBillingSettings.taxEnabled,
          taxInclusive: platformBillingSettings.taxInclusive,
          taxRateBps: platformBillingSettings.taxRateBps,
          stateCode: platformBillingSettings.stateCode,
        })
        .from(platformBillingSettings)
        .limit(1);

      const [account] = await db
        .select({ stateCode: billingAccounts.stateCode })
        .from(billingAccounts)
        .where(eq(billingAccounts.storeId, storeId))
        .limit(1);

      if (!settings) return off;
      return {
        enabled: settings.taxEnabled,
        rateBps: settings.taxRateBps,
        inclusive: settings.taxInclusive,
        supplierStateCode: settings.stateCode ?? null,
        placeOfSupply: account?.stateCode ?? null,
      };
    });
  } catch (err) {
    logError("billing.load_tax_context", err, { storeId });
    return off;
  }
}

/** Shared shape for writing an invoice + its lines in one transaction. */
interface CreateInput {
  storeId: string;
  kind: "subscription" | "ai_credits";
  built: BuiltInvoice;
  cycleSeq?: number | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  dueAt?: Date | null;
  supplierGstin?: string | null;
  customerGstin?: string | null;
  placeOfSupply?: string | null;
}

async function insertInvoiceWithLines(
  db: Db,
  input: CreateInput,
): Promise<string | null> {
  const { built } = input;

  // ★ ON CONFLICT DO NOTHING against billing_invoices_one_per_cycle. Two
  // renewal workers racing on the same cycle: one inserts, the other gets zero
  // rows back and reads the winner's invoice instead of creating a second
  // obligation (spec §35). `.returning()` is empty on conflict, which is the
  // signal — not an error to catch.
  const inserted = await db
    .insert(billingInvoices)
    .values({
      storeId: input.storeId,
      kind: input.kind,
      status: "draft",
      subtotalPaise: built.subtotalPaise,
      discountPaise: built.discountPaise,
      taxPaise: built.taxPaise,
      totalPaise: built.totalPaise,
      taxRateBps: built.taxRateBps,
      cycleSeq: input.cycleSeq ?? null,
      periodStart: input.periodStart?.toISOString() ?? null,
      periodEnd: input.periodEnd?.toISOString() ?? null,
      dueAt: input.dueAt?.toISOString() ?? null,
      supplierGstin: input.supplierGstin ?? null,
      customerGstin: input.customerGstin ?? null,
      placeOfSupply: input.placeOfSupply ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: billingInvoices.id });

  const id = inserted[0]?.id;
  if (!id) return null; // Someone else won the race.

  // Lines must land BEFORE finalization — the immutability trigger freezes them
  // the moment `finalized_at` is set.
  if (built.lines.length > 0) {
    await db.insert(billingInvoiceItems).values(
      built.lines.map((line, i) => ({
        invoiceId: id,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unitAmountPaise: line.unitAmountPaise,
        amountPaise: line.amountPaise,
        sortOrder: i,
      })),
    );
  }
  return id;
}

/**
 * The renewal invoice for one cycle — created once, ever.
 *
 * ★ IDEMPOTENT ON (store, kind, cycle_seq), and the guarantee is the database's,
 * not this function's. Returns the EXISTING invoice when another worker got
 * there first, so a caller can always proceed with what it gets back rather
 * than having to distinguish "I made this" from "it was already there".
 *
 * ⚠ Creates it as a DRAFT. Finalization is separate and deliberate: it
 * allocates a gapless document number, so an invoice that is abandoned before
 * being issued must never burn one (§6).
 */
export async function ensureRenewalInvoice(input: {
  storeId: string;
  cycleSeq: number;
  periodStart: Date;
  periodEnd: Date;
  dueAt?: Date;
  built: BuiltInvoice;
  supplierGstin?: string | null;
  customerGstin?: string | null;
  placeOfSupply?: string | null;
}): Promise<InvoiceRow | null> {
  try {
    return await withService(async (db) => {
      const id = await insertInvoiceWithLines(db, {
        storeId: input.storeId,
        kind: "subscription",
        built: input.built,
        cycleSeq: input.cycleSeq,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        dueAt: input.dueAt ?? null,
        supplierGstin: input.supplierGstin,
        customerGstin: input.customerGstin,
        placeOfSupply: input.placeOfSupply,
      });

      if (id) return readInvoice(db, id);

      // Lost the race — read the invoice that won.
      const [existing] = await selectInvoice(db).where(
        and(
          eq(billingInvoices.storeId, input.storeId),
          eq(billingInvoices.kind, "subscription"),
          eq(billingInvoices.cycleSeq, input.cycleSeq),
        ),
      );
      return existing ? toInvoiceRow(existing) : null;
    });
  } catch (err) {
    logError("billing.ensure_renewal_invoice", err, {
      storeId: input.storeId,
      cycleSeq: input.cycleSeq,
    });
    return null;
  }
}

/**
 * A one-time AI credit purchase invoice.
 *
 * ★ Its own document, always (spec §1). `cycle_seq` stays null, so the
 * one-per-cycle index does not apply and a merchant may buy credits as often as
 * they like — including while their subscription is in grace.
 */
export async function createAiCreditsInvoice(input: {
  storeId: string;
  built: BuiltInvoice;
  supplierGstin?: string | null;
  customerGstin?: string | null;
  placeOfSupply?: string | null;
}): Promise<InvoiceRow | null> {
  try {
    return await withService(async (db) => {
      const id = await insertInvoiceWithLines(db, {
        storeId: input.storeId,
        kind: "ai_credits",
        built: input.built,
        cycleSeq: null,
        supplierGstin: input.supplierGstin,
        customerGstin: input.customerGstin,
        placeOfSupply: input.placeOfSupply,
      });
      return id ? readInvoice(db, id) : null;
    });
  } catch (err) {
    logError("billing.create_ai_credits_invoice", err, {
      storeId: input.storeId,
    });
    return null;
  }
}

/**
 * Issue the invoice: stamp `finalized_at`, which fires the trigger that
 * allocates the gapless document number, and open it for collection.
 *
 * ★ A CONDITIONAL CLAIM on `finalized_at IS NULL`, so two callers cannot both
 * finalize. The trigger is idempotent too (it skips when `invoice_ref` is
 * already set), but claiming here means the SECOND caller learns it lost rather
 * than believing it issued the document.
 *
 * Returns the invoice either way — a lost claim is not an error, it means
 * someone else already issued it.
 */
export async function finalizeInvoice(
  invoiceId: string,
  now: Date = new Date(),
): Promise<InvoiceRow | null> {
  return (await finalizeInvoiceClaimed(invoiceId, now)).invoice;
}

/**
 * Finalize, and say whether THIS call was the one that did it.
 *
 * ★ "I finalized it" and "I observed it finalized" are different facts, and the
 * plain `finalizeInvoice` above cannot tell them apart — it re-reads the row, so
 * a caller that lost the race still gets a finalized invoice back and believes
 * it won. That is harmless for control flow (either way the invoice is issued)
 * and NOT harmless for anything that should happen once per invoice: the renewal
 * worker mails the merchant here, and `claimDue` deliberately takes no lock, so
 * two overlapping runs would send the same bill twice.
 *
 * The conditional UPDATE is the claim; `returning()` is how we hear about it.
 */
export async function finalizeInvoiceClaimed(
  invoiceId: string,
  now: Date = new Date(),
): Promise<{ invoice: InvoiceRow | null; claimed: boolean }> {
  try {
    return await withService(async (db) => {
      const claimed = await db
        .update(billingInvoices)
        .set({
          finalizedAt: now.toISOString(),
          status: "open",
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(billingInvoices.id, invoiceId),
            sql`${billingInvoices.finalizedAt} is null`,
          ),
        )
        .returning({ id: billingInvoices.id });
      return {
        invoice: await readInvoice(db, invoiceId),
        claimed: claimed.length > 0,
      };
    });
  } catch (err) {
    logError("billing.finalize_invoice", err, { invoiceId });
    return { invoice: null, claimed: false };
  }
}

function selectInvoice(db: Db) {
  return db
    .select({
      id: billingInvoices.id,
      storeId: billingInvoices.storeId,
      kind: billingInvoices.kind,
      status: billingInvoices.status,
      totalPaise: billingInvoices.totalPaise,
      cycleSeq: billingInvoices.cycleSeq,
      invoiceRef: billingInvoices.invoiceRef,
      finalizedAt: billingInvoices.finalizedAt,
    })
    .from(billingInvoices);
}

/**
 * Narrow the DB's `kind: string` to the union.
 *
 * ★ A real check, not a cast. `kind` is CHECK-constrained in Postgres, so an
 * unexpected value means the constraint was dropped or a new kind was added
 * without updating this file — either way, returning null beats handing a
 * caller a row whose type is a lie.
 */
function toInvoiceRow(row: {
  id: string;
  storeId: string;
  kind: string;
  status: string;
  totalPaise: number;
  cycleSeq: number | null;
  invoiceRef: string | null;
  finalizedAt: string | null;
}): InvoiceRow | null {
  if (row.kind !== "subscription" && row.kind !== "ai_credits") return null;
  return { ...row, kind: row.kind };
}

async function readInvoice(db: Db, id: string): Promise<InvoiceRow | null> {
  const [row] = await selectInvoice(db).where(eq(billingInvoices.id, id));
  return row ? toInvoiceRow(row) : null;
}

/** One invoice by id. */
export async function getInvoice(
  invoiceId: string,
): Promise<InvoiceRow | null> {
  try {
    return await withService((db) => readInvoice(db, invoiceId));
  } catch (err) {
    logError("billing.get_invoice", err, { invoiceId });
    return null;
  }
}

/**
 * What must actually be collected: the invoice total less any account credit
 * already applied to it.
 *
 * ★ Credit is a PAYMENT, not a discount (§29), so it is NOT netted into
 * `total_paise` — the invoice keeps the full value of what was sold and this is
 * where the reduction happens. Deriving it on read means there is no
 * "credit_applied" column to forget to clear.
 *
 * ⚠ Returns null on a read failure rather than the full total. Quoting the full
 * amount when credit may already have been applied would double-charge, which
 * is the one outcome worth refusing to guess at (Rule 10).
 */
export async function amountDueForInvoice(
  invoiceId: string,
): Promise<number | null> {
  try {
    return await withService(async (db) => {
      const invoice = await readInvoice(db, invoiceId);
      if (!invoice) return null;

      const [applied] = await db
        .select({
          total: sql<number>`coalesce(sum(${billingCredits.deltaPaise}), 0)::int`,
        })
        .from(billingCredits)
        .where(
          and(
            eq(billingCredits.invoiceId, invoiceId),
            eq(billingCredits.kind, "applied"),
          ),
        );

      // `applied` credits are stored NEGATIVE (they reduce what is owed), so the
      // magnitude is what offsets the total.
      const creditPaise = Math.abs(Number(applied?.total ?? 0));
      return Math.max(
        0,
        invoice.totalPaise - Math.min(creditPaise, invoice.totalPaise),
      );
    });
  } catch (err) {
    logError("billing.amount_due", err, { invoiceId });
    return null;
  }
}
