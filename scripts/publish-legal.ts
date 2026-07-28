/**
 * Publish a new version of StoreMink's policies.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/publish-legal.ts            # dry run
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/publish-legal.ts --publish  # commit
 *
 * HOW TO CHANGE A POLICY:
 *   1. Edit the body in lib/legal/content.ts
 *   2. Bump that document's `version` in the same file
 *   3. Run this with --publish
 *
 * WHY EDITING ISN'T ENOUGH. A published row is immutable — the DB rejects any
 * UPDATE to its body (legal_documents_guard), because an acceptance saying
 * "agreed to v1" is worthless if v1's text can be rewritten afterwards. So a
 * change is always a NEW version: the old row stays exactly as the people who
 * accepted it saw it, and `is_current` moves to the new one.
 *
 * WHY IT'S DRY-RUN BY DEFAULT. Publishing cannot be undone (published versions
 * can't be edited or deleted) and, once the re-acceptance gate is live, it
 * interrupts every merchant on their next dashboard load. That is worth a
 * deliberate second command rather than a fast one.
 *
 * Needs the Cloud SQL proxy up and .env loaded, like any DB script.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, {
  info: () => {},
  error: () => {},
});

const COMMIT = process.argv.includes("--publish");

async function main() {
  // Imported AFTER the env is loaded: lib/db/client builds its pool from
  // process.env at module scope.
  const { getCurrentDoc, publishLegalVersion, listLegalVersions } =
    await import("@/lib/legal/store");
  const { LEGAL_CONTENT } = await import("@/lib/legal/content");
  const { checksumBody } = await import("@/lib/legal/documents");

  // ---- What would change -------------------------------------------------
  const planned: { kind: string; from: number | null; to: number }[] = [];

  console.log(
    COMMIT
      ? "Publishing policy versions:\n"
      : "DRY RUN — nothing will be written:\n",
  );

  for (const content of LEGAL_CONTENT) {
    const current = await getCurrentDoc(content.kind);
    const label = content.kind.padEnd(16);

    if (!current) {
      console.log(`  ${label} NOT PUBLISHED → v${content.version}`);
      planned.push({ kind: content.kind, from: null, to: content.version });
      continue;
    }

    if (content.version === current.version) {
      // Same version number, but is the text the same? A body edited without a
      // version bump is the mistake this script exists to catch — silently
      // doing nothing would leave someone convinced they had published it.
      const checksum = await checksumBody(content.body);
      const drifted = checksum !== current.checksum;
      console.log(
        drifted
          ? `  ${label} v${current.version} current — ⚠ LOCAL TEXT DIFFERS, bump the version to publish it`
          : `  ${label} v${current.version} current — unchanged`,
      );
      continue;
    }

    if (content.version < current.version) {
      console.log(
        `  ${label} v${current.version} current — ⚠ local says v${content.version}, refusing to go backwards`,
      );
      continue;
    }

    console.log(`  ${label} v${current.version} → v${content.version}`);
    planned.push({
      kind: content.kind,
      from: current.version,
      to: content.version,
    });
  }

  if (planned.length === 0) {
    console.log("\nNothing to publish.");
    process.exit(0);
  }

  if (!COMMIT) {
    console.log(
      `\n${planned.length} document(s) would be published.` +
        "\nRe-run with --publish to commit. Published versions cannot be edited or deleted.",
    );
    process.exit(0);
  }

  // ---- Commit ------------------------------------------------------------
  console.log("");
  let failed = 0;
  for (const item of planned) {
    const content = LEGAL_CONTENT.find((c) => c.kind === item.kind)!;
    const result = await publishLegalVersion(content, "script");
    const label = result.kind.padEnd(16);
    if (result.status === "published") {
      console.log(`  ✓ ${label} v${result.toVersion} published`);
    } else {
      failed++;
      console.log(`  ✗ ${label} ${result.status}: ${result.message ?? ""}`);
    }
  }

  // ---- Show the resulting history ---------------------------------------
  console.log("\nVersion history:");
  for (const content of LEGAL_CONTENT) {
    const versions = await listLegalVersions(content.kind);
    const trail = versions
      .map((v) => (v.isCurrent ? `[v${v.version}]` : `v${v.version}`))
      .join(" ← ");
    console.log(`  ${content.kind.padEnd(16)} ${trail || "(none)"}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} document(s) failed to publish.`);
    process.exit(1);
  }

  console.log(
    "\nDone. Existing merchants will be asked to accept on their next dashboard load.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
