/**
 * Publish version 1 of StoreMink's policies into legal_documents.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/seed-legal.ts
 *
 * ⚠ `--tsconfig` is NOT optional. lib/legal/store.ts imports `server-only`,
 * which Next's bundler provides and npm never installs, so a plain `npx tsx`
 * dies with "Cannot find module 'server-only'". That tsconfig maps it to
 * scripts/_stubs/server-only.ts. (This line said plain `npx tsx` until
 * 2026-08-01 — the stub arrived after the script did.)
 *
 * ⚠ CHECK WHICH DATABASE YOU ARE SEEDING. `.env` points at STAGING
 * (DB_NAME=storemink_staging), and staging + prod are two databases in ONE
 * Cloud SQL instance, so the proxy being up says nothing about which one you
 * hit. A shell variable beats .env, so prod is:
 *
 *   DB_NAME=storemink npx tsx --tsconfig tsconfig.scripts.json scripts/seed-legal.ts
 *
 * Idempotent: a kind that already has a current version is skipped, and a
 * published row cannot be edited (the DB enforces it), so re-running is safe.
 * Needs the Cloud SQL proxy up and .env loaded — the same as any DB script.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, {
  info: () => {},
  error: () => {},
});

async function main() {
  // Imported AFTER the env is loaded: lib/db/client builds its pool from
  // process.env at module scope.
  const { ensureLegalSeeded, getCurrentDoc } =
    await import("@/lib/legal/store");
  const { LEGAL_DOCS } = await import("@/lib/legal/documents");

  const { published } = await ensureLegalSeeded();
  console.log(
    published.length
      ? `Published: ${published.join(", ")}`
      : "Nothing to publish — every policy already has a current version.",
  );

  for (const def of LEGAL_DOCS) {
    const doc = await getCurrentDoc(def.kind);
    console.log(
      doc
        ? `  ✓ ${def.kind.padEnd(16)} v${doc.version}  ${doc.body.length} bytes`
        : `  ✗ ${def.kind.padEnd(16)} MISSING`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
