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

### `npm run dev:lean`

```bash
npm run dev:lean        # or dev:all:lean, with the Cloud SQL proxy
```

Identical to `dev` with `--max-old-space-size=3072`, which forces V8 to collect
instead of letting the heap grow toward 4.4 GB.

**★ IT IS OPT-IN, AND THAT IS DELIBERATE.** A heap cap is not faster — it
trades CPU (more frequent GC) for RAM. It is a win only where RAM is the
binding constraint. Making it the default would slow down every 16 GB and
32 GB machine to accommodate an 8 GB one, so it is a second script that
whoever needs it types.

### `.next/dev` grows without bound

It reached **4.1 GB** (of a 4.9 GB `.next`) in one session. On a machine
already writing ~10 GB of swap to the same SSD, that is disk contention on top
of memory pressure. `rm -rf .next` is always safe — it is fully generated and
gitignored — and costs one slow cold compile afterwards.

---

## 4. If you have ten minutes and dev feels slow

1. `rm -rf .next` and restart the dev server. Reclaims disk _and_ the dev
   server's accumulated heap.
2. Quit Electron apps you are not using (Claude, ChatGPT, Codex desktop apps
   were ~1.9 GB combined here).
3. `killall NotificationCenter` — a known macOS leak; it was holding 1.1 GB.
   It restarts itself immediately and nothing is lost.
4. Use `npm run dev:all:lean` if you are on 8 GB.
5. Turn off any VPN while developing — it taxes all 46 ms of every query.

If it is still slow after that, it is **§2**, and the answer is a local
Postgres rather than anything you can tune.
