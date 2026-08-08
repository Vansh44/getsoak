/**
 * One-off: clear a stale `custom_domain_verified` on a store whose domain no
 * longer resolves, doing by hand exactly what §30's health check does on its own
 * (`lib/domains/reconcile.ts` — delete the key, reset the failure count).
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/clear-stale-domain.ts <slug>            # dry run
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/clear-stale-domain.ts <slug> --commit
 *
 * WHY THIS EXISTS. The revert is automatic on production, where
 * /api/cron/domain-reconcile runs hourly. It is NOT automatic anywhere else —
 * every Cloud Scheduler job targets https://storemink.com (docs/cron-jobs.md) —
 * so a staging store stuck on a dead domain has to be unstuck manually.
 *
 * `custom_domain` is deliberately LEFT IN PLACE: the merchant still intends to
 * use it, and clearing it would silently discard their setting rather than the
 * stale verdict about it.
 *
 * ⚠ CHECK WHICH DATABASE. `.env` points at STAGING
 * (DB_NAME=storemink_staging); a shell variable beats .env, so prod would be
 * `DB_NAME=storemink npx tsx ...`.
 *
 * Needs the Cloud SQL proxy up and .env loaded, like any DB script.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const slug = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!slug || slug.startsWith("--")) {
    console.error("usage: clear-stale-domain.ts <slug> [--commit]");
    process.exit(1);
  }

  // Imported AFTER the env is loaded: lib/db/client builds its pool from
  // process.env at module scope.
  const { withService } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");

  const before = (await withService((db) =>
    db.execute(sql`
      select slug, custom_domain,
             settings->>'custom_domain_verified' as verified
      from stores where slug = ${slug}`),
  )) as unknown as { rows: Record<string, unknown>[] };

  const row = before.rows?.[0];
  if (!row) {
    console.error(`no store with slug "${slug}" in ${process.env.DB_NAME}`);
    process.exit(1);
  }

  console.log(`DB_NAME = ${process.env.DB_NAME}`);
  console.log("before:", row);

  if (row.verified !== "true") {
    console.log("\nAlready un-verified — nothing to do.");
    return;
  }
  if (!commit) {
    console.log("\nDRY RUN. Re-run with --commit to apply.");
    return;
  }

  const after = (await withService((db) =>
    db.execute(sql`
      update stores
         set settings = settings
                        - 'custom_domain_verified'
                        - 'domain_health_failures'
                        - 'domain_health_checked_at'
       where slug = ${slug}
   returning slug, custom_domain,
             settings->>'custom_domain_verified' as verified`),
  )) as unknown as { rows: Record<string, unknown>[] };

  console.log("after: ", after.rows?.[0]);
  console.log(
    "\nDone. The 60s per-instance cache in lib/store/canonical.ts means it " +
      "takes up to a minute to take effect on a running instance.",
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
