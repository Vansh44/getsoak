# Local dev performance — what's actually slow, measured

Measured 2026-08-12 on an **Apple M2, 8 GB RAM**, from India, against the
staging database. Numbers first, because "dev feels slow" gets blamed on the
bundler by default and in this project the bundler is not the problem.

---

## 1. Compilation is NOT the bottleneck

Twenty consecutive Turbopack compiles from a real session:

```
13ms  97ms  117ms  177ms  232ms  333ms  406ms  414ms  608ms  847ms
1.1s  1.5s  3.4s   (cold route, first visit)
```

Turbopack is doing its job. **Do not spend time on `optimizePackageImports`,
barrel imports or module counts** until something here regresses — the ceiling
is already ~1.5 s for a cold route and double-digit milliseconds for an edit.

---

## 2. ★★ THE DOMINANT COST IS THE DATABASE ROUND TRIP

The dev database is **remote**. `npm run db:proxy` points at
`storemink-prod:asia-south1:storemink-prod-db` — a Cloud SQL instance in
**Mumbai** — so every query a page makes crosses the internet:

| Measurement                        | Result                       |
| ---------------------------------- | ---------------------------- |
| `SELECT 1` through the proxy       | **median 46 ms**, p90 111 ms |
| A real single-row query            | **median 49 ms**             |
| Raw ICMP ping to Google's frontend | avg 49 ms                    |

**The proxy adds nothing — 46 ms _is_ the network.** It is the speed of light
plus TCP, and no amount of query tuning removes it.

### Why this matters more than it looks

Round trips are **sequential** wherever one query's result feeds the next.
A single authenticated page render walks a chain like:

```
getCurrentStoreOrNull      (cached 300 s — usually free)
resolvePosOperator
  ├─ getAuthorizedDevice        46 ms
  ├─ getManagerIdentity         46 ms
  ├─ isStoreSuperadmin          46 ms
  └─ ownerDisplayName           46 ms
layout Promise.all (3 concurrent)   46 ms
the page's own reads             46–140 ms
```

≈ **300–500 ms of pure network per render**, before React does any work. On a
local Postgres the same chain is **~3 ms**. That is the single biggest
available win, it applies to **every developer on every page**, and it is
invisible in a profiler that only looks at CPU.

### ⚠ THE FIX IS A LOCAL POSTGRES, AND IT IS NOT BUILT YET

This is the right answer and it is deliberately **not** done in passing,
because a half-working local database is worse than none — everyone would
debug the environment instead of the product. Doing it properly means:

- a container running the same major Postgres version;
- applying `supabase/*.sql` in order, which assumes an `auth` schema and the
  `app_user` / `app_service` roles that `lib/db/client.ts` sets via
  `SET LOCAL ROLE` — including the `auth.uid()` shim over the
  `app.current_user_id` GUC (see CODEBASE.md §2, convention #2);
- seed data, or the whole thing is an empty shop;
- a documented way to re-sync when a migration lands, or local silently drifts
  from staging and the drift surfaces as a bug nobody can reproduce.

Until then, `db:proxy` against staging is correct — it is _slow_, not _wrong_,
and it guarantees you are developing against the real schema.

**Interim mitigations that need no new infrastructure:**

- Prefer `Promise.all` over sequential `await`s wherever reads do not depend on
  each other. Three concurrent queries cost 46 ms; three sequential ones cost
  140 ms. (`app/pos/layout.tsx` does this deliberately.)
- Cache reads that are stable per request with React `cache()` —
  `resolvePosOperator` already is, which is why `/pos/sell` resolves the
  operator once instead of the three or four times it used to.
- A VPN adds to every one of these round trips. If Cloudflare WARP, ProtonVPN
  or similar is on, it sits between you and Mumbai on every query.

---

## 3. Memory — why 8 GB machines feel much worse than the numbers suggest

Same machine, mid-session:

|                   |              |
| ----------------- | ------------ |
| RAM               | 8 GB         |
| Free              | **0.06 GB**  |
| Compressed        | 2.76 GB      |
| **Swap used**     | **9.68 GB**  |
| Pages reactivated | 16.9 billion |

Once the machine swaps, everything above is irrelevant — the work is fast and
the _waiting_ is disk. The dev server was the largest single process at
**4.4 GB**, with VS Code (~2.4 GB across helpers), Chrome (~1 GB), and several
Electron AI apps (~1.9 GB combined) competing for the same 8 GB.

**The dev server's memory grows through a session and never shrinks.** Dev
compiles routes lazily and keeps every one it has compiled resident, so a long
session that touches many routes climbs steadily. That is a property of dev
mode, not a leak to configure away — **restart it when it gets sluggish.**

### The default runner is now memory-aware

```bash
npm run dev             # or dev:all, with the Cloud SQL proxy
```

`scripts/dev-server.mjs` detects physical memory before starting Turbopack:

| Machine RAM | Next.js V8 heap |
| ----------- | --------------- |
| ≤12 GB      | 2 GB            |
| 12–20 GB    | 3 GB            |
| >20 GB      | uncapped        |

This keeps the 8 GB Mac from letting one long dev session grow toward 4.4 GB
and forcing the whole machine into swap, while larger machines keep their
headroom. `npm run dev:lean` forces 2 GB and `npm run dev:full` explicitly
removes the cap. A cap trades some extra garbage collection for dramatically
less swapping; on this machine that is the correct trade.

### `.next/dev` grows without bound

It reached **4.1 GB** (of a 4.9 GB `.next`) in one session. On a machine
already writing ~10 GB of swap to the same SSD, that is disk contention on top
of memory pressure. The resource-aware runner measures `.next/dev` before
startup and removes it only when it exceeds 3 GB. `npm run dev:reset` performs
the same generated-cache reset manually. Either path costs one cold compile,
then warm Turbopack caching resumes.

### Dashboard rendering no longer serializes unrelated shell reads

The dashboard layout previously awaited location scope, enquiry count, store,
and POS-location reads one after another. They are now started concurrently
(with only the store → POS-location dependency kept), and Analytics resolves
timezone and location options together. This does not remove the Mumbai network
floor, but it stops paying several independent windows in sequence on every
page render.

### ★★ Re-measured 2026-08-24 — the machine was out of headroom before dev started

Same M2 / 8 GB, after **84 days of uptime**, with the dev server **not running**:

| Measurement              | Value                             |
| ------------------------ | --------------------------------- |
| Free RAM                 | **65 MB**                         |
| Wired                    | 2.05 GB                           |
| Compressor               | 3.22 GB                           |
| **Swap used**            | **8.19 GB of 9.22 GB (89% full)** |
| Total RSS, 556 processes | 4.08 GB                           |
| Free disk (Data volume)  | 18 GB of 228 GB (**91% full**)    |

So ~6.1 GB of the 8 GB was already committed **with nothing being developed**.
The remaining ~2 GB is the entire budget a dev server has to fit in.

Then `npm run dev` was started and eight routes were requested:

| Point                             | Next.js RSS |
| --------------------------------- | ----------- |
| Freshly booted (`Ready in 337ms`) | **0.09 GB** |
| after `/`                         | 0.44 GB     |
| after `/dashboard`                | 1.12 GB     |
| after `/dashboard/analytics`      | **1.77 GB** |

**macOS grew the swap file by 2 GB during that** (9.22 GB → 11.26 GB total,
8.19 GB → 10.64 GB used; free RAM 57 MB). Three of those eight routes returned
404 and so never fully compiled — a real session touching the builder, POS and
products climbs well past this.

**That swap growth is the slowdown.** The dev server itself is not slow; every
page it forces out of RAM has to be read back from the SSD when you next click
Chrome, VS Code or Slack. That is the beachball, and it is why the machine feels
bad _everywhere_ rather than just in the terminal.

Two consequences worth internalising:

- **Killing the dev server does not give the memory back.** Swap used stayed at
  10.6 GB immediately after the process exited — macOS never shrinks swap files.
  It only truly resets on **reboot**, which is what 84 days of uptime costs.
- **The heap cap was never the thing bounding it.** `--max-old-space-size=2048`
  was in force the whole way to 1.77 GB. Turbopack is Rust, so its module graph,
  compiled output and source maps are native allocations _outside_ V8's old
  space, as is every Node buffer. The cap is worth keeping — it stops V8 itself
  ballooning — but it cannot keep the machine responsive. Restarting the dev
  server is what actually reclaims memory.

### Disk is not a separate problem from memory

`.next` had grown to **4.7 GB**, of which **1.5 GB was `.next/cache/webpack`,
last written ten days earlier**. Turbopack dev never reads that directory — it
is `next build`'s cache — so it was pure dead weight on a volume that was 91%
full and on which macOS was simultaneously trying to grow a swap file. The
runner now reclaims it on every start once it passes 256 MB, which costs nothing
in dev (the next `next build` rebuilds it).

Note also that `.next/dev` sat at **2.96 GB against the runner's 3 GB rotation
threshold** — so that guard had never once fired in the life of the machine.
That is correct behaviour (the Turbopack cache is what keeps recompiles at
13 ms) but worth knowing before assuming the cache is being managed for you.

### Spotlight — checked, and it is NOT currently a cost

Worth writing down because it is the obvious suspect (`.next` is 11,541 files
that Turbopack rewrites continuously; `node_modules` is another 75,852) and the
measurement says no.

`mdutil -s` reports indexing enabled on both volumes, but nothing new is being
ingested:

- A brand-new file written into `~/Documents` — a directory with existing index
  entries — was **still unindexed after 70 s**. That was the control, so the
  result is not about this project.
- `mds` and every `mdworker_shared` sat at **0.0% CPU** throughout.
- `mdfind -onlyin "$HOME" -name package.json` returns **0**, while
  `mdfind -onlyin /Applications -name Safari` returns 1 — so `mdfind` works and
  the index holds old content, but has stopped taking new writes.

⚠ **Do not over-read that into "Desktop is in the Spotlight Privacy list."** An
equally good explanation is an index that stalled at some point: everything
older than the stall is present, everything newer is absent, whatever the
directory. Telling those apart needs `sudo` on
`/System/Volumes/Data/.Spotlight-V100/VolumeConfiguration.plist`.

**So Spotlight explains none of the slowdown today**, and any fix aimed at it
would be measuring itself against zero.

The runner writes `.metadata_never_index` into `.next`, `node_modules` and
`coverage` anyway, for one specific reason: **the recommended fix above is a
reboot**, and a reboot is exactly what would restart normal indexing — at which
point those directories become the largest write-churn source on the volume. It
is insurance placed before the cost arrives, not a fix for a measured problem.

Two implementation notes:

- It is rewritten on **every** start, not once. All three directories are
  gitignored (so the marker can never be committed) and all three are wiped —
  `.next` by `dev:reset` and by the 3 GB cache rotation, `node_modules` by
  `npm ci`. A one-time marker disappears silently.
- `.metadata_never_index` is a long-standing Spotlight convention rather than a
  formally documented API, and **it could not be verified on this machine
  because indexing is stalled**. It is inert if it does nothing. The
  authoritative alternative is System Settings → Spotlight → Privacy, which
  requires a human.

### What is _not_ worth tuning

Measured, so it does not get re-litigated:

- Boot is **337 ms**. Not a problem.
- The runner's recursive `.next/dev` size walk over 11,515 files: **42 ms**.
  Not worth replacing with `du`.
- Turbopack compile times are unchanged from §1.
- Spotlight (see above) — currently ingesting nothing, 0.0% CPU.

---

## 4. If you have ten minutes and dev feels slow

**Check swap first** — `sysctl vm.swapusage`. The runner now prints a warning
at startup when it is ≥60% full, because that single number decides whether any
of the rest of this list will help.

1. **Reboot, if uptime is measured in weeks.** This is first for a reason and it
   is the one step that cannot be substituted: macOS never shrinks swap, so a
   machine carrying 10 GB of it stays slow no matter what you close. `uptime`.
2. Quit Electron apps you are not using. Measured 2026-08-24: VS Code 0.77 GB,
   Claude 0.68 GB, Chrome 0.43 GB, ChatGPT/Codex 0.34 GB — **2.2 GB**, which is
   more than the entire headroom the dev server has to fit into.
3. **Free disk.** 18 GB of 228 GB was left, and swap grew 2 GB during a single
   short dev session. Swap competes for the same volume as `.next`,
   `node_modules` and Xcode/simulator data.
4. `npm run dev:reset` and restart the dev server. Reclaims the generated dev
   cache without deleting production build output. Restarting alone is worth it
   — RSS only ever grows within a session.
5. Turn off any VPN while developing — it taxes all 46 ms of every query.
6. `killall NotificationCenter` — a known macOS leak; it was holding 1.1 GB.
   It restarts itself immediately and nothing is lost.

**The structural point:** an 8 GB machine running a browser, an Electron editor
and two Electron AI apps does not have room for this dev server, and no flag in
`scripts/dev-server.mjs` can create room that isn't there. The tuning above buys
headroom at the margin; steps 1–3 are the ones that decide the outcome.

If it is still slow after that, it is **§2**, and the answer is a local
Postgres rather than anything you can tune.
