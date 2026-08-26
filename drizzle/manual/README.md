# drizzle/manual — the reproducible Cloud SQL schema (GCP migration Phase 5)

These hand-maintained SQL files are the **source of truth for creating a fresh
Cloud SQL database** (local scratch / staging / prod-at-cutover). Apply them
**in order**, as the `postgres` (admin) user:

```bash
psql "$CONN" -v ON_ERROR_STOP=1 -f drizzle/manual/0000_compat_setup.sql
psql "$CONN" -v ON_ERROR_STOP=1 -f drizzle/manual/0001_schema.sql
psql "$CONN" -v ON_ERROR_STOP=1 -f drizzle/manual/0002_postflight.sql
```

| File                    | What it does                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0000_compat_setup.sql` | `pg_trgm`; the `auth.uid()`/`auth.email()` GUC shim (the 2A tenancy model); the Supabase placeholder roles + the `app_user`/`app_service` roles + grants; a **stub `auth.users`** so the next file's FKs load. |
| `0001_schema.sql`       | The **faithful full schema** (`pg_dump --schema-only` from the source Postgres): 38 functions, 43 tables, indexes, **99 complete RLS policies**, 21 triggers.                                                  |
| `0002_postflight.sql`   | Drops the `auth.users` FKs + stub (identity is external), and re-grants the app roles over everything `0001` created.                                                                                          |

Result: **43 tables · 38 functions · 21 triggers · 99 policies**.

## Why not the `drizzle-kit` baseline (`drizzle/0000_*.sql`)?

`drizzle-kit introspect` is **lossy** for a Postgres-heavy schema like ours:

- It captures **0 functions and 0 triggers** (our 14 RPCs like `reserve_stock`,
  the identifier generators, `updated_at` triggers).
- It **drops policy expressions** — e.g. the `card_colors` INSERT/UPDATE/DELETE
  policies lose their `is_store_admin(store_id)` `WITH CHECK`/`USING`, which
  would create **wide-open (insecure) RLS** on a fresh DB.

So the drizzle-kit baseline is kept ONLY as drizzle-kit's snapshot for generating
**future incremental** table migrations. It is **never** used to build a database.
Schema changes that drizzle-kit can't express (functions, triggers, policies) are
added as new hand-written `drizzle/manual/NNNN_*.sql` files and folded into
`0001`/an addendum.

## Existing databases: the checksummed migration ledger

The three files above are only the legacy **fresh-database baseline**. Existing
staging and production databases must never be advanced with ad-hoc `psql -f`
commands again. They use [`../migrations/manifest.json`](../migrations/manifest.json)
and `npm run db:migrate` instead.

The runner:

- refuses a staging/production name that does not match the physical database;
- verifies the legacy schema before recording its baseline;
- takes a database advisory lock, then applies each migration in one transaction;
- stores the SHA-256 of the SQL **and its postcondition contract** in
  `public.schema_migrations`;
- refuses edited, unknown, partially-applied, or out-of-order migrations; and
- prints a hash of the complete public schema (tables, columns, constraints,
  indexes, policies, triggers, functions, and extension aggregates) for
  staging/prod drift comparison.

Each manifest entry may have three postcondition contracts, all covered by its
immutable checksum. `verify` contains durable structural invariants and runs on
every later status/verification pass. `applyVerify` runs once immediately after
the runner executes that migration's SQL. `adoptVerify` is the one-time evidence
used by `audit`/`adopt` when checking an evolved database whose SQL was applied
outside the ledger. This keeps legitimate later data changes from invalidating
an older migration's recurring structural verification.

Run through the Cloud SQL Auth Proxy as `postgres`. Put the admin password in
`DB_ADMIN_PASSWORD` using a silent prompt; never put it in shell history:

The runner requires `DB_ADMIN_USER` and deliberately does not fall back to
`DB_USER`. Application roles have no access to `public.schema_migrations`.

```bash
export DB_ADMIN_USER=postgres
read -s DB_ADMIN_PASSWORD && export DB_ADMIN_PASSWORD

# DB_NAME is the final guard: storemink_staging for staging, storemink for prod.
npm run db:migrate -- status --environment staging
npm run db:migrate -- baseline --environment staging --commit "$(git rev-parse HEAD)"
npm run db:migrate -- apply --environment staging --commit "$(git rev-parse HEAD)"
npm run db:migrate -- verify --environment staging
```

### Recovering migrations that were applied outside the ledger

`audit` and `adopt` are recovery commands, not part of the normal release flow.
Use them only when SQL was already applied manually but its immutable checksum
was never recorded. `audit` runs in a database-enforced read-only transaction
and walks the ordered pending prefix, requiring every migration's declared
schema and adoption postconditions to pass:

```bash
npm run db:migrate -- audit --environment staging \
  --through 20260825_0017_help_article_embeddings
```

The audit prints the canonical checksum for each adoptable migration. Review the
output, then adopt **only the first pending migration**, repeating its exact ID
and checksum plus the physical database name. `adopt` repeats the checks inside
one serializable transaction and writes one ledger row. It does not execute the
migration SQL or alter application tables:

```bash
npm run db:migrate -- adopt --environment staging \
  --migration 20260816_0003_pos_pickup_prepared_at \
  --confirm-adopt 20260816_0003_pos_pickup_prepared_at \
  --confirm-checksum <64-character-checksum-from-audit> \
  --confirm-database storemink_staging \
  --commit "$(git rev-parse HEAD)"

# Re-run audit and adopt one migration at a time, in manifest order, then:
npm run db:migrate -- verify --environment staging
```

The runner refuses an unknown, already-recorded, non-first, checksum-mismatched,
or out-of-order target. If any postcondition fails, adoption rolls back
completely; both application tables and the ledger remain unchanged. Never
weaken a postcondition, add `IF NOT EXISTS`, or insert directly into
`public.schema_migrations` to force adoption. Bring the first pending target's
declared durable and adoption contracts to their reviewed state before retrying.
Production also requires both `--confirm-database storemink` and the existing
`--confirm-production storemink` guard.

Production mutations require a second explicit guard:

```bash
DB_NAME=storemink npm run db:migrate -- apply --environment production \
  --confirm-production storemink --commit "$(git rev-parse HEAD)"
```

The first enrolled migration is `supabase/logistics_01_shiprocket.sql`. Although
it retains its historical location, it is immutable now: editing it will make
verification fail anywhere it has been applied. Every new schema change gets a
new SQL file plus a manifest entry and postconditions; never edit an enrolled
file.
