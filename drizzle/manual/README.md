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

## The `rebaseline:` source rows in production (2026-09-02)

`public.schema_migrations.source` normally holds one of two values:
`sql/<file>` for a migration the runner **executed**, and `adopt:sql/<file>`
for one it **verified as already present**. Production also carries 56 rows
whose source begins `rebaseline:`. They are the honest record of a one-off
recovery, and the distinction matters — those rows were written in bulk
**without** per-contract verification, so they do not carry the guarantee the
other two sources do.

**Why adoption could not be used.** Production's entire history had been applied
by hand, out of ledger order. An `adoptVerify` contract describes the state
immediately after its own migration, so once later migrations have also been
hand-applied, earlier contracts stop being satisfiable. Four were, provably by
supersession rather than by damage:

| Migration | Asserts                                             | Superseded by                                                                               |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `0015`    | POS Help category at `position = 4`                 | 0019–0024 renumbered it to 5                                                                |
| `0023`    | a POS/Analytics Help sentence                       | a later guide rewrote it                                                                    |
| `0031`    | "Continue as walk-in" in `process-an-in-store-sale` | **0032 deliberately removed it** when it corrected that guide to the submit-only phone flow |
| `0036`    | specific Mink drawer wording                        | 0037 / 0050 / 0056 rewrote it                                                               |

Staging adopted `0015` cleanly only because staging was adopted **in order**,
while `position` was still 4. That is the whole difference between the two
databases, and it is why `adopt` is the right tool for "the last few were
hand-run" and the wrong one for "the entire history was".

**What was NOT rebaselined.** A read-only classifier evaluated every pending
contract and reported 52 present, 4 superseded (above), and **1 absent** —
`0059`, whose six tables genuinely did not exist. That one plus the never-applied
`0060` were left pending and **executed** by `apply`. ★ Recording an absent
migration is how a ledger comes to report "clean" over a database that is
missing tables; classify before recording, never the reverse.

Afterwards both databases reported the same
`schema_sha256=4c6fde48…` and `verify` passed on each.

**Do not repeat this to skip an adoption.** The prohibition above stands: never
weaken a postcondition or insert into the ledger to force adoption. This was an
owner-directed recovery from a database whose ledger had never been used, on an
environment with zero orders, and every row it wrote is marked so it can be
told apart from a verified one.

The first enrolled migration is `supabase/logistics_01_shiprocket.sql`. Although
it retains its historical location, it is immutable now: editing it will make
verification fail anywhere it has been applied. Every new schema change gets a
new SQL file plus a manifest entry and postconditions; never edit an enrolled
file.
