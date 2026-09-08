# Local development performance

## Evidence from 2026-09-05

The machine is an Apple Silicon Mac with **8 GB RAM and 8 CPU cores**.
The system snapshot showed **6.4 GB swap used**, **3.3 GB RAM occupied by
compressed pages**, and about **61 GB available disk space**. No listener was
visible on ports 3000 or 6543 during inspection. Swap usage and cumulative
page-in counters alone cannot establish current thrashing; use Activity
Monitor's Memory Pressure and paging deltas during the slow request.

The existing `.next/dev/trace` contains:

| Operation                        | Duration |
| -------------------------------- | -------: |
| `/auth/login` compilation        |   60.1 s |
| `/auth/login` complete request   |   71.6 s |
| `/dashboard/builder` compilation |   43.3 s |
| `/dashboard` complete request    |   21.8 s |
| `/dashboard` rendering           |   13.0 s |

These are saved-session timings, not a controlled benchmark. They confirm
slow compilation and rendering, but do not reproduce the reported 5–10 minute
homepage wait. Long `/api/mink/stream` requests are streaming lifetimes and must
not be interpreted as page-load latency.

Earlier August measurements found much faster compilation and roughly 46 ms
per database round trip through the Mumbai Cloud SQL proxy. Those are historical
observations, not proof that the bundler or database cannot be the problem now.

## What the local runner does

`npm run dev:all` runs the Cloud SQL Auth Proxy and the Next.js dev
server. The runner selects Webpack on machines with ≤12 GB RAM and Turbopack
on larger machines; explicit bundler flags override this choice. It does not run a production build or test suite. Next compiles routes
on demand; the browser's compiling/rendering indicator reports this work.
Hiding the indicator will not speed it up.

The runner sets V8 old-space limits of 2 GB on machines with ≤12 GB RAM,
3 GB on machines with ≤20 GB, and no explicit limit above that. This is **not
a total process RAM cap**: native allocations, buffers and Turbopack's Rust
module graph sit outside it. `dev:lean` is already the default heap policy on
this 8 GB Mac; `dev:full` removes that protection and is not a speed fix.

Caches are now preserved across restarts. The previous runner automatically
removed `.next/dev` over 3 GB and `.next/cache` over 256 MB. Deleting caches
can force recompilation; disk cache size is not resident memory usage.
Next 16.2.12 enables Turbopack development filesystem caching by default;
the runner disables it when Turbopack runs on a ≤12 GB machine, where it was
measured stalling requests — see "Turbopack's filesystem cache" below.
`DEV_CACHE_MAX_MB=3072 npm run dev:all` restores opt-in dev-cache rotation for
machines short on disk. `npm run dev:reset` explicitly deletes `.next/dev`;
stop the server first and use it only for cache recovery or deliberate cleanup.
Neither operation removes production output. Normal startup no longer deletes
`.next/cache`.

The runner's swap warning is advisory. Quitting processes does reclaim their
memory; macOS does not need a reboot to reclaim all process memory. Allocated
swap-file capacity is different from actively used swap and current paging.
A reboot may help recover a heavily pressured session, but is not the only fix.
Spotlight marker files are best effort, not a measured improvement.

## Working commands

```bash
npm run dev:all          # memory-aware bundler choice + proxy, preserves cache
npm run dev:all:webpack  # explicit Webpack + same proxy and heap policy
npm run dev:all:turbo    # explicit Turbopack + same proxy and heap policy
npm run dev -- --webpack # Webpack only, if the proxy is already running
```

Stop the existing server with Ctrl+C before switching. The old runner forced
`--turbopack` even when `--webpack` was passed; explicit bundler selection now
works. Webpack is an alternative to measure, not a promise of lower memory or
faster compilation. Its first compile is cold and can be slow. Do not delete
caches between ordinary restarts; compare the same routes and both first and
repeat visits. Production build configuration is unchanged.

## Diagnose a slow session

1. Check Activity Monitor → Memory. Close unused high-memory apps if pressure
   is yellow/red. Restart the dev server to release its accumulated allocations,
   preserving the disk cache. Save work before rebooting if the Mac stays stuck.
2. Run one server and request one route. Compare the terminal's compile and
   render durations; a green memory graph does not rule out slow network I/O.
3. Compare a repeat visit. Fast repeat visits with slow first visits implicate
   compilation/cache warmup. Slow rendering after compilation needs database,
   authentication and external-service timing, not just compiler settings.
4. Try the Webpack command for the same route if Turbopack remains problematic.
   Record elapsed time and process memory when comparing bundlers.
5. Inspect proxy errors. It connects to the Mumbai Cloud SQL instance; local
   `DB_NAME` should select `storemink_staging`. Remote database latency and
   connection failures can delay rendering independently of compilation.

The root layout also declares nine Google font families. On a cold compile,
font fetching is another dependency to inspect if logs show network retries;
it has not been established as the cause of this incident. Heavy editors and
charts should be assessed via the route's import graph rather than removed
solely because they appear in package.json.

For a focused Turbopack trace, use `NEXT_TURBOPACK_TRACING=1 npm run dev:all:turbo`,
reproduce one slow route, then stop. Trace files may be large; do not enable
tracing permanently. See the installed Next.js guides in
`node_modules/next/dist/docs/01-app/02-guides/local-development.md` and
`memory-usage.md`.

These changes affect developer tooling only. No merchant/customer flow changes,
Help Centre migration, POS acceptance updates or roadmap phase changes apply.

## Turbopack's filesystem cache

Measured 2026-09-06, before this runner defaulted small machines to Webpack, so
it describes what happens when **Turbopack is used on a machine that is
swapping** — today that means forcing `--turbopack` on ≤12 GB.

`experimental.turbopackFileSystemCacheForDev` became enabled by default in
Next 16.1. It writes and periodically compacts a database under
`.next/dev/cache`. With that cache at 2.88 GB on an 8 GB M2, one session logged:

```
✓ Finished writing to filesystem cache in 2.5min
✓ Finished filesystem cache database compaction in 12.8s
⚠ Slow filesystem detected. The benchmark took 794ms.
```

During the first of those, an ordinary request measured:

```
POST /api/auth/session 200 in 102s (next.js: 101s, application-code: 1564ms)
```

**Read that split before drawing a conclusion.** 1.5 s was the route's own work
and 101 s was the framework, so this is not the ~46 ms database round trip and
not slow application code — the server was blocked behind its own cache write.
A large `next.js:` number with a small `application-code:` number points here.

The cost is disk IO, and on a machine already paging the SSD is the contended
resource, so the cache competes with swap. Next's own "Slow filesystem detected"
warning is that contention observed from the inside; the disk is busy, not slow.

Measured with the cache off, same routes: `GET /` 20.4 s → 5.7 s, `GET /signup`
10.0 s → 0.85 s, `.next/dev` 3.15 GB → 0.27 GB, and none of the stall lines
above. ⚠ That is a low-memory result and does not generalise — it says the cache
loses on a machine that is swapping, not that it loses everywhere.

The runner therefore leaves the cache **on** where there is RAM to spare and
turns it **off** when Turbopack runs on a ≤12 GB machine, reclaiming any
`.next/dev/cache` left behind. Turning it off costs cold compiles after a
restart; Turbopack still caches in memory, so edit-refresh is unaffected.

```bash
npm run dev -- --turbopack --fs-cache     # force the cache ON  (DEV_FS_CACHE=1)
npm run dev -- --turbopack --no-fs-cache  # force it OFF        (DEV_FS_CACHE=0)
```

Running `npx next dev` directly sets nothing and keeps Next's own default: the
runner adds behaviour rather than redefining the framework's.

## Webpack tuning from official guidance

The development phase of `next.config.ts` now applies these settings:

| Setting                     | Value                                           | Purpose / tradeoff                                                                                                                                             |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parallelism`               | 8 per compiler on ≤12 GB RAM, 32 above          | Fewer concurrent module builds; can increase cold compile duration while reducing concurrent work.                                                             |
| `output.pathinfo`           | `false`                                         | Omit module-path comments and their garbage-collection overhead; source maps remain intact.                                                                    |
| `onDemandEntries` on ≤12 GB | `maxInactiveAge: 25000`, `pagesBufferLength: 2` | Retain fewer inactive entries than Next's 60 s / five-page defaults; revisits may recompile. Active pages stay active. This does not unload every Node module. |

`DEV_WEBPACK_PARALLELISM=16 npm run dev:all:webpack` overrides concurrency with
a positive integer. This limits module work, not CPU threads or total RSS.
The values are conservative starting points, not a proven optimum.

Next 16.2.12 already supplies filesystem caching, a garbage-collected memory
cache (`MemoryWithGcCachePlugin`), and `maxMemoryGenerations: 0` for its filesystem
cache. Those defaults are preserved, along with cache names, compression,
invalidation, loaders and chunking. No extra worker pool, polling watcher,
minification, typecheck process, or new dependency was added. Source maps retain
Next's defaults: its config builder explicitly reverts custom development
`devtool` values. `experimental.webpackMemoryOptimizations` is only consumed in
the installed production webpack build implementation, so it is not enabled as
a supposed local-dev fix.

The custom Webpack callback exists only in the development phase. Production
build configuration and its worker selection remain unchanged. An empty dev
`turbopack` config acknowledges the explicit alternative bundler; Webpack knobs
do not tune Turbopack.

Official sources consulted:

- [Webpack build performance](https://webpack.js.org/guides/build-performance/): persistent caches, incremental compilation, avoiding unnecessary tooling and path comments.
- [Webpack parallelism](https://webpack.js.org/configuration/other-options/#parallelism): concurrent module limits and the memory/throughput tradeoff.
- [Webpack cache](https://webpack.js.org/configuration/cache/): cache lifecycle and memory collection.
- [Next custom Webpack configuration](https://nextjs.org/docs/app/api-reference/config/next-config-js/webpack): extend framework configuration; the callback is invoked for client/server targets.
- [Next on-demand entries](https://nextjs.org/docs/app/api-reference/config/next-config-js/onDemandEntries): development entry retention.

### Live verification

The existing server was already using Webpack (confirmed through webpack
compilation spans in `.next/dev/trace`). One homepage request before the change
returned HTTP 200 in **8.91 s** (8.29 s to first byte). After config reload, a
request returned HTTP 200 in **4.58 s** (4.04 s to first byte), and a repeat
visit returned HTTP 200 in **0.30 s** (0.297 s to first byte). These are live
observations with different cache states and other browser tabs making requests,
not a controlled A/B benchmark or proof of a fixed 5–10 minute delay. Current
swap usage during the investigation was about **10.7 GB**; this remains an 8 GB
machine with substantial system-wide memory demands.

Configuration checks verify the development values, override validation, retained
source-map/cache settings, and absence of the callback in production. Targeted
ESLint and formatting checks also pass. No production build is needed for these
internal development settings.

## Local Postgres for development (2026-09-07)

### Why

Measured on a freshly restarted Webpack dev server, compilation is no longer the
dominant cost on a **repeat** visit; the database is. Same routes, cold then warm:

| Route          |  Cold |   Warm | Warm split                                       |
| -------------- | ----: | -----: | ------------------------------------------------ |
| platform `/`   | 2.3 s | 0.22 s | next.js 43 ms, application-code 156 ms           |
| `help/help`    | 8.7 s | 0.13 s | next.js 50 ms, application-code 71 ms            |
| `/legal/terms` | 5.8 s | 0.70 s | next.js 27 ms, application-code 656 ms           |
| store `/shop`  | 2.9 s | 1.23 s | next.js **1.8 ms**, application-code **1209 ms** |

Warm `/shop` spends 1.8 ms in the framework and 1209 ms in application code —
essentially all of it sequential round trips to the Cloud SQL instance in
`asia-south1` at roughly 46 ms each. That is the remaining lever, and it is not
a bundler setting.

⚠ During that session the Cloud SQL Auth Proxy had been up 15 h and its ADC
token had expired, so some reads were failing with `read ECONNRESET` and being
absorbed by fail-open call sites (`getPlatformAnalyticsFeatures failed`,
`getActiveCategories: read ECONNRESET`). The warm figures therefore include some
failed-read time and are an upper bound, not a clean measurement.

### What was set up

A native Homebrew `postgresql@17` cluster, **not** a container. Docker Desktop or
Colima would add a Linux VM of roughly 2 GB on a machine already using 10.4 GB of
12 GB swap, which costs more than the round trips it saves.

| Item      | Value                                                                  |
| --------- | ---------------------------------------------------------------------- |
| Server    | PostgreSQL 17.10 (Homebrew), `vector 0.8.0` available                  |
| Port      | **5544**                                                               |
| Database  | `storemink_local`, owner `postgres`                                    |
| Login     | `app`, member of `app_user`, `app_service`, and the Supabase-era roles |
| Auth      | `trust` for local and 127.0.0.1 (the cluster's existing `pg_hba.conf`) |
| Footprint | ~16 MB idle                                                            |

★ **Port 5544, not 5432.** This Mac already runs EDB PostgreSQL 15, 16 and 17
from `/Library/PostgreSQL/` on ports 5432–5434 as the system `postgres` user.
They are invisible to a non-root `lsof -iTCP -sTCP:LISTEN`, which reports the
port as free. A dedicated port means the dev database can never collide with them
or need their password. Those 28 processes total 0.03 GB RSS, so they were left
running.

★ **`LC_ALL` must be set to start the cluster.** Without a valid locale the
postmaster exits with `FATAL: postmaster became multithreaded during startup`.
`scripts/db-local-ctl.sh` sets it; starting `pg_ctl` by hand without it fails.

★ **The roles are created before any restore.** `pg_dump` does not dump roles,
and the dump's `GRANT` statements reference them. `app_service` needs `BYPASSRLS`
or `withService` silently returns nothing; `postgres` is created locally so the
dump's ownership statements resolve to a real role.

### Rebuilding from staging

`npm run db:local:sync` dumps staging and restores it locally.

★★ **The dump uses `--role=app_service`, and that flag is load-bearing.** The
`app` login has `rolbypassrls = false`, so a dump taken as `app` returns **zero
rows** for every RLS-protected table — which is all the service-only ones
(`mink_*`, `email_logs`, `data_jobs`, the billing tables) — with no error. The
schema would look perfect and the data would be quietly missing.

★ **A dump, not replayed SQL, and that is deliberate.** The
`drizzle/migrations/manifest.json` baseline is a _verification_ baseline: it
asserts that fifteen tables and a list of columns exist. It does not create
anything, so `db:migrate` cannot build a database from empty. Replaying the 153
`supabase/*.sql` files cannot either — this document's own §15b notes record
their apply-order dependencies (`billing_03` must exist before `billing_02`'s
function is called) and the files edited after being applied, which re-run as
silent no-ops. A dump is provably the schema that is actually deployed.

★ **The restore tolerates errors on purpose.** A Cloud SQL dump carries `GRANT`s
to roles that exist only there (`cloudsqladmin` and friends). Those lines failing
is expected; the script filters them out and prints anything else.

The script refuses rather than guessing when ADC has expired, when the proxy is
not answering, when `pg_dump` is older than the server, or when the local cluster
is down. Re-run it after a migration lands on staging, so local cannot silently
drift; `npm run db:migrate:local status` then reports against the same
checksummed ledger (`ENV_DATABASES.local` is `null`, so there is no name guard).

### Switching between local and staging

`.env.local` holds the overrides and Next.js loads it above `.env`. Delete or
rename it to go back to staging. ★ It is written by `db:local:sync` as its
**last** step, on purpose: creating it before the restore succeeds would point
the dev server at an empty database and break every query. ⚠ `.gitignore` contained only `.env`, which does
not match `.env.local`; `.env*.local` was added.

| Command                    | Effect                                       |
| -------------------------- | -------------------------------------------- |
| `npm run db:local:start`   | start the cluster (sets `LC_ALL`)            |
| `npm run db:local:status`  | cluster state and local table count          |
| `npm run db:local:sync`    | rebuild `storemink_local` from staging       |
| `npm run db:local:psql`    | psql into `storemink_local`                  |
| `npm run db:local:stop`    | stop the cluster                             |
| `npm run db:migrate:local` | run the ledger against `--environment local` |

With `.env.local` present, run `npm run dev` — **not** `dev:all`, which would
start the Cloud SQL proxy the local database does not need.

★★ `db:migrate:staging` and `db:migrate:prod` now pin `DB_HOST=127.0.0.1
DB_PORT=6543`. They set only `DB_NAME`, so while `.env.local` was in effect they
looked for `storemink_staging` on the **local** cluster and failed with
`database "storemink_staging" does not exist`. That failure was safe only by
accident: `validateEnvironment` compares the database NAME, not the host, so a
local database named `storemink` would have let `db:migrate:prod apply` write to
the local cluster while reporting success as production.

⚠ **Identity Platform is still the staging project.** `admins.id` / `users.id`
ARE Firebase uids, so the pairing rule in CODEBASE.md §7 still holds: a dump of
`storemink_staging` carries staging-project uids and must be used with the
staging Firebase project. Existing staging logins keep working locally. Do not
restore a `storemink` (production) dump and sign in against the staging project.

⚠ **The local database holds a copy of staging data.** It is test data, but it is
on disk unencrypted in `/opt/homebrew/var/postgresql@17`. Use
`npm run db:local:sync -- --schema-only` for a schema-only copy.

These changes affect developer tooling only. No merchant or customer flow,
Help Centre content, POS acceptance behaviour or roadmap phase changes apply.
