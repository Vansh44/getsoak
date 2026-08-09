import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { withUser } from "@/lib/db/client";
import { coupons } from "@/drizzle/schema";
import { dbErrorMessage, isUniqueViolation } from "@/lib/db/errors";
import type { ParsedRecord } from "../types";
import {
  failure,
  issue,
  present,
  type ImportContext,
  type RowResult,
} from "./types";

const FIELD_MAP: Record<string, (v: unknown) => unknown> = {
  description: (v) => String(v).trim() || null,
  discountType: (v) => String(v),
  discountValue: (v) => Number(v),
  minOrderAmount: (v) => Number(v),
  maxUses: (v) => Number(v),
  status: (v) => String(v),
  validFrom: (v) => String(v),
  validUntil: (v) => String(v),
  showOnStorefront: (v) => Boolean(v),
};

/**
 * Import coupons, matched on code.
 *
 * Codes are stored and compared UPPERCASE. Checkout matches them
 * case-insensitively, so `welcome10` and `WELCOME10` are one coupon to a
 * shopper — importing them as two rows would create a second coupon that can
 * never be redeemed independently and whose usage cap means nothing.
 */
export async function importCoupons(
  ctx: ImportContext,
  records: readonly ParsedRecord[],
): Promise<RowResult[]> {
  const results: RowResult[] = [];
  if (records.length === 0) return results;

  const codes = records
    .map((r) =>
      String(r.values.code ?? "")
        .trim()
        .toUpperCase(),
    )
    .filter(Boolean);

  let existing = new Map<string, { id: string; discountType: string }>();
  try {
    const rows = await withUser(ctx.admin, (db) =>
      db
        .select({
          id: coupons.id,
          code: coupons.code,
          discountType: coupons.discountType,
        })
        .from(coupons)
        .where(
          and(
            eq(coupons.storeId, ctx.storeId),
            inArray(sql`upper(${coupons.code})`, codes),
          ),
        ),
    );
    existing = new Map(
      rows.map((r) => [
        r.code.toUpperCase(),
        { id: r.id, discountType: r.discountType },
      ]),
    );
  } catch (error) {
    const message = dbErrorMessage(error, "Couldn't read existing coupons.");
    return records.map((r) => failure([r.line], message, "lookup_failed"));
  }

  for (const record of records) {
    const code = String(record.values.code ?? "")
      .trim()
      .toUpperCase();
    const issues = record.issues.filter((i) => i.severity === "warning");

    if (!code) {
      results.push({
        lines: [record.line],
        outcome: "failed",
        issues: [
          issue(record.line, "Code", "required", "A coupon needs a code."),
        ],
      });
      continue;
    }

    const patch = present<Record<string, unknown>>(record.values, FIELD_MAP);
    const found = existing.get(code);
    const type =
      (patch.discountType as string) ?? found?.discountType ?? "percentage";

    // A percentage over 100 gives the goods away and pays the customer the
    // difference. The editor blocks it; an import that didn't would be the
    // easy way around the check.
    if (
      type === "percentage" &&
      typeof patch.discountValue === "number" &&
      patch.discountValue > 100
    ) {
      results.push({
        lines: [record.line],
        outcome: "failed",
        issues: [
          ...issues,
          issue(
            record.line,
            "Discount Value",
            "percent_over_100",
            `A percentage discount can't be more than 100 — got ${patch.discountValue}.`,
            "error",
            String(patch.discountValue),
          ),
        ],
      });
      continue;
    }

    // Dates that run backwards make a coupon that can never be redeemed, and
    // nothing downstream would ever report why.
    const from = patch.validFrom as string | undefined;
    const until = patch.validUntil as string | undefined;
    if (from && until && new Date(from) > new Date(until)) {
      results.push({
        lines: [record.line],
        outcome: "failed",
        issues: [
          ...issues,
          issue(
            record.line,
            "Valid Until",
            "dates_reversed",
            "Valid Until is before Valid From, so this coupon could never be used.",
            "error",
            until,
          ),
        ],
      });
      continue;
    }

    try {
      if (found) {
        if (!ctx.options.update) {
          results.push({ lines: [record.line], outcome: "skipped", issues });
          continue;
        }
        // `used_count` is deliberately not writable (it is read-only in the
        // registry): resetting a redemption counter from a spreadsheet would
        // reopen a cap the store has already spent.
        await withUser(ctx.admin, (db) =>
          db
            .update(coupons)
            .set({ ...patch, updatedBy: ctx.admin.uid })
            .where(
              and(eq(coupons.id, found.id), eq(coupons.storeId, ctx.storeId)),
            ),
        );
        results.push({ lines: [record.line], outcome: "updated", issues });
        continue;
      }

      if (!ctx.options.create) {
        results.push({ lines: [record.line], outcome: "skipped", issues });
        continue;
      }

      if (patch.discountValue === undefined) {
        results.push({
          lines: [record.line],
          outcome: "failed",
          issues: [
            ...issues,
            issue(
              record.line,
              "Discount Value",
              "required_on_create",
              "This coupon is new, so it needs a Discount Value.",
            ),
          ],
        });
        continue;
      }

      await withUser(ctx.admin, (db) =>
        db.insert(coupons).values({
          storeId: ctx.storeId,
          code,
          description: (patch.description as string | null) ?? null,
          discountType: type,
          discountValue: patch.discountValue as number,
          minOrderAmount: (patch.minOrderAmount as number | undefined) ?? 0,
          maxUses: (patch.maxUses as number | undefined) ?? 0,
          status: (patch.status as string | undefined) ?? "active",
          validFrom: (patch.validFrom as string | undefined) ?? null,
          validUntil: (patch.validUntil as string | undefined) ?? null,
          showOnStorefront:
            (patch.showOnStorefront as boolean | undefined) ?? false,
          createdBy: ctx.admin.uid,
          updatedBy: ctx.admin.uid,
        }),
      );
      results.push({ lines: [record.line], outcome: "created", issues });
    } catch (error) {
      const message = isUniqueViolation(error)
        ? `A coupon with the code "${code}" already exists.`
        : dbErrorMessage(error, "Couldn't save this coupon.");
      results.push({
        lines: [record.line],
        outcome: "failed",
        issues: [...issues, issue(record.line, null, "write_failed", message)],
      });
    }
  }

  return results;
}
