/**
 * Publish version 1 of StoreMink's policies into legal_documents.
 *
 *   npx tsx scripts/seed-legal.ts
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
