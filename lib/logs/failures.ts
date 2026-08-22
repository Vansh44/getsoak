// ---------------------------------------------------------------------------
// The Failures log — everything that didn't work, in one place.
//
// ── Why this reads existing tables instead of adding one ──────────────────
// Every failure here is ALREADY recorded: a bounced email is an `email_logs`
// row, a dead refund is `order_refunds.status = 'failed'`, a broken import is
// a `data_jobs` row. A `failures` table would be a second copy of facts we
// already hold — a write to forget on every new failure path, and a row that
// can disagree with the thing it describes. So this is a READ across the
// sources, and there is nothing to migrate, nothing to backfill, and no
// retention entry to add (§32 already prunes the underlying tables).
//
// The cost is honest and bounded: merging N sources cannot be paginated
// exactly, so this takes the most recent `PER_SOURCE_LIMIT` from each, merges,
// sorts and caps. Past that depth you are no longer triaging, you are
// auditing, and the individual logs are where that belongs.
//
// ── ★ SCOPE IS A DISCRIMINATED UNION, NOT AN OPTIONAL storeId ─────────────
// These queries run under `withService`, which BYPASSES RLS, so tenant
// scoping is the caller's responsibility (convention #2). An optional
// `storeId?: string` would make "every store's failures" the value you get by
// forgetting an argument — the single worst default available here. Asking
// for the platform view is therefore an explicit `{ kind: "platform" }`, which
// cannot be produced by omission.
// ---------------------------------------------------------------------------

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  dataJobs,
  emailLogs,
  notificationEmailQueue,
  orderRefunds,
  orders,
  stores,
  billingPaymentAttempts,
  smsLogs,
} from "@/drizzle/schema";
import { logError } from "@/lib/observability/logger";
import { ROOT_DOMAIN } from "@/lib/store/host";
import {
  FAILURE_SOURCE_META,
  type FailureRow,
  type FailureScope,
  type FailureSourceKey,
  type FailureSourceMeta,
} from "./failure-types";

// Re-exported so server callers have one import. CLIENT components must import
// from ./failure-types directly — see the note at the top of that file.
export {
  FAILURE_SOURCE_META,
  type FailureRow,
  type FailureScope,
  type FailureSourceKey,
};

/** Rows taken from each source before merging. */
export const PER_SOURCE_LIMIT = 100;

/** Rows returned after the merge. */
export const DEFAULT_LIMIT = 100;

export interface FailureSource extends FailureSourceMeta {
  fetch: (scope: FailureScope, limit: number) => Promise<FailureRow[]>;
}

function meta(key: FailureSourceKey): FailureSourceMeta {
  const found = FAILURE_SOURCE_META.find((m) => m.key === key);
  if (!found) throw new Error(`No metadata for failure source "${key}"`);
  return found;
}

/** Store predicate, or undefined for the platform view. */
function storeFilter(scope: FailureScope, column: Parameters<typeof eq>[0]) {
  return scope.kind === "store" ? eq(column, scope.storeId) : undefined;
}

// ── Sources ────────────────────────────────────────────────────────────────
//
// ⚠ To add one: add an entry. Keep the title merchant-readable — this view is
// shown to shop owners, so "Order confirmation to x@y.com failed" belongs here
// and a stack trace does not (those go to Cloud Logging via lib/observability).

export const FAILURE_SOURCES: FailureSource[] = [
  {
    ...meta("email"),
    fetch: (scope, limit) =>
      withService(async (db) => {
        const rows = await db
          .select({
            id: emailLogs.id,
            storeId: emailLogs.storeId,
            to: emailLogs.toEmail,
            mailer: emailLogs.mailer,
            error: emailLogs.error,
            createdAt: emailLogs.createdAt,
          })
          .from(emailLogs)
          .where(
            and(
              eq(emailLogs.status, "failed"),
              storeFilter(scope, emailLogs.storeId),
            ),
          )
          .orderBy(desc(emailLogs.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: `email:${r.id}`,
          source: "email" as const,
          title: `${r.mailer} to ${r.to} failed`,
          detail: r.error,
          occurredAt: r.createdAt,
          storeId: r.storeId,
          href: "/dashboard/logs/email-logs?status=failed",
        }));
      }),
  },
  {
    ...meta("sms"),
    fetch: (scope, limit) =>
      withService(async (db) => {
        const rows = await db
          .select({
            id: smsLogs.id,
            storeId: smsLogs.storeId,
            to: smsLogs.toPhone,
            eventKey: smsLogs.eventKey,
            error: smsLogs.error,
            createdAt: smsLogs.createdAt,
          })
          .from(smsLogs)
          .where(
            and(
              eq(smsLogs.status, "failed"),
              storeFilter(scope, smsLogs.storeId),
            ),
          )
          .orderBy(desc(smsLogs.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: `sms:${r.id}`,
          source: "sms" as const,
          title: `${r.eventKey ?? "SMS"} to ${r.to} failed`,
          detail: r.error,
          occurredAt: r.createdAt,
          storeId: r.storeId,
          href: "/dashboard/logs/sms-logs?status=failed",
        }));
      }),
  },
  {
    ...meta("notification"),
    fetch: (scope, limit) =>
      withService(async (db) => {
        const rows = await db
          .select({
            id: notificationEmailQueue.id,
            storeId: notificationEmailQueue.storeId,
            email: notificationEmailQueue.email,
            eventKey: notificationEmailQueue.eventKey,
            lastError: notificationEmailQueue.lastError,
            createdAt: notificationEmailQueue.createdAt,
          })
          .from(notificationEmailQueue)
          .where(
            and(
              eq(notificationEmailQueue.status, "failed"),
              storeFilter(scope, notificationEmailQueue.storeId),
            ),
          )
          .orderBy(desc(notificationEmailQueue.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: `notification:${r.id}`,
          source: "notification" as const,
          title: `"${r.eventKey}" never reached ${r.email}`,
          detail: r.lastError,
          occurredAt: r.createdAt,
          storeId: r.storeId,
          href: "/dashboard/settings/notifications",
        }));
      }),
  },
  {
    ...meta("refund"),
    fetch: (scope, limit) =>
      withService(async (db) => {
        const rows = await db
          .select({
            id: orderRefunds.id,
            storeId: orderRefunds.storeId,
            orderId: orderRefunds.orderId,
            amount: orderRefunds.amount,
            method: orderRefunds.method,
            reason: orderRefunds.reason,
            createdAt: orderRefunds.createdAt,
          })
          .from(orderRefunds)
          .where(
            and(
              eq(orderRefunds.status, "failed"),
              storeFilter(scope, orderRefunds.storeId),
            ),
          )
          .orderBy(desc(orderRefunds.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: `refund:${r.id}`,
          source: "refund" as const,
          title: `${r.method} refund of ₹${r.amount} failed`,
          detail: r.reason,
          occurredAt: r.createdAt,
          storeId: r.storeId,
          href: r.orderId ? `/dashboard/orders?id=${r.orderId}` : null,
        }));
      }),
  },
  {
    ...meta("import"),
    fetch: (scope, limit) =>
      withService(async (db) => {
        const rows = await db
          .select({
            id: dataJobs.id,
            storeId: dataJobs.storeId,
            kind: dataJobs.kind,
            resource: dataJobs.resource,
            status: dataJobs.status,
            error: dataJobs.error,
            failedCount: dataJobs.failedCount,
            createdAt: dataJobs.createdAt,
          })
          .from(dataJobs)
          .where(
            and(
              inArray(dataJobs.status, ["failed", "partial"]),
              storeFilter(scope, dataJobs.storeId),
            ),
          )
          .orderBy(desc(dataJobs.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: `import:${r.id}`,
          source: "import" as const,
          title:
            r.status === "partial"
              ? `${r.resource} ${r.kind} finished with ${r.failedCount} rejected row(s)`
              : `${r.resource} ${r.kind} failed`,
          detail: r.error,
          occurredAt: r.createdAt,
          storeId: r.storeId,
          href: `/dashboard/logs/import-export/${r.id}`,
        }));
      }),
  },
  {
    ...meta("indexing"),
    fetch: (scope, limit) =>
      withService(async (db) => {
        const rows = await db
          .select({
            storeId: stores.id,
            slug: stores.slug,
            error: sql<
              string | null
            >`${stores.settings}->>'google_indexing_error'`,
            attemptedAt: sql<
              string | null
            >`${stores.settings}->>'google_indexing_attempted_at'`,
            updatedAt: stores.updatedAt,
          })
          .from(stores)
          .where(
            and(
              sql`nullif(btrim(${stores.settings}->>'google_indexing_error'), '') is not null`,
              storeFilter(scope, stores.id),
            ),
          )
          .orderBy(
            desc(
              sql`coalesce(${stores.settings}->>'google_indexing_attempted_at', ${stores.updatedAt}::text)`,
            ),
          )
          .limit(limit);
        return rows.map((row) => {
          const attemptedAt =
            row.attemptedAt &&
            Number.isFinite(new Date(row.attemptedAt).getTime())
              ? row.attemptedAt
              : row.updatedAt;
          return {
            id: `indexing:${row.storeId}:${attemptedAt}`,
            source: "indexing" as const,
            title: "Google Search coverage update failed",
            detail: row.error,
            occurredAt: attemptedAt,
            storeId: row.storeId,
            href:
              scope.kind === "store"
                ? "/dashboard/settings/domain"
                : `https://${row.slug}.${ROOT_DOMAIN}/dashboard/settings/domain`,
          };
        });
      }),
  },
  {
    ...meta("payment"),
    fetch: (scope, limit) =>
      withService(async (db) => {
        const rows = await db
          .select({
            id: orders.id,
            storeId: orders.storeId,
            orderRef: orders.orderRef,
            total: orders.total,
            createdAt: orders.createdAt,
          })
          .from(orders)
          .where(
            and(
              eq(orders.paymentStatus, "failed"),
              isNotNull(orders.orderRef),
              storeFilter(scope, orders.storeId),
            ),
          )
          .orderBy(desc(orders.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: `payment:${r.id}`,
          source: "payment" as const,
          title: `Payment failed on ${r.orderRef}`,
          detail: `₹${r.total}`,
          occurredAt: r.createdAt,
          storeId: r.storeId,
          href: `/dashboard/orders?id=${r.id}`,
        }));
      }),
  },
  {
    ...meta("subscription"),
    fetch: (scope, limit) =>
      withService(async (db) => {
        const rows = await db
          .select({
            id: billingPaymentAttempts.id,
            storeId: billingPaymentAttempts.storeId,
            amountPaise: billingPaymentAttempts.amountPaise,
            failureReason: billingPaymentAttempts.failureReason,
            failureCode: billingPaymentAttempts.failureCode,
            resolvedAt: billingPaymentAttempts.resolvedAt,
            createdAt: billingPaymentAttempts.createdAt,
          })
          .from(billingPaymentAttempts)
          .where(
            and(
              eq(billingPaymentAttempts.state, "failed"),
              storeFilter(scope, billingPaymentAttempts.storeId),
            ),
          )
          .orderBy(desc(billingPaymentAttempts.createdAt))
          .limit(limit);
        return rows.map((r) => ({
          id: `subscription:${r.id}`,
          source: "subscription" as const,
          title: `Subscription payment failed — ₹${(r.amountPaise / 100).toLocaleString("en-IN")}`,
          // The code is ours and the reason is the gateway's; either alone is
          // often not enough to act on.
          detail: r.failureReason ?? r.failureCode,
          // ★ WHEN IT FAILED, not when it started. An attempt can sit in flight
          // for days (reconciliation waits 72h), so `created_at` would put a
          // fresh failure days down a feed sorted by time.
          occurredAt: r.resolvedAt ?? r.createdAt,
          storeId: r.storeId,
          href: "/dashboard/plans",
        }));
      }),
  },
];

/**
 * Merge, newest first, and cap. Pure — the ordering rule is the part worth
 * testing, and it needs no database to exercise.
 *
 * Ties break on `id` so a page of failures sharing a timestamp (a batch that
 * failed together, which is the COMMON case) renders in a stable order rather
 * than shuffling between refreshes.
 */
export function mergeFailures(
  lists: FailureRow[][],
  limit: number = DEFAULT_LIMIT,
): FailureRow[] {
  return lists
    .flat()
    .sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

export interface FailureFeed {
  rows: FailureRow[];
  /** Sources that threw, so a partial answer never looks like a clean one. */
  failedSources: FailureSourceKey[];
}

/**
 * Collect failures for a scope.
 *
 * ★ One source erroring must not blank the page — the whole point of this view
 * is to be readable when things are broken, and a Postgres hiccup on one table
 * is precisely when you are looking at it. Failed sources are NAMED in the
 * result instead, so a short list can't be misread as "nothing failed".
 */
export async function collectFailures(
  scope: FailureScope,
  opts: {
    sources?: FailureSourceKey[];
    limit?: number;
    /** Injectable for tests, like runRetentionSweep's `policies`. */
    registry?: FailureSource[];
  } = {},
): Promise<FailureFeed> {
  const { sources, limit = DEFAULT_LIMIT, registry = FAILURE_SOURCES } = opts;
  const active = sources?.length
    ? registry.filter((s) => sources.includes(s.key))
    : registry;

  const failedSources: FailureSourceKey[] = [];
  const results = await Promise.all(
    active.map(async (source) => {
      try {
        return await source.fetch(scope, PER_SOURCE_LIMIT);
      } catch (error) {
        logError(`failures: ${source.key} source failed`, error);
        failedSources.push(source.key);
        return [] as FailureRow[];
      }
    }),
  );

  return { rows: mergeFailures(results, limit), failedSources };
}

/**
 * Store id → name, for the operator view's Store column.
 *
 * Looked up from the ids actually present rather than joined into every
 * source query: five joins to add one column that only one of the two callers
 * renders. Returns {} on error — a missing store name degrades to "—", and
 * failing the whole page over a label would be the wrong trade on a view whose
 * job is to work when things are broken.
 */
export async function storeNamesFor(
  ids: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return {};
  try {
    return await withService(async (db) => {
      const rows = await db
        .select({ id: stores.id, name: stores.name })
        .from(stores)
        .where(inArray(stores.id, unique));
      return Object.fromEntries(rows.map((r) => [r.id, r.name]));
    });
  } catch (error) {
    logError("failures: store name lookup failed", error);
    return {};
  }
}
