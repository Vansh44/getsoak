"use server";

// ---------------------------------------------------------------------------
// Reading the SMS log (§37). The email-log shape, gated on the SAME `activity`
// section — this is an audit trail, and a second permission for the same class
// of data is a grant somebody forgets to give.
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { withService } from "@/lib/db/client";
import { getViewerAccess } from "@/app/dashboard/lib/access";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { isPlatformHost } from "@/lib/store/host";
import { logError } from "@/lib/observability/logger";

export interface SmsLogRow {
  id: string;
  to_phone: string;
  sender_header: string | null;
  event_key: string | null;
  body: string | null;
  segments: number;
  status: string;
  error: string | null;
  created_at: string;
}

export interface SmsLogPage {
  rows: SmsLogRow[];
  total: number;
  pageSize: number;
  counts: { sent: number; failed: number; skipped: number };
  /** Total segments in the window — what the merchant was BILLED. */
  segments: number;
  error?: string;
}

const PAGE_SIZE = 50;

const EMPTY: SmsLogPage = {
  rows: [],
  total: 0,
  pageSize: PAGE_SIZE,
  counts: { sent: 0, failed: 0, skipped: 0 },
  segments: 0,
};

/**
 * Scope is HOST-derived, exactly as `getEmailLogs` does it: the store for a
 * store host, PLATFORM (`store_id IS NULL`) for storemink.com.
 *
 * ★ DELIBERATELY NOT `getActingStoreId()` ALONE. Its never-null fallback
 * resolves the WholeSip store, so on the operator console this read would have
 * quietly served one merchant's SMS log as though it were the platform's.
 */
async function currentScope(): Promise<{
  storeId: string | null;
  platform: boolean;
}> {
  const headersList = await headers();
  const host =
    headersList.get("x-forwarded-host") || headersList.get("host") || "";
  if (isPlatformHost(host)) return { storeId: null, platform: true };
  return { storeId: await getCurrentStoreId(), platform: false };
}

export async function getSmsLogs(input: {
  page?: number;
  status?: string;
  q?: string;
  days?: number;
}): Promise<SmsLogPage> {
  const access = await getViewerAccess();
  if (!access) return { ...EMPTY, error: "Not signed in." };
  if (!access.can("activity", "view")) {
    return { ...EMPTY, error: "You don't have access to logs." };
  }

  const { storeId, platform } = await currentScope();
  // A server action is an independently reachable POST endpoint, so the page
  // gate is not enough — the platform scope re-checks operator membership.
  if (platform && !access.isPlatformAdmin) {
    return {
      ...EMPTY,
      error: "Only StoreMink operators can view platform SMS logs.",
    };
  }

  const page = Math.max(1, Math.floor(input.page ?? 1));
  const offset = (page - 1) * PAGE_SIZE;

  // ★ Re-validated here, not trusted from the URL. `status` reaches a SQL
  // predicate, so it is an ALLOWLIST rather than a sanitiser.
  const status =
    input.status && ["sent", "failed", "skipped"].includes(input.status)
      ? input.status
      : null;
  const days = Number.isFinite(input.days)
    ? Math.min(Number(input.days), 365)
    : 0;
  const q = (input.q ?? "").trim().slice(0, 60);

  // Kept as two lists rather than one with the status spliced out by index:
  // the counts query needs everything EXCEPT status, and an index-based removal
  // silently drops the wrong predicate the moment a filter is added above it.
  const base = [
    storeId ? sql`store_id = ${storeId}::uuid` : sql`store_id is null`,
  ];
  if (days > 0)
    base.push(sql`created_at > now() - (${days} || ' days')::interval`);
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    base.push(sql`(to_phone ilike ${pattern} or event_key ilike ${pattern})`);
  }
  const baseWhere = sql.join(base, sql` and `);
  const where = status
    ? sql.join([baseWhere, sql`status = ${status}`], sql` and `)
    : baseWhere;

  try {
    const [rows, summary] = await Promise.all([
      withService((db) =>
        db.execute(sql`
          select id, to_phone, sender_header, event_key, body, segments,
                 status, error, created_at
            from public.sms_logs
           where ${where}
           order by created_at desc
           limit ${PAGE_SIZE} offset ${offset}
        `),
      ),
      // ★ Counts are computed over the SAME filters minus `status`, so the
      // status chips show what switching to them would find — a chip reading
      // "Failed 12" that lands on an empty page is worse than no chip.
      withService((db) =>
        db.execute(sql`
          select status, count(*)::int as n, coalesce(sum(segments), 0)::int as seg
            from public.sms_logs
           where ${baseWhere}
           group by status
        `),
      ),
    ]);

    const list = asRows(rows) as SmsLogRow[];
    const counts = { sent: 0, failed: 0, skipped: 0 };
    let segments = 0;
    let total = 0;
    for (const r of asRows(summary) as {
      status: string;
      n: number;
      seg: number;
    }[]) {
      if (r.status in counts) counts[r.status as keyof typeof counts] = r.n;
      segments += r.seg;
      if (!status || r.status === status) total += r.n;
    }

    return { rows: list, total, pageSize: PAGE_SIZE, counts, segments };
  } catch (err) {
    logError("sms log read failed", err, { storeId });
    // An outage is reported AS an outage — "no messages" would read as
    // "nothing was sent", which is the opposite of what happened.
    return { ...EMPTY, error: "Couldn't load the SMS log. Try again." };
  }
}

function asRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return ((result as { rows?: unknown[] })?.rows ?? []) as unknown[];
}
