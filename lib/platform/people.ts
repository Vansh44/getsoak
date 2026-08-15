import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";

// ---------------------------------------------------------------------------
// Everyone who can sign in to a merchant store, across every store.
//
// ── ★ TWO TABLES, ONE QUESTION ─────────────────────────────────────────────
// `admins` is a DASHBOARD login (the owner, plus whoever they delegated to);
// `pos_staff` is a TILL login with a PIN and no dashboard access at all. They
// are unioned because the operator's question is "who has access to this
// store?", and answering it previously required two queries nobody had a
// screen for.
//
// ★ `kind` IS NEVER COLLAPSED. A dashboard admin and a cashier are different
// access with different blast radii, and a list that flattened them would make
// revoking the wrong one look identical to revoking the right one.
//
// ★ THE SAME PERSON MAY APPEAR TWICE, AND THAT IS CORRECT. A shop owner who
// also rings the till has an `admins` row AND a `pos_staff` row — two separate
// credentials that are revoked separately. Deduplicating by email would hide
// one of them, which is the opposite of what this screen is for.
//
// ── ★ IT NEVER RETURNS A CREDENTIAL ────────────────────────────────────────
// No `pin_hash`, no `invite_token`, no `reset_token`. Each is live and usable,
// and none of them answers an operator's question. Same rule as
// `loadStorePeople`.
// ---------------------------------------------------------------------------

export type PersonKind = "admin" | "pos";

export interface PlatformPerson {
  id: string;
  kind: PersonKind;
  name: string;
  email: string;
  /** `superadmin`/`member`/a custom role for admins; `cashier`/`manager` for POS. */
  role: string;
  status: string;
  createdAt: string;
  storeId: string;
  storeName: string;
  storeSlug: string;
}

export interface PeopleQuery {
  q?: string;
  kind?: PersonKind | "";
  /** Restrict to one store — how the store detail page deep-links here. */
  storeId?: string;
  page?: number;
}

export interface PeoplePage {
  rows: PlatformPerson[];
  total: number;
  page: number;
  pageSize: number;
  /** How the total splits, for the filter chips. Unaffected by `kind`. */
  counts: { all: number; admin: number; pos: number };
  ok: boolean;
}

export const PEOPLE_PAGE_SIZE = 50;

const EMPTY: PeoplePage = {
  rows: [],
  total: 0,
  page: 1,
  pageSize: PEOPLE_PAGE_SIZE,
  counts: { all: 0, admin: 0, pos: 0 },
  ok: false,
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * One page of people.
 *
 * ★ THE LIST AND THE COUNT SHARE ONE PREDICATE, built once as `where`. Two
 * hand-written copies is how a list ends up saying "showing 50 of 212" while
 * paging past 4 lands on an empty screen.
 */
export async function listPlatformPeople(
  query: PeopleQuery = {},
): Promise<PeoplePage> {
  const page = Math.max(1, query.page ?? 1);
  const offset = (page - 1) * PEOPLE_PAGE_SIZE;
  // Bound the term. It is a BOUND PARAMETER below, not interpolated, so this
  // is a sanity limit rather than the injection defence.
  const term = (query.q ?? "").trim().slice(0, 80);
  const kind = query.kind === "admin" || query.kind === "pos" ? query.kind : "";

  try {
    return await withService(async (db) => {
      // Built once and reused: `narrowing` is everything EXCEPT the kind
      // filter, so the chip counts can keep reporting what the other chip
      // would give you (see below).
      const narrowing: SQL[] = [];
      if (term) {
        const like = `%${term}%`;
        narrowing.push(
          sql`(p.name ilike ${like} or p.email ilike ${like} or p.store_name ilike ${like})`,
        );
      }
      if (query.storeId) narrowing.push(sql`p.store_id = ${query.storeId}`);

      const rowFilters = kind
        ? [...narrowing, sql`p.kind = ${kind}`]
        : narrowing;

      const clause = (parts: SQL[]) =>
        parts.length ? sql`where ${sql.join(parts, sql` and `)}` : sql``;

      const where = clause(rowFilters);

      // The union is a CTE so the filters, the count and the kind split all
      // read the same shape rather than being repeated three times.
      const base = sql`
        with people as (
          select
            a.id::text as id,
            'admin'::text as kind,
            nullif(trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')), '') as name,
            a.email,
            a.role,
            case when a.is_suspended then 'suspended' else 'active' end as status,
            a.created_at,
            a.store_id,
            s.name as store_name,
            s.slug as store_slug
          from admins a
          join stores s on s.id = a.store_id
          union all
          select
            ps.id::text as id,
            'pos'::text as kind,
            ps.name,
            ps.email,
            ps.role,
            case when not ps.active then 'inactive' else ps.status end as status,
            ps.created_at,
            ps.store_id,
            s.name as store_name,
            s.slug as store_slug
          from pos_staff ps
          join stores s on s.id = ps.store_id
        )
      `;

      const rowsResult = await db.execute(sql`
        ${base}
        select * from people p
        ${where}
        order by p.created_at desc
        limit ${PEOPLE_PAGE_SIZE} offset ${offset}
      `);

      // ★ THE CHIP COUNTS IGNORE THE KIND FILTER, and that is the point: they
      // are counted under `narrowing` alone, so selecting "Till staff" still
      // shows how many dashboard admins the same search would return. Counting
      // them under the full filter would make every unselected chip read zero,
      // which is a dead end rather than a filter.
      const countResult = await db.execute(sql`
        ${base}
        select
          count(*)::int as all_count,
          count(*) filter (where p.kind = 'admin')::int as admin_count,
          count(*) filter (where p.kind = 'pos')::int as pos_count
        from people p
        ${clause(narrowing)}
      `);

      const c = (countResult.rows[0] ?? {}) as Record<string, unknown>;
      const counts = {
        all: num(c.all_count),
        admin: num(c.admin_count),
        pos: num(c.pos_count),
      };

      return {
        rows: rowsResult.rows.map((r) => {
          const row = r as Record<string, unknown>;
          return {
            id: String(row.id),
            kind: row.kind === "pos" ? ("pos" as const) : ("admin" as const),
            name: typeof row.name === "string" ? row.name : "",
            email: String(row.email ?? ""),
            role: String(row.role ?? ""),
            status: String(row.status ?? ""),
            createdAt: String(row.created_at),
            storeId: String(row.store_id),
            storeName: String(row.store_name ?? ""),
            storeSlug: String(row.store_slug ?? ""),
          };
        }),
        total: kind ? counts[kind] : counts.all,
        page,
        pageSize: PEOPLE_PAGE_SIZE,
        counts,
        ok: true,
      };
    });
  } catch (error) {
    logError("listPlatformPeople failed", error);
    return { ...EMPTY, page };
  }
}
