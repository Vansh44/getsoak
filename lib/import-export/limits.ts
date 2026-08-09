// Import limits.
//
// These live in `lib/` rather than beside the code that enforces them because a
// `"use server"` file may only export ASYNC FUNCTIONS — everything exported
// from one is a public endpoint. The same reason `lib/pos/tenders.ts` holds the
// tender allowlist (CODEBASE §23). The browser needs both numbers to refuse an
// oversized file before uploading it, and the upload route enforces both again.
//
// `IMPORT_CHUNK_ROWS` is gone with the browser-driven chunking it sized. The
// worker's slice is bounded by TIME (`SLICE_BUDGET_MS` in worker.ts), because
// rows differ by an order of magnitude in cost.

/**
 * Rows one import may carry.
 *
 * Not a licensing limit — a ceiling on how much damage a single mistaken
 * upload can do in one go, and on how long a merchant sits watching a progress
 * bar. A genuinely larger catalogue splits into files, which is also how
 * anyone would want to review it.
 */
export const MAX_IMPORT_ROWS = 50_000;

/**
 * Bytes we will read from a picked file.
 *
 * Enforced in the browser before anything is parsed: reading a 500 MB CSV into
 * a string freezes the tab before any of our own code gets to run, so a row
 * limit alone is too late.
 */
export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
