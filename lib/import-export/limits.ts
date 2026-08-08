// Import limits.
//
// These live in `lib/` rather than beside the action that enforces them
// because a `"use server"` file may only export ASYNC FUNCTIONS — everything
// exported from one is a public endpoint. The same reason `lib/pos/tenders.ts`
// holds the tender allowlist (CODEBASE §23). The browser needs both numbers to
// size its chunks and refuse an oversized file before uploading it, and the
// server enforces both again.

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
 * Rows per request.
 *
 * Small enough to stay well inside the server-action body cap and the Cloud
 * Run request timeout even for products, whose rows carry a full description.
 * This, not `serverActions.bodySizeLimit`, is what actually bounds a request.
 */
export const IMPORT_CHUNK_ROWS = 200;

/**
 * Bytes we will read from a picked file.
 *
 * Enforced in the browser before anything is parsed: reading a 500 MB CSV into
 * a string freezes the tab before any of our own code gets to run, so a row
 * limit alone is too late.
 */
export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
