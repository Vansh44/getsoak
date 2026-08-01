// Structured logging for Google Cloud (Phase 2 of the GCP migration — see
// docs/gcp-migration-phase5-6.md and CODEBASE.md §7).
//
// WHY THIS SHAPE: Google Cloud Logging ingests structured logs with ZERO SDK,
// key, or network call — it parses JSON written to stdout/stderr and promotes
// the reserved fields `severity` and `message` into the log entry. On Cloud Run
// (Phase 4) that ingestion is automatic; ERROR-severity entries that carry a
// stack trace are additionally surfaced in Cloud Error Reporting. So instead of
// a heavyweight client library we just emit the right JSON:
//   * production  -> single-line JSON (Vercel captures it now; Cloud Logging
//                    auto-ingests it once we're on Cloud Run — no rework).
//   * development -> a readable "[SEVERITY] message {context}" line.
//
// Edge-safe: uses only `console` + `JSON.stringify` (no Node APIs), so it works
// in proxy.ts middleware as well as server actions and route handlers.

export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export type LogContext = Record<string, unknown>;

const isProd = process.env.NODE_ENV === "production";

function consoleFor(severity: Severity) {
  if (severity === "ERROR" || severity === "CRITICAL") return console.error;
  if (severity === "WARNING") return console.warn;
  return console.log;
}

function emit(severity: Severity, message: string, context?: LogContext) {
  const write = consoleFor(severity);
  if (isProd) {
    // Reserved keys `severity`/`message` are lifted by Cloud Logging; the rest
    // becomes the structured jsonPayload you can filter on.
    write(JSON.stringify({ severity, message, ...context }));
  } else {
    const ctx =
      context && Object.keys(context).length
        ? " " + JSON.stringify(context)
        : "";
    write(`[${severity}] ${message}${ctx}`);
  }
}

export const logDebug = (message: string, context?: LogContext) =>
  emit("DEBUG", message, context);

export const logInfo = (message: string, context?: LogContext) =>
  emit("INFO", message, context);

export const logWarn = (message: string, context?: LogContext) =>
  emit("WARNING", message, context);

/**
 * Log an error. Normalises any thrown value to an Error, and — in production —
 * appends the stack trace to the `message` field, which is where Cloud Error
 * Reporting looks to auto-detect and group errors from structured logs. The
 * error message + stack are ALSO kept as structured fields for querying.
 */
export function logError(
  message: string,
  error?: unknown,
  context?: LogContext,
) {
  const err =
    error instanceof Error
      ? error
      : error != null
        ? new Error(String(error))
        : undefined;

  // Put the stack in `message` (prod) so Error Reporting ingests it; the "\n"
  // before the stack is the format its parser expects.
  const fullMessage =
    isProd && err?.stack ? `${message}\n${err.stack}` : message;

  // `cause` matters more than it looks. A Drizzle failure's own message is
  // just "Failed query: insert into …" — the REASON (`column "x" does not
  // exist`, a constraint name, a type mismatch) lives on the cause, and
  // without it a schema drift in production reads as an unexplained failure
  // and has to be chased through the database's own logs instead.
  const cause =
    err?.cause instanceof Error
      ? err.cause.message
      : err?.cause != null
        ? String(err.cause)
        : undefined;

  emit("ERROR", fullMessage, {
    ...context,
    ...(err ? { error: err.message } : {}),
    ...(cause ? { cause } : {}),
  });
}
