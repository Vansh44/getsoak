# Comped plans over paid subscriptions — spec

> Status: **proposed, not built — design settled, ready to implement.**
> Owner decisions recorded in §12 (2026-09-06).
> Written 2026-09-06 after the `echos`
> phantom-debt incident (see CODEBASE.md §34, "FINALIZE BEFORE SETTLING").
> Companion to `docs/billing-architecture.md`; that doc owns the paid path, this
> one owns free grants layered over it.

## 1. The scenario

Today is 6 Sept. A store is on **Basic**, paid, cycle ending **10 Sept**. A
platform operator wants to give them **one free month of Pro**. The merchant
should see an offer on Plans & Billing, and accepting it should start their free
month **from the day they accept**, not from the day it was granted.

Two things must remain true afterwards, and they are the whole difficulty:

- **They must not lose the 4 days of Basic they already paid for.**
- **When the free month ends they must land back on Basic — never on Free.**

## 2. The model this has to fit into

There are two records, and only one of them is the authority.

| Record                  | Owns                                                           | Read by                                                     |
| ----------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `stores`                | `plan`, `plan_source`, `plan_expires_at` — **the entitlement** | `effectivePlan()`, and through it every gate in the product |
| `billing_subscriptions` | `plan`, `period`, `state`, cycle fields — **the money**        | the renewal worker, dunning, downgrade                      |

`effectivePlan(store)` (`lib/plans.ts`) reads **only** `stores.plan` and
`stores.plan_expires_at`. Nothing else decides what a store may do.

**★ `stores.plan_expires_at` is already overloaded, and this is the trap.** For a
comp it means _"the grant ends here"_ (`setStorePlan`). For a paid subscription
it means _"the current cycle ends here"_ — `enrol.ts:811` sets
`planExpiresAt: cycle.end` on every activation, and each renewal pushes it out.
One column, two meanings. Any design that writes a comp into it destroys the
paid meaning.

**⚠ `billing_subscriptions` carries mirrored `plan_source` and `plan_expires_at`
columns. `plan_expires_at` there is DEAD** — nothing in the codebase reads or
writes it. `plan_source` there is _not_ dead and is the subject of §7.

## 3. Why the obvious design fails — three chains, each traced through real code

The naive version ("flip the plan, start a cycle on 6 Sept, issue a ₹0 invoice")
fails three separate ways. None of them is a permission bug; all three end with
a paying merchant worse off.

### 3.1 A ₹0 subscription invoice is an unpayable bill that ends in downgrade

- `manual-pay.ts:127` — `if (amountDue <= 0) return { ok: false, error: "Nothing is due on that invoice." }`.
  The merchant **cannot** pay it.
- Razorpay rejects ₹0 orders. The codebase already says so, at
  `locations.ts:319`: _"Charging ₹0 is not a payment, and Razorpay refuses it — so grant it."_

So the invoice sits `open` → dunning mails them → grace expires →
`billing_claim_downgrade()` fires → **downgraded over a free month.** This is the
`echos` phantom-debt failure rebuilt on purpose.

### 3.2 On expiry they land on Free, not back on Basic

`/api/cron/plan-expiry`:

```js
.set({ plan: "free", planExpiresAt: null })
.where(and(ne(stores.plan, "free"), lte(stores.planExpiresAt, nowIso)))
```

It never consults `billing_subscriptions`. Traced end to end for our scenario:

1. 6 Sept — comp writes `stores.plan = pro`, `plan_source = comp`, `plan_expires_at = 6 Oct`.
2. 10 Sept — the Basic subscription's cycle turns. `claimDue` excludes only
   `billing_subscriptions.plan_source = 'comp'`, and that row still says `paid` —
   so it **is** invoiced, and the merchant pays.
3. Activation calls `billingMayApplyPlan("pro", "comp", "basic")` → comp is a
   floor and `basic` ranks below `pro` → **false**, so `stores.plan` is left alone.
   Correct, and it means they go on paying for Basic while showing Pro.
4. 6 Oct — the expiry cron sees an expired non-free plan and writes
   `plan = free, plan_expires_at = null`.

**Result: a merchant with a live, paid, current Basic subscription is on Free.**

### 3.3 Starting a cycle on 6 Sept discards 4 days they bought, and creates two owners of one field

Overwrite `current_period_end` with 6 Oct and the paid Basic cycle is gone from
the record. Worse, `stores.plan` now has two independent writers — the expiry
cron (driving the comp) and the renewal worker (driving the subscription).
`docs/billing-architecture.md` keeps comps out of the renewal worker precisely so
that cannot happen.

## 4. The design: a comp is an OVERLAY, never a mutation

Do not touch `plan`, `plan_source`, `plan_expires_at` or any billing row. Add a
second, independent grant and resolve the two at read time.

```
effective entitlement = the higher-ranked of:
    the paid entitlement   (stores.plan, while stores.plan_expires_at is in future)
    the active comp        (stores.comp_plan, while stores.comp_expires_at is in future)
```

**★★ THIS IS WHAT MAKES EXPIRY FREE, and it is the entire argument for the
design.** There is nothing to "revert". When `comp_expires_at` passes, the comp
simply stops counting and the paid entitlement — which was never modified — is
what remains. §3.2 cannot happen, because no code path ever had to remember to
put Basic back.

It also disposes of §3.1 and §3.3 by construction: no cycle is started, so no
invoice is needed, so there is no ₹0 document and no second owner of
`stores.plan`.

**★ The overlap is not reconciled, and deliberately writes no code.** A merchant
who accepts with days left on their paid cycle spends those days under the
comped plan instead. Nothing is credited, extended or refunded — see §12.2. This
falls out of the overlay for free: the paid plan keeps running underneath and is
simply outranked.

### Grant vs activation

The operator's grant defines the **duration**. The merchant's click defines the
**window**. That is what earns the click a place in the flow — without it, the
free month would burn down from the grant date whether or not they ever saw it.

| Field                | Set by                | Meaning                          |
| -------------------- | --------------------- | -------------------------------- |
| `comp_plan`          | operator              | which plan is being given        |
| `comp_duration_days` | operator              | how long, once accepted          |
| `comp_offered_at`    | operator              | when it appeared to the merchant |
| `comp_starts_at`     | merchant (activation) | `now()` at accept                |
| `comp_expires_at`    | merchant (activation) | `now() + comp_duration_days`     |

Before activation the store shows an **offer**. After, an **active comp**. An
operator may also activate immediately (grant-and-start) for support cases; that
is the same write with the server supplying both timestamps.

## 5. Schema

```sql
alter table public.stores
  add column if not exists comp_plan          text
      check (comp_plan is null or comp_plan in ('basic','pro')),
  add column if not exists comp_duration_days integer
      check (comp_duration_days is null or comp_duration_days between 1 and 365),
  add column if not exists comp_offered_at    timestamptz,
  add column if not exists comp_starts_at     timestamptz,
  add column if not exists comp_expires_at    timestamptz;

-- An active comp needs all three; an offer needs none of the window fields.
alter table public.stores
  add constraint stores_comp_window_complete check (
    (comp_starts_at is null and comp_expires_at is null)
    or (comp_plan is not null and comp_starts_at is not null
        and comp_expires_at is not null and comp_expires_at > comp_starts_at)
  );

create index if not exists stores_comp_expiry_idx
  on public.stores (comp_expires_at) where comp_expires_at is not null;
```

**★ On `stores`, not a side table.** `effectivePlan` is called at 40 sites, many
in hot paths; a join on every one is a cost this does not need to pay. Its own
file per §15b — `plans_01_schema.sql` has been applied and editing an applied
migration is a silent no-op.

**★ NO `comp_note` / `comp_granted_by` COLUMN.** The `Read stores` RLS policy
grants `select` on `stores` to `public`, so anything added here is
world-readable — the same rule that keeps secrets out of `stores.settings`
(convention #9). Which plan a store is on is already public; _who comped it and
why_ is not. That belongs in **`plan_events`**, which exists, is service-role
only, and already carries `actor` and `note`.

**⚠ `plan_events.source` is `operator | billing | system` — NOT the
`comp | paid | trial` vocabulary of `stores.plan_source`.** Writing `"comp"`
there is rejected by the CHECK, and because the insert shares a transaction with
the plan write it would roll the grant back. CODEBASE.md §15 records this exact
mistake costing months. Comp grants use `source: "operator"`.

## 6. `effectivePlan` — make omission a compile error

This is the highest-risk part of the change, and the user's own instinct about
"flags not being passed properly" is exactly right here.

Today the parameter is all-optional, so `effectivePlan({})` and
`effectivePlan(store ?? {})` compile. **18 of the 40 call sites pass an object
literal or a fallback.** Add the comp fields as optional and every one of those
18 silently ignores the comp — the merchant is told they have Pro and gets
Basic, with no error anywhere.

So the comp fields are **required** (nullable, but required):

```ts
export function effectivePlan(
  store: {
    plan?: unknown;
    plan_expires_at?: string | Date | null;
    // Required so the compiler finds every call site. A caller that cannot
    // supply them must pass null explicitly and mean it.
    comp_plan: unknown;
    comp_expires_at: string | Date | null;
  },
  now: Date = new Date(),
): Plan;
```

Every call site then fails to build until it selects the two columns. That turns
a silent, per-site runtime bug into one build error per site — the same
technique `OrderInsert` uses for the two trigger-owned columns, and `withUser`
for the email field.

Resolution is `PLAN_RANK`-based, so a comp can only ever **raise**:

```ts
const paid = <existing logic>;
const comp = compActive(store, now) ? normalizePlan(store.comp_plan) : "free";
return PLAN_RANK[comp] > PLAN_RANK[paid] ? comp : paid;
```

A comp that ranks at or below the paid plan is inert rather than harmful — a
merchant on Pro handed a comped Basic keeps Pro.

## 7. Resolving the two `plan_source` columns

`stores.plan_source` and `billing_subscriptions.plan_source` both exist and
disagree in production today (`echos`: `comp` / `paid`). The renewal worker's
comp exemption reads the **subscription** copy
(`renewal-worker.ts:198`, `:461`, `:820`).

**Decision: delete the exemption, don't fix it.** Once a comp is an overlay it
never implies "do not bill" — the merchant's paid subscription is still real and
must still be collected. The exemption exists only because the old design
conflated the two, and keeping it would stop billing a merchant who is genuinely
subscribed and merely holds a temporary upgrade.

- Keep `billing_subscriptions.plan_source` as a record of how _this subscription_
  came to be, and stop using it as a billing gate.
- Keep `stores.plan_source` describing the **paid** entitlement only. It stops
  being the answer to "is this store comped?" — `comp_expires_at` is.
- **Drop the dead `billing_subscriptions.plan_expires_at`** (§2) in the same
  migration.

⚠ This is the one part of the spec that changes behaviour for existing comped
stores: a store comped the _old_ way (`stores.plan_source='comp'`) with a live
subscription would begin to be invoiced. Migration handles that — §10.

## 8. Contracts

### 8.1 Operator grant — `offerCompPlan(storeId, { plan, durationDays, note })`

- `getPlatformViewer()?.role !== "superadmin"` → refuse. Matches `setStorePlan`.
- Validate `plan ∈ PLAN_IDS`, `durationDays ∈ [1, 365]`.
- Writes `comp_plan`, `comp_duration_days`, `comp_offered_at`; **never** the
  window.
- Audit to `plan_events` with `source: "operator"`, `actor: viewer.email`.
- Its own transaction, so an audit failure cannot roll back the grant (§15).

### 8.2 Merchant activation — `activateCompPlan()`

**★★ TAKES NO ARGUMENTS. This is the security boundary.** The plan, the duration
and both timestamps are read from the stored grant or produced by the server. An
action shaped `activateComp(plan)` lets a merchant post `"pro"` and self-grant.
Same rule as `confirmLocationPurchase`, which reads its count from
`invoice.addon_target_count` rather than the request, and as Mink Phase 4
("ids and versions only, never browser-supplied content").

- Resolve the store from the host, the actor from the session, gate on
  `getManagerIdentity("ai")` (the section Plans & Billing already uses).
- **Re-read the grant inside the write.** The button was rendered from a snapshot
  and an operator may have withdrawn the offer since.
- **One conditional claim**, so a double-click cannot produce two windows:

  ```sql
  update stores
     set comp_starts_at  = now(),
         comp_expires_at = now() + make_interval(days => comp_duration_days)
   where id = $1
     and comp_plan is not null
     and comp_starts_at is null      -- ← the claim
  returning comp_plan, comp_expires_at;
  ```

  Zero rows means "already activated, or withdrawn" — reported as such, never as
  a fresh success.

- `make_interval` on the **database clock**, not the container's — the rule
  `placeOrder` follows for `pickup_expires_at`.
- Then `updateTag(STORE_TAG)`, because the merchant must read their own write
  immediately (the signup rule in §3 of CODEBASE.md).

### 8.3 Expiry

`/api/cron/plan-expiry` gains a second, independent sweep:

```sql
update stores set comp_plan = null, comp_duration_days = null,
                  comp_offered_at = null, comp_starts_at = null,
                  comp_expires_at = null
 where comp_expires_at is not null and comp_expires_at <= now()
```

**It must not touch `plan` or `plan_expires_at`.** Clearing the comp is the whole
operation; the paid entitlement underneath is already correct.

The existing paid sweep is unchanged. Order does not matter — they touch
disjoint columns — but run the comp sweep first so a store losing both in the
same tick is audited falling from its comped plan.

Notify with a distinct event (`store.comp_ended`) naming what they fall back
**to**, resolved through `effectivePlan` after the clear. Reusing
`plan.changed` would tell a Basic subscriber they had been downgraded.

## 9. Invoices and GST

**No invoice.** A comp is not a supply for consideration, and the codebase
already answers the ₹0 case this way at `locations.ts:319`.

If accounting later insists on a document, the constraints are fixed:

- It must be created **already paid** — `finalized_at`, `paid_at` and
  `status: 'paid'` in one update, the `finalizePaidAiCreditsInvoice` pattern.
  It must never exist as `open`, or §3.1 returns.
- It must **not** be `kind: 'subscription'`, or `claimDue` and the downgrade
  claim will reason about it.
- ⚠ **Not reviewed by a CA.** Numbering a ₹0 document in the gapless FY series
  spends a legal serial on a supply with no consideration. Same posture as §25
  (policy text) and §28 (credit notes): get it checked before shipping.

## 10. Migration and rollout

1. **Schema** — new columns, constraint, index; drop
   `billing_subscriptions.plan_expires_at`. Forward-only file in
   `drizzle/migrations/sql/`.
2. **Backfill existing comps.** Stores with `plan_source = 'comp'` and a
   non-null `plan_expires_at` are today's comps. Copy them into the overlay:
   `comp_plan = plan`, `comp_starts_at = now()`, `comp_expires_at = plan_expires_at`.
   Then decide their paid entitlement: if `billing_subscriptions` has an active
   row, set `stores.plan`/`plan_source`/`plan_expires_at` from it; otherwise
   `free`. **This is the step that must be reviewed by hand** — production holds
   very few such stores (one at time of writing) and getting it wrong changes
   what a live merchant may do.
3. **`effectivePlan` signature** — one build error per call site, fix all 40.
4. **Remove the renewal-worker comp exemption** (§7) only after step 2, or a
   half-migrated comped store starts being invoiced.
5. Operator UI, merchant offer card, expiry sweep, notification.

Steps 1–3 are inert on their own: nothing sets a comp until step 5.

## 11. Tests

Pinning the failure chains from §3, because each was a real design that looked
correct:

- **§3.2, the important one.** Basic paid to 10 Sept + Pro comp to 6 Oct.
  Advance past 6 Oct → `effectivePlan` is **`basic`**, not `free`, and
  `stores.plan` was never written.
- Comp expiry clears only comp columns — assert `plan`, `plan_source` and
  `plan_expires_at` are byte-identical before and after.
- A comp at or below the paid rank is inert.
- `activateCompPlan` twice → second call claims zero rows and reports
  already-active; exactly one window exists.
- `activateCompPlan` after the operator withdrew the offer → refused.
- Renewal proceeds normally for a comped store with a live subscription (the
  §7 change), and `billingMayApplyPlan` still refuses to lower a comp.
- A store with no comp behaves exactly as today — the invariant-1 test.

## 12. Decisions (owner, 2026-09-06)

These were open when the spec was written and are now settled. They are recorded
here rather than folded silently into the text above, because each one removes a
feature somebody will later assume exists.

### 12.1 A comp does NOT suspend collection — the merchant keeps paying their own plan

**Decided: keep collecting.** During the free Pro month the merchant continues to
be billed for the Basic subscription they already had. The comp gives them a
_higher plan for free_; it is not a payment holiday.

Worked through the example — Basic ₹1,500/mo paid to 10 Sept, one free month of
Pro accepted on 6 Sept:

| Date    | What happens                                                     |
| ------- | ---------------------------------------------------------------- |
| 6 Sept  | Accepts. Uses **Pro**. Basic still runs underneath to 10 Sept.   |
| 10 Sept | Basic cycle turns. **Charged ₹1,500** as normal. Still uses Pro. |
| 6 Oct   | Comp ends. Falls back to **Basic**, paid and current to 10 Oct.  |
| 10 Oct  | Ordinary Basic renewal. Nothing special.                         |

The rejected alternative was to pause collection and push the subscription's
`current_period_end` out by 30 days, so they pay nothing during the comp. It is
more generous, and it was rejected because it turns the comp back into a billing
operation — writing cycle dates, which is exactly the collision §3.3 exists to
prevent — and because the moment a comp can move a cycle boundary, the expiry
sweep and the renewal worker are both steering `stores.plan` again.

**⚠ THE SUPPORT CONSEQUENCE, STATED PLAINLY.** A merchant told "one month of Pro,
free" and then charged ₹1,500 four days later will read that as a broken promise.
That is a copy problem, not a billing one, and it has to be solved in copy: the
offer must say **"Free upgrade to Pro for 30 days. Your Basic plan continues and
is billed as usual."** If that sentence is not acceptable to the business, the
decision to revisit is this one — not the schema.

### 12.2 Overlapping the paid cycle costs the merchant those days, and that is intended

Accepting on 6 Sept with 4 days of Basic left means those 4 days are spent under
Pro instead. **Nothing is credited, extended or refunded.** It is the merchant's
choice to accept early.

★ Note this needs **no implementation at all** — it is what the overlay already
does. Basic keeps running underneath and is simply outranked. The only way to get
the other behaviour would be to add code that credits the overlap, and that code
is not being written.

### 12.3 No mid-window revocation

Once accepted, a comp runs to `comp_expires_at`. There is no revoke path, so
there is no "how much notice?" question and no notification to design. An
operator who must intervene edits the row directly, which is a deliberate
break-glass rather than a product feature.

⚠ The _offer_ can still be withdrawn before acceptance — that is only clearing
`comp_plan` / `comp_duration_days`, and §8.2's re-read inside the write already
handles the merchant clicking a button that is no longer valid.

### 12.4 Offers do not expire

An un-accepted offer stands until an operator withdraws it. No sweep, no
deadline. `comp_offered_at` is retained for display and audit only.

### 12.5 Stacking replaces, it does not extend

★ Taken as the default — this was the one item left unanswered, and the schema
constraint in §5 already assumes it. A second grant overwrites the first
outright: `comp_plan`, `comp_duration_days` and, on the next acceptance, a fresh
window. It cannot silently shorten a comp that is already running, because an
active window is only replaced when the merchant accepts the new offer.

Extending (summing durations) was not chosen because two grants of a month would
then be indistinguishable from one of two months, and the audit trail in
`plan_events` is the only place the difference would survive.
