// Helpers for interpreting errors thrown by the Drizzle/pg data layer.
// Drizzle may surface the pg error directly or wrapped (DrizzleQueryError with
// the pg error as `cause`), so always check both places.

export const UNIQUE_VIOLATION = "23505";
/** `undefined_table` — the relation does not exist. Raised when code that
 *  depends on a migration runs before that migration has been applied. */
export const UNDEFINED_TABLE = "42P01";
/** `undefined_function` — same situation, for a SECURITY DEFINER RPC. */
export const UNDEFINED_FUNCTION = "42883";
/** `undefined_column` — a migration that adds a column has not run yet. */
export const UNDEFINED_COLUMN = "42703";

/** The Postgres SQLSTATE code of a thrown DB error, if any. */
export function pgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === UNIQUE_VIOLATION;
}

/**
 * Is this error "the schema this code needs has not been applied yet"?
 *
 * ★ THIS IS WHAT MAKES A DEPLOY ORDER-INDEPENDENT. Database DDL is a separate
 * release gate from the application deploy (`drizzle/manual/README.md`), so
 * application code can and does reach production before its migration. A
 * feature that throws in that window takes down whatever it was added to —
 * which for an offer engine wired into checkout means every sale. Distinguish
 * it from a real failure and degrade, rather than treating every error the
 * same: a genuine outage must still be loud.
 */
export function isSchemaNotReady(err: unknown): boolean {
  const code = pgErrorCode(err);
  return (
    code === UNDEFINED_TABLE ||
    code === UNDEFINED_FUNCTION ||
    code === UNDEFINED_COLUMN
  );
}

/** Prefer the underlying pg message (the wrapper's message embeds the SQL). */
export function dbErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object") {
    const e = err as { message?: string; cause?: { message?: string } };
    return e.cause?.message ?? e.message ?? fallback;
  }
  return fallback;
}
