// Turning what a cashier types into a safe LIKE pattern.
//
// Pure, and its own module because `pos-sale-actions.ts` is "use server" —
// every export there must be an async server action, so a small synchronous
// helper cannot live in it.

/**
 * Wrap a search term as a `%…%` pattern with the LIKE wildcards escaped.
 *
 * ★ The escape is the point. `%` and `_` are wildcards in LIKE, so a search
 * for "%" would match every row — and a customer whose name legitimately
 * contains one would match rows that have nothing to do with them. The
 * backslash itself is escaped first, or `\` in a name would neutralise the
 * escaping of whatever follows it.
 *
 * Pairs with Postgres's default LIKE escape character, so callers need no
 * ESCAPE clause.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
