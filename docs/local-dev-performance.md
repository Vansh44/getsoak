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

`npm run dev:all` runs the Cloud SQL Auth Proxy and the Next.js Turbopack dev
server. It does not run a production build or test suite. Next compiles routes
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
Next 16.2.12 enables Turbopack development filesystem caching by default.
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
npm run dev:all          # Turbopack + Cloud SQL proxy, preserves warm cache
npm run dev:all:webpack  # Webpack + same proxy and heap policy
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
   Record elapsed time and process memory before deciding on a default switch.
5. Inspect proxy errors. It connects to the Mumbai Cloud SQL instance; local
   `DB_NAME` should select `storemink_staging`. Remote database latency and
   connection failures can delay rendering independently of compilation.

The root layout also declares nine Google font families. On a cold compile,
font fetching is another dependency to inspect if logs show network retries;
it has not been established as the cause of this incident. Heavy editors and
charts should be assessed via the route's import graph rather than removed
solely because they appear in package.json.

For a focused Turbopack trace, use `NEXT_TURBOPACK_TRACING=1 npm run dev:all`,
reproduce one slow route, then stop. Trace files may be large; do not enable
tracing permanently. See the installed Next.js guides in
`node_modules/next/dist/docs/01-app/02-guides/local-development.md` and
`memory-usage.md`.

These changes affect developer tooling only. No merchant/customer flow changes,
Help Centre migration, POS acceptance updates or roadmap phase changes apply.
