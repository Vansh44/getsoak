/**
 * Read-only: every store carrying a custom domain, with the §30 gate + health
 * fields that decide whether its subdomain redirects there.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/inspect-domains.ts
 *
 * Needs the Cloud SQL proxy up and .env loaded, like any DB script. `.env`
 * points at STAGING (DB_NAME=storemink_staging).
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  // Imported AFTER the env is loaded: lib/db/client builds its pool from
  // process.env at module scope.
  const { withService } = await import("@/lib/db/client");
  const { sql } = await import("drizzle-orm");

  const res = (await withService((db) =>
    db.execute(sql`
      select slug, status, plan, custom_domain,
             settings->>'custom_domain_verified'   as verified,
             settings->>'domain_health_checked_at' as health_checked,
             settings->>'domain_health_failures'   as failures,
             settings->>'domain_pending_since'     as pending_since,
             settings->>'domain_cert_issue'        as cert_issue
      from stores
      where custom_domain is not null
      order by slug`),
  )) as unknown as { rows?: unknown[] };

  console.log("DB_NAME =", process.env.DB_NAME);
  console.table(res.rows ?? res);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
