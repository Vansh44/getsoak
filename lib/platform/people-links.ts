// Query-string building for the People directory. PURE — no server imports —
// so both the server page and the client search box use one implementation.
//
// ★ IT EXISTS BECAUSE DROPPING A FILTER IS SILENT. A "next page" link that
// forgets `?q=` turns a filtered list into an unfiltered one that still looks
// filtered, and the only symptom is rows the operator did not ask for. One
// builder, tested, beats three hand-written `URLSearchParams` blocks.

export interface PeopleFilters {
  q?: string;
  kind?: string;
  /** Store id, carried as `store` — the store detail page deep-links with it. */
  store?: string;
  page?: number;
}

const BASE = "/dashboard/people";

/**
 * The People URL for `filters`, with `overrides` applied on top.
 *
 * Empty strings and `page: 1` are omitted rather than serialised: `?page=1` and
 * `?q=` are noise in a shared URL, and a default that appears in the query
 * string invites someone to treat its absence as a different state.
 */
export function peopleHref(
  filters: PeopleFilters,
  overrides: PeopleFilters = {},
): string {
  const merged: PeopleFilters = { ...filters, ...overrides };
  const params = new URLSearchParams();

  if (merged.q) params.set("q", merged.q);
  if (merged.kind) params.set("kind", merged.kind);
  if (merged.store) params.set("store", merged.store);
  if (merged.page && merged.page > 1) params.set("page", String(merged.page));

  const qs = params.toString();
  return qs ? `${BASE}?${qs}` : BASE;
}
