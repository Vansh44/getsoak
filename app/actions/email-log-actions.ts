"use server";

// ---------------------------------------------------------------------------
// Email logs — the read side of lib/email/send.ts.
//
// One question this answers that nothing else could: "did that email actually
// go out, and what did it say?" Every send now leaves a row here (see the
// choke point in lib/email/send.ts), so a merchant can check an order
// confirmation without anyone reading server logs.
//
// Gated on the `activity` permission section — this IS an activity log, and it
// lives under that nav entry, so it inherits the same access rule rather than
// inventing a second one for the same kind of data.
// ---------------------------------------------------------------------------

import { and, count, desc, eq, gte, ilike, isNull, or } from "drizzle-orm";
import { headers } from "next/headers";
import { withService } from "@/lib/db/client";
import { emailLogs } from "@/drizzle/schema";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { isPlatformHost } from "@/lib/store/host";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import { logError } from "@/lib/observability/logger";
import { MAILER_KEYS } from "@/lib/email/mailers";

// Not exported: a "use server" module may only export async functions. The
// value travels back on the result instead, so the page never keeps its own
// copy that can drift out of step with the query.
const PAGE_SIZE = 25;

export interface EmailLogRow {
  id: string;
  to: string;
  from: string;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  mailer: string;
  provider: string;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface EmailLogResult {
  rows: EmailLogRow[];
  total: number;
  /** Rows per page, so the caller's pagination matches the query exactly. */
  pageSize: number;
  /** Per-status tallies for the filter chips, over the whole (unfiltered) scope. */
  counts: Record<string, number>;
  error?: string;
}

export interface EmailLogFilters {
  page?: number;
  status?: string;
  mailer?: string;
  q?: string;
  /** Days back; 0/undefined = all time. */
  days?: number;
}

/**
 * Scope is HOST-derived, exactly like the notification console: the store for a
 * store host, PLATFORM (store_id IS NULL) for storemink.com. Deliberately NOT
 * getCurrentStoreId() alone, whose never-null fallback would show the WholeSip
 * store's mail on the platform console.
 */
async function currentScope(): Promise<{ storeId: string | null }> {
  const headersList = await headers();
  const host =
    headersList.get("x-forwarded-host") || headersList.get("host") || "";
  if (isPlatformHost(host)) return { storeId: null };
  return { storeId: await getCurrentStoreId() };
}

function scopeFilter(storeId: string | null) {
  return storeId ? eq(emailLogs.storeId, storeId) : isNull(emailLogs.storeId);
}

const STATUSES = ["sent", "failed", "skipped"];

export async function getEmailLogs(
  filters: EmailLogFilters = {},
): Promise<EmailLogResult> {
  const access = await getViewerAccess();
  if (!access) {
    return {
      rows: [],
      total: 0,
      pageSize: PAGE_SIZE,
      counts: {},
      error: "Not signed in.",
    };
  }
  if (!access.can("activity", "view")) {
    return {
      rows: [],
      total: 0,
      pageSize: PAGE_SIZE,
      counts: {},
      error: "You don't have access to activity logs.",
    };
  }

  const { storeId } = await currentScope();
  const page = Math.max(1, filters.page ?? 1);

  // Validate every filter against a fixed list rather than trusting the query
  // string — these go straight into a WHERE.
  const status =
    filters.status && STATUSES.includes(filters.status) ? filters.status : "";
  const mailer =
    filters.mailer &&
    (MAILER_KEYS as readonly string[]).includes(filters.mailer)
      ? filters.mailer
      : "";
  const q = (filters.q ?? "").trim().slice(0, 200);
  const days = Math.min(Math.max(0, filters.days ?? 0), 365);

  const statusCondition = status ? eq(emailLogs.status, status) : undefined;
  // Recipient or subject — the two things someone actually searches by.
  // `%` and `_` are ILIKE wildcards, so a search for "a_b" must not match
  // "axb"; escape them (and the escape char) before interpolating.
  const searchCondition = q
    ? or(
        ilike(emailLogs.toEmail, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
        ilike(emailLogs.subject, `%${q.replace(/[%_\\]/g, "\\$&")}%`),
      )
    : undefined;

  const conditions = [
    scopeFilter(storeId),
    ...(mailer ? [eq(emailLogs.mailer, mailer)] : []),
    ...(days > 0
      ? [
          gte(
            emailLogs.createdAt,
            new Date(Date.now() - days * 86_400_000).toISOString(),
          ),
        ]
      : []),
    ...(statusCondition ? [statusCondition] : []),
    ...(searchCondition ? [searchCondition] : []),
  ];

  try {
    // Sequential, not Promise.all — one pooled connection per scoped
    // transaction serves one query at a time (see order-actions.ts).
    const rows = await withService((db) =>
      db
        .select({
          id: emailLogs.id,
          to: emailLogs.toEmail,
          from: emailLogs.fromEmail,
          cc: emailLogs.cc,
          bcc: emailLogs.bcc,
          subject: emailLogs.subject,
          mailer: emailLogs.mailer,
          provider: emailLogs.provider,
          status: emailLogs.status,
          error: emailLogs.error,
          createdAt: emailLogs.createdAt,
        })
        .from(emailLogs)
        .where(and(...conditions))
        .orderBy(desc(emailLogs.createdAt))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE),
    );

    const totalRows = await withService((db) =>
      db
        .select({ n: count() })
        .from(emailLogs)
        .where(and(...conditions)),
    );

    // Status tallies deliberately ignore the STATUS filter (but honour the
    // others), so the chips keep showing what else is there instead of
    // collapsing to whatever is currently selected.
    const chipConditions = conditions.filter(
      (c) => c !== statusCondition && c !== searchCondition,
    );
    const counts: Record<string, number> = {};
    for (const s of STATUSES) {
      const tally = await withService((db) =>
        db
          .select({ n: count() })
          .from(emailLogs)
          .where(and(...chipConditions, eq(emailLogs.status, s))),
      );
      counts[s] = tally[0]?.n ?? 0;
    }

    return { rows, total: totalRows[0]?.n ?? 0, pageSize: PAGE_SIZE, counts };
  } catch (error) {
    logError("getEmailLogs failed", error);
    return {
      rows: [],
      total: 0,
      pageSize: PAGE_SIZE,
      counts: {},
      error: "Could not load email logs.",
    };
  }
}

export interface EmailLogDetail extends EmailLogRow {
  bodyHtml: string | null;
  providerMessageId: string | null;
}

/**
 * One logged email, including its rendered body.
 *
 * The body is NULL for sensitive mailers — an OTP or invite carries a live
 * credential, so lib/email/send.ts never stores it (see lib/email/mailers.ts).
 * The UI says so rather than showing an empty frame.
 */
export async function getEmailLog(
  id: string,
): Promise<{ log?: EmailLogDetail; error?: string }> {
  const access = await getViewerAccess();
  if (!access) return { error: "Not signed in." };
  if (!access.can("activity", "view")) {
    return { error: "You don't have access to activity logs." };
  }

  const { storeId } = await currentScope();

  try {
    // The store filter IS the tenancy boundary here: email_logs is service-role
    // only (RLS on, no policies), so it must never be dropped.
    const rows = await withService((db) =>
      db
        .select({
          id: emailLogs.id,
          to: emailLogs.toEmail,
          from: emailLogs.fromEmail,
          cc: emailLogs.cc,
          bcc: emailLogs.bcc,
          subject: emailLogs.subject,
          mailer: emailLogs.mailer,
          provider: emailLogs.provider,
          status: emailLogs.status,
          error: emailLogs.error,
          createdAt: emailLogs.createdAt,
          bodyHtml: emailLogs.bodyHtml,
          providerMessageId: emailLogs.providerMessageId,
        })
        .from(emailLogs)
        .where(and(eq(emailLogs.id, id), scopeFilter(storeId)))
        .limit(1),
    );
    const log = rows[0];
    if (!log) return { error: "That email log entry no longer exists." };
    return { log };
  } catch (error) {
    logError("getEmailLog failed", error, { id });
    return { error: "Could not load that email." };
  }
}
