# Test coverage — the plan, and where it stands

> Goal: **100% of the codebase's logic**, with good AND bad paths and edge cases
> covered. This file is the ordered plan and the running state, so the work is
> resumable without re-deriving it. Update it in the same commit as the tests
> (the living-docs rule in AGENTS.md).

## 1. The number was not what it looked like

`vitest.config.ts` used to carry an **allowlist** of ~100 hand-listed files. It
reported **63.86% statements**. Measured across the whole codebase the real
figure was **33.77%** — the config was not measuring two-thirds of the code.

An allowlist reports on the code someone remembered to add to it, so the files
most likely to be missing are the ones nobody has thought about recently:
exactly the ones a coverage report exists to find. That list had already learned
this lesson once — `lib/returns`, `lib/credit` and `lib/payments` were added to
it in 2026-08 after the highest-stakes directory in the codebase turned out to
be entirely unmeasured, with the reported number staying reassuring throughout.

The allowlist is gone. `include` is now `app|lib|components|hooks|proxy.ts`, and
files that no test imports are counted (Vitest 4 does this by default; the old
`all` flag is removed and is a type error if you add it back).

**Only three things are excluded, and none of them because they are hard to
test:** `drizzle/**` (introspected from the live DB — a test there would assert
that the generator ran), `components/ui/**` (vendored shadcn primitives), and
`*.d.ts`.

## 2. Where the remaining gap is

Baseline at the start of this work, whole-codebase:

| bucket             | missing stmts | files | note                                |
| ------------------ | ------------: | ----: | ----------------------------------- |
| `app/dashboard`    |         6,442 |   190 | mostly page/component JSX           |
| `app/actions`      |         3,169 |    56 | **trust boundary — highest value**  |
| `app/(storefront)` |         2,465 |    82 | mostly component JSX                |
| `app/pos`          |         1,173 |    29 | register/screens, 0%                |
| `app/platform`     |         1,056 |    26 | 0%                                  |
| `app/api`          |           498 |    12 | **crons + webhooks, 0%**            |
| `components`       |           365 |    27 | non-ui                              |
| `lib/*`            |        ~1,800 |     — | domains, auth, storage, seo, pos, … |

**Agreed order (2026-08-06): logic first, JSX after.** Server actions, API
routes and `lib/` reach 100% before any `.tsx` is touched. That is where defects
live, and it is what convention #2 in `CODEBASE.md` already mandates co-located
tests for. The ~11,000 statements of presentational page/component JSX are
two-thirds of the raw gap but a much smaller share of the risk.

## 3. The house pattern for an action test

Established across the six files below; copy it rather than inventing a new
shape. `app/actions/_test-helpers.ts` has `makeDbMock`, `makeChain`,
`sqlParamValues` and `sqlText`.

```ts
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_i, fn) => Promise.resolve(fn(dbHolder.current.db))),
  withService: vi.fn((fn) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn) => Promise.resolve(fn(dbHolder.current.db))),
}));
```

Cover, for every exported action: **the permission gate**, input validation,
the happy path, the store/tenancy scoping, each error branch, and the
revalidate/emit side effects (including that they do NOT fire on failure).

Four traps that cost time here, all of them worth knowing before writing the
next file:

1. **Drizzle column objects are circular** — `JSON.stringify` on a `where`
   clause throws. Use `sqlParamValues(call)` to assert bound values.
2. **A synchronous `throw` from a mocked `db.select` is not a rejected
   promise.** Code guarded with `.catch(() => [])` (rather than `try/catch`
   around an `await`) will not catch it, and the test fails for a reason the
   production code does not have. Model a real pool failure by returning a
   chain whose terminal returns `Promise.reject(...)`.
3. **`vi.clearAllMocks()` clears calls, not implementations.** A test that does
   `vi.mocked(headers).mockResolvedValue(...)` poisons every test after it. Put
   mutable values on a `vi.hoisted` holder and reset the holder in `beforeEach`.
4. **Importing anything that reaches `lib/store/resolve`** (e.g. `STORE_TAG`)
   needs `unstable_cache: (fn) => fn` on the `next/cache` mock, because that
   module builds a cached lookup at load time.

For a route handler, mock its collaborators and drive the exported `GET`/`POST`
with a real `Request`; assert `res.status`, `await res.json()`, and for the auth
routes `res.cookies.get(...)`.

## 4. Defects this has already found

**`/api/cron/plan-expiry` never warns anyone on a quiet day.** `handle()`
returns early at `if (!lapsed.length)` (route.ts:87-89) — _before_ it reaches
`warnExpiringPlans` (route.ts:130). So the 7-day and 1-day `plan.expiring`
warnings are sent only on a day when some **other** store's plan actually
lapsed. Expiries are sparse, so in practice most merchants get no warning at
all before losing their paid features, and the pure, well-tested
`expiryWarnWindow` machinery in `lib/plans.ts` almost never runs.

Fix: hoist the `warnExpiringPlans(nowIso)` call above the early return and
report `warned` in the zero-lapsed response. **Not applied** — coverage was the
task and this is a live billing path, so it is the owner's call. Pinned by
`route.test.ts` → _"does NOT warn anyone on a day when no plan lapsed (the
defect)"_, which will fail loudly when the fix lands and should then be
rewritten as the positive assertion.

## 5. State

Full suite: **184 files / 2,909 tests, green. Typecheck clean.**
Whole-codebase coverage **33.77% → 35.76%**.

Every file below is at **100% statements, branches, functions and lines** — the
standard for this effort. A file is not done at 100% statements while branches
lag; the `err instanceof Error ? … : …` and `?? null` ternaries need a non-Error
throw and a null-email case respectively, and those are exactly the paths that
erase the only record of what went wrong.

### Done

- `app/actions/menu-actions.ts` (18 tests)
- `app/actions/legal-actions.ts` (17)
- `app/actions/customer-notification-actions.ts` (29)
- `app/actions/chrome-actions.ts` (27)
- `app/actions/store-branding.ts` (38)
- `app/actions/email-log-actions.ts` (33)
- `app/api/auth/session/route.ts` (12)
- `app/api/auth/signout/route.ts` (7)
- `app/api/cron/send-emails/route.ts` (11)
- `app/api/cron/domain-reconcile/route.ts` (17)
- `app/api/webhooks/resend/route.ts` (28)
- `app/api/cron/plan-expiry/route.ts` (26)

### Next, in order

**A. Server actions with no test at all** (8 left, ~4,800 lines)

| file                      | lines | why it matters                        |
| ------------------------- | ----: | ------------------------------------- |
| `notification-actions.ts` | 1,583 | the bell, inbox, preferences, console |
| `help-actions.ts`         |   772 | operator CRUD + public counters       |
| `subscription-actions.ts` |   770 | **money** — plan changes, mandates    |
| `store-domain.ts`         |   490 | §30 gate                              |
| `store-signup.ts`         |   432 | account creation, consent write       |
| `ai-credit-actions.ts`    |   413 | **money** — credit purchase           |
| `pos-pickup-actions.ts`   |   313 | hand-over, hold release               |
| `store-policy-actions.ts` |   257 | shopper-facing policy publish         |

**B. Route handlers** (7 left) — `webhooks/razorpay` (373) and
`cron/expire-pending-payments` (302) first: both move money, and the reaper's
restock/coupon-release path is the one with a rollback chain.
Then `cron/plan-expiry`, `cron/seo-refresh`, `og-image` (SSRF allowlist —
security-relevant), `upload`, `upload/sign-video`.

**C. `lib/` gaps** — `lib/domains` (299 missing; `reconcile.ts` is at 0% and is
the §30 core), `lib/seo` (150), `lib/auth` (140), `lib/pos` (220),
`lib/billing` (86), `lib/storage` (86), `lib/store` (80), `lib/legal` (77),
`lib/help` (70), `app/sitemap.ts` (70), `lib/storefront` (64),
`lib/fulfilment` (59), `lib/inventory` (54), `lib/chrome` (36), `proxy.ts` (24).

**D. Branch gaps in already-tested actions** — `app/actions` is 56.5% overall.
Worst offenders: `platform.ts` (21.5%), `refund-actions` (45.9%),
`customer-actions` (47.1%), `user-management` (58.9%), `customer-profile`
(58.7%), `page-actions` (59.5%), `blog-actions` (60.5%),
`checkout-actions` (67.7%), `pos-sale-actions` (69.5%), `product-actions`
(70.4%). These are error paths and edge cases, not missing features.

**E. Components** — interactive first (forms, providers, builder, cart, POS
register), presentational pages last.

## 5. Guard rail worth adding once the logic is done

A `coverage.thresholds` entry in `vitest.config.ts` so the number cannot fall
back. Set it to whatever has actually been reached, per-directory rather than
globally — a global floor lets a well-covered directory pay for a bare one,
which is how the original allowlist's number stayed reassuring.
