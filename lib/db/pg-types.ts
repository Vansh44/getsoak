import { types, type CustomTypesConfig } from "pg";

const TIMESTAMP_OIDS = new Set([
  types.builtins.TIMESTAMP,
  types.builtins.TIMESTAMPTZ,
]);

const identity = (value: string) => value;

/**
 * Drizzle's string-mode timestamp columns can preserve PostgreSQL's full
 * microsecond precision only when node-postgres supplies the original text.
 * Its default parser creates a JavaScript Date first, irreversibly truncating
 * the sub-millisecond digits used by Mink's optimistic-lock checkpoints.
 */
export const postgresStringTimestampTypes: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (
      (format === undefined || format === "text") &&
      TIMESTAMP_OIDS.has(oid)
    ) {
      return identity;
    }
    return types.getTypeParser(oid, format);
  }) as typeof types.getTypeParser,
};
