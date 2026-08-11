# Billing & Payments — Phase 1 architecture

> **Status:** draft v1 (2026-08-11) · **Owner:** Vansh · **Purpose:** the design
> StoreMink's billing system is built to, per the production-grade billing spec.
> No production customers exist, so this replaces the current Razorpay
> Subscriptions design rather than migrating it.

**Decisions already settled by the owner** (2026-08-11) and treated as fixed
inputs below:

1. **A 30-day cycle means exactly 30 days.** Never a calendar month.
2. **Automatic downgrade to Free after the 2-day buffer**, as specified.
3. **GST is operator-configured**, not merchant-facing. There is no platform
   GSTIN yet; the system must work without one and start charging tax when one
   is entered in the operator dashboard.
4. **Yearly is 365 days**, held in the same period config as monthly's 30.
   ⚠ Consequence, and it is the 30-day rule's logic applied consistently: a
   365-day cycle is a DURATION, not an anniversary, so it drifts by a day across
   every leap year. A cycle starting 1 Jan 2028 ends 31 Dec 2028. Pinned by a
   test so nobody "fixes" it into an anniversary later.
5. **Downgrade force-closes an open POS shift with a system note.** `posEnabled`
   goes false at downgrade, so the till stops; an open shift holds uncounted
   cash, and leaving it open strands the drawer with no way to reconcile it.
   The close is part of the downgrade transaction, attributed to the system
   rather than to a cashier, with `counted = expected` and a note naming the
   downgrade — a variance invented by a billing event would otherwise read as a
   cashier being short.

---

## 1. The core seam

```
        StoreMink Billing                    Razorpay
    (source of truth for WHAT              (collects money,
      is owed and WHEN)                     reports outcomes)
              │                                   │
      invoice + line items  ──────────▶  order + recurring payment
              ▲                                   │
              └──────── webhook / verification ───┘
```

StoreMink owns: plan, entitlement, pricing, cycle, locations, invoices, line
items, payment obligations, grace, downgrade. Razorpay owns: mandates, tokens,
and the movement of money. **A Razorpay Plan is never the source of truth for an
amount**, which is what today's design gets wrong (§2).

---

## 2. Why the current design is replaced, not migrated

Verified against Razorpay's live documentation, August 2026:

| Finding                                                                                                               | Consequence                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "You can only update a Subscription authorised using cards and not via UPI and Emandate."                             | Every amount change — tier, period, locations — is impossible for a UPI or e-mandate subscriber. Both `changePlan` and `changeBilledLocations` call the same `rzpUpdateSubscription`, so both are dead on those methods. |
| Add-ons are deprecated ("You are unable to use the Add-Ons feature since it is deprecated.")                          | The usual mid-cycle-charge escape hatch is closed.                                                                                                                                                                       |
| AFA-exempt limit is **₹15,000 per debit**, UPI and cards alike (see §2a)                                              | Most bills auto-collect. Yearly plans do not.                                                                                                                                                                            |
| Recurring payments are created by us, per charge: create order → create recurring payment against a `confirmed` token | The amount is ours to decide at charge time. Nothing provider-side needs updating when the bill changes.                                                                                                                 |

So the collection model becomes **token-based recurring**: authorise once,
then charge the amount StoreMink computed, every cycle.

### 2a. ★★ Two different ceilings — do not conflate them

This is the most misquoted pair of numbers in Indian recurring payments, and the
design depends on keeping them apart.

1. **The mandate's registered `max_amount`** — the most a mandate may ever be
   debited for. Set once at authorisation. Card e-mandates have "no practical
   upper transaction cap"; UPI mandates are registered up to a ceiling that can
   reach ₹1,00,000+.
2. **The AFA-exempt per-debit threshold** — the most that can be taken
   **without the customer authenticating that specific debit**. Under the RBI
   _Digital Payments — E-mandate Framework, 2026_ (effective 21 April 2026):
   **"Recurring transactions up to Rs. 15,000 per transaction may be processed
   without AFA."** Raised from ₹5,000 on 16 June 2022. It applies to UPI, cards
   and PPIs equally.

A mandate registered for ₹2,00,000 does **not** mean ₹2,00,000 can be silently
collected. It means debits are _permitted_ up to that, and every debit over
₹15,000 requires the merchant to obtain AFA from the customer that cycle — which
is not "automatic" in any sense the merchant or the billing worker cares about.

**The ₹1,00,000 AFA-exempt limit is real but StoreMink does not qualify.** The
framework grants it to exactly three transaction types: _"Payment of insurance
premiums, subscription to mutual funds, and credit card bill payments may be
processed without AFA up to Rs. 1,00,000 per transaction."_ (NPCI circular
UPI/OC-151A, Dec 2023, carried into the 2026 framework.) A SaaS subscription is
none of those. If StoreMink ever believes it qualifies, that is a question for
the acquirer and the MCC, not an assumption to build on.

**So the rule for automatic collection is a conjunction, not a single check:**

```
autoCollectable(invoice, mandate) =
      mandate.status === 'active'
  &&  invoice.total_paise <= mandate.max_amount_paise    // what was authorised
  &&  invoice.total_paise <= AFA_EXEMPT_LIMIT_PAISE      // 15_00_000 — what needs no customer action
```

Both conditions, always. `AFA_EXEMPT_LIMIT_PAISE` is a named constant, because
it has moved twice (₹5,000 → ₹15,000) and will move again.

### 2b. What this means for the catalog

Against `PLAN_META` (basic ₹1,500/mo · ₹15,000/yr, pro ₹5,000/mo · ₹50,000/yr),
with the AFA-exempt limit at ₹15,000:

| Charge                     | Amount  | Auto-collects?                |
| -------------------------- | ------- | ----------------------------- |
| Basic monthly              | ₹1,500  | ✓                             |
| Pro monthly                | ₹5,000  | ✓                             |
| Pro monthly + 5 locations  | ₹10,000 | ✓                             |
| Pro monthly + 10 locations | ₹15,000 | ✓ (at the line)               |
| Basic yearly               | ₹15,000 | ✓ (at the line)               |
| Pro yearly                 | ₹50,000 | ✗ — AFA or manual every cycle |

**Every monthly plan auto-collects, including Pro with a realistic number of
locations.** The manual path (§18 of the spec) is genuinely a fallback for
monthly billing — but it is the _only_ path for **Pro yearly**, and Basic yearly
sits exactly on the threshold with no headroom for a single added location.

Two consequences worth deciding on deliberately:

- **Yearly billing is structurally harder to collect than monthly**, which
  inverts the usual assumption that annual prepay is the safer revenue. If
  yearly matters commercially, the answer is either AFA-at-renewal as a designed
  flow, or splitting a yearly commitment into monthly debits.
- **`mandateMaxPaise()`'s ₹2,00,000 is not wrong as a ceiling** — a mandate is a
  ceiling, not a charge, and headroom costs nothing. It was only ever wrong as a
  _proxy for what can be collected_. The AFA check above is what that guard
  should have been.

### 2b-i. ★★ How large a mandate to ask for

`mandateMaxPaise()` today takes **no arguments** and returns one global number —
Pro yearly × 2 + ten locations = **₹2,00,000** — for every merchant regardless of
what they signed up for. A Basic-yearly merchant (₹15,000/yr) is asked to
authorise 13× their bill, and over half of that ceiling provisions for extra
locations, which a Basic plan cannot buy at all (`posLocationsIncluded: 0`, and
`validateBilledLocations` refuses outright when that is zero).

**The governing principle: the mandate must always cover the RENEWAL. It need
not cover every possible future purchase.**

- A renewal that fails costs a grace period, a downgrade, and possibly the
  merchant. Unacceptable.
- An upgrade or a location purchase that needs re-authorisation happens while the
  merchant is on screen taking a deliberate action. Perfectly acceptable — put
  the friction there.

That inverts the current design, which loads all the headroom onto signup (where
it costs conversion) to avoid friction on discretionary purchases (where nobody
would mind it).

**★ And headroom above ₹15,000 buys almost nothing anyway.** Per §2a, any debit
over the AFA-exempt limit needs the customer to authenticate that cycle — so a
₹2,00,000 ceiling does not make a ₹50,000 renewal automatic, it merely makes it
_permitted_. The "keep room for upgrades" rationale largely collapses once that
is understood.

So: size on `plan amount + currently-billed locations`, provision for tax, add
modest room for a reprice, round to something a human reads without alarm.

```
mandateMaxPaise(plan, period, billedLocations) =
  roundUpToNiceNumber(
      (planAmount + billedLocations × locationPrice)   // what renewal will actually cost
    × TAX_PROVISION      // 1.18 — see the trap below
    × REPRICE_HEADROOM   // 1.5
  )
```

| Signup                          | Renewal cost | Mandate to ask for |
| ------------------------------- | ------------ | ------------------ |
| Basic monthly                   | ₹1,500       | **₹3,000**         |
| **Basic yearly**                | **₹15,000**  | **₹27,000**        |
| Pro monthly, no extra locations | ₹5,000       | **₹9,000**         |
| Pro yearly, no extra locations  | ₹50,000      | **₹89,000**        |

**★★ The tax provision is not optional, and this is the trap.** GST is off today
and will be switched on from the operator dashboard later (owner decision).
Basic yearly then becomes ₹15,000 + 18% = **₹17,700**. A mandate registered at
₹15,000 — the bare plan price — would be **refused outright** at the first
post-GST renewal, for every merchant who signed up before the switch, with no way
to raise it except re-authorising. Size every mandate tax-inclusive from day one
even while `tax_enabled = false`.

**★ And note what ₹17,700 means for Basic yearly specifically:** it is over the
₹15,000 AFA-exempt limit, so once GST is on, **Basic yearly renewals need AFA
every cycle regardless of the mandate**. Generalised — with GST at 18%, any
pre-tax charge above **₹12,711** crosses the line:

| Pre-tax                           | With GST | Auto-collects post-GST? |
| --------------------------------- | -------- | ----------------------- |
| Basic monthly ₹1,500              | ₹1,770   | ✓                       |
| Pro monthly ₹5,000                | ₹5,900   | ✓                       |
| Pro monthly + 6 locations ₹11,000 | ₹12,980  | ✓                       |
| Pro monthly + 8 locations ₹13,000 | ₹15,340  | ✗                       |
| Basic yearly ₹15,000              | ₹17,700  | ✗                       |
| Pro yearly ₹50,000                | ₹59,000  | ✗                       |

Monthly billing survives GST up to roughly seven extra locations. **No yearly
plan does.** That is worth knowing before yearly is marketed as the default.

### 2c. ★★ The X+3 rule reshapes the renewal timeline

RBI requires a pre-debit notification **at least 24 hours before every debit**,
carrying the amount, date and mandate reference. Razorpay's guidance is to
expect recurring payments to take **X+3 days** to confirm — a payment scheduled
for the 1st is processed on the 4th. For e-mandate, same-day debit requires the
request to reach Razorpay by **08:59 on a bank working day**.

This is the single most important operational fact in the document, because the
naive loop — _cycle starts → create invoice → charge → 2 days → downgrade_ —
would expire the grace period **before the payment result is even known**, and
downgrade merchants whose money is still in flight. That directly violates
Rule 6 and §69.

**The fix is to move collection earlier, not to weaken the 2-day rule:**

```
T-4d    finalize invoice (amount frozen, number allocated)
        └─ pre-debit notification goes out
        └─ create Razorpay order + recurring payment
T-4d→T0 payment confirms inside the X+3 window
T0      cycle start — the answer is already known
        ├─ captured  → new cycle begins, nothing to do
        ├─ failed    → past_due; grace starts; grace_ends_at = T0 + 48h
        └─ unknown   → NO grace, NO clock. Reconciliation. (Rule 6)
T0+48h  downgrade worker — conditional claim, only if still unpaid
```

The merchant still gets exactly the 2-day buffer from the moment their payment
is known to have failed. They simply do not get punished for the settlement
window.

**A consequence worth stating, because it resolves an ambiguity:** the amount is
frozen at T-4d, so a location added at T-2d bills on the **next** invoice. That
is deterministic and it is what the merchant is told.

---

## 2d. Current state — what exists today

Per spec §75 items 1–7. Everything here is replaced unless §9 says otherwise.

**Billing flow.** `startPlanSubscription` → `rzpCreateSubscription` against a
Razorpay Plan resolved from `razorpay_plans` (composite PK `(plan, period,
amount_paise)`, so a reprice mints a new plan id and grandfathers subscribers) →
merchant authorises in the checkout modal → `confirmSubscription` verifies the
signature and writes `stores.plan`, `plan_expires_at`, `plan_source='paid'`.
Renewals are Razorpay's job; we learn about them from `subscription.charged`.
**There is no invoice, no line item, no payment attempt, and no payment record
of any kind** — the entire billing history is `plan_events`, an audit log with
no idempotency key.

**Razorpay flow.** `lib/payments/razorpay.ts` — plain `fetch`, Basic auth, no
SDK. Subscription surface: `rzpCreatePlan`, `rzpCreateSubscription`,
`rzpFetchSubscription`, `rzpCancelSubscription`, `rzpUpdateSubscription`
(`PATCH`, the call UPI/e-mandate refuses). Platform credentials only —
subscription billing never touches a store's BYO gateway.

**Models.** `store_subscriptions` (one row per store, Razorpay's status
vocabulary in a CHECK), `razorpay_plans` (the plan-id cache), `plan_events`
(audit), `plan_prices` (operator pricing, in **rupees** deliberately),
`billing_webhook_events` (`event_id` PK only), and `stores.plan` /
`plan_source` / `plan_expires_at` as the actual entitlement.

**Webhook flow.** `POST /api/webhooks/razorpay` — raw-body HMAC, event-id
insert-first dedup, then **six sequential `withService` transactions** processed
synchronously inside the request, including outbound email and
`revalidateTag`. Handles `subscription.*` only. **There is no `payment.captured`
handler anywhere in the codebase**; AI credits and storefront orders both rely on
client callback plus reconcile-on-read.

**Plan change.** `changePlan` → `decidePlanChange` (dearer = now, cheaper or
equal = cycle end) → `rzpUpdateSubscription`.

**Location billing.** `changeBilledLocations` folds the location cost into the
subscription _amount_ by swapping to a different Razorpay plan id — the design
that cannot work on UPI or e-mandate.

**AI credits.** Already close to correct: pending row inserted before the
gateway call, settlement is a conditional `WHERE status='pending'` claim, and
the real guarantee is a **unique partial index on `ai_credit_ledger (kind, ref)
WHERE kind='purchase'`**. Three gaps (§8).

**Test coverage.** `plan-change.ts`, `location-billing.ts`, `renewal.ts` and
`pricing.ts` are pure and tested. The action layer, the webhook and the
reconcile paths are not.

### 13 defects found while mapping — and why that argues for the rebuild

Two are live revenue bugs. **`confirmSubscription` writes `stores.plan`
unconditionally**, bypassing `billingMayApplyPlan` — so a comped store that
subscribes can have its comp overwritten _downward_ (comped Pro + subscribes
Basic ⇒ store drops to Basic), which is the exact failure that rule exists to
prevent, in the one path that skips it. And **a scheduled location release never
lands**: `billed_locations` is written only on the immediate branch, the webhook
never writes it, so Razorpay bills the cheaper plan while `locationAllowance`
keeps granting the released slots free — indefinitely. A third,
**re-subscribing after a cancel keeps `billed_locations` while resolving the
bare tier price**, giving away every paid location.

The rest: asymmetric amount comparison on the `amountForRzpPlan` fallback path
(a downgrade misread as an increase and charged now); stale
`current_end`/`scheduled_*` surviving a re-subscribe; `expired` being a status
Razorpay emits that the CHECK constraint forbids, which poisons the webhook into
an infinite 500-retry loop; healthy autopay subscribers receiving "your plan is
expiring" 7 days and 1 day before **every** renewal because the expiry cron never
consults `hasLiveMandate`; and `plan_source` surviving expiry so stores nobody
ever comped are treated as comped.

**Ten of the thirteen live in code this rebuild deletes outright.** Fixing them
in place costs nearly what replacing them costs, and leaves the UPI dead end
untouched.

---

## 3. Billing timebase

- **All timestamps are `timestamptz`, computed server-side, stored UTC.**
  Displayed in `Asia/Kolkata`. Never derived from the browser.
- **A cycle is `period_start + interval '30 days'`.** Exactly. February, leap
  years and 31-day months have no special behaviour, and the tests assert
  precisely that — a cycle starting 31 Jan ends 2 Mar in a non-leap year, and
  nothing anywhere clamps a day-of-month.
- **Anchor drift is intended.** A cycle starting 1 Aug renews on the 31st, then
  the 30th. Accepted consequence of the 30-day rule; the merchant is shown their
  actual next billing date, never "the 1st of each month".
- **12.17 cycles per year.** A ₹1,500 "monthly" plan collects ₹18,250 across a
  year, and some calendar years contain 13 charges. Say so in the pricing copy.
- **Yearly is `duration_days = 365`**, held in the same period config as
  monthly's 30 rather than inferred. ⚠ Confirm: 365 vs 12 × 30 = 360.

---

## 4. State machines

### Payment attempt — monotonic, which is what makes out-of-order webhooks safe

```
created ──▶ processing ──▶ authorized ──▶ captured ──▶ refunded
   │            │              │          (terminal)   partially_refunded
   │            │              │
   └────────────┴──────────────┴──▶ failed / cancelled
                │
                └──▶ unknown ──(verification)──▶ captured | failed
```

**Rank the states and permit forward transitions only.** `captured` is terminal,
so a late `payment.failed` is rejected by the machine itself — deterministically,
with no timestamps and no argument about whose clock is right. This is a
stronger answer to §26 than "latest valid state wins".

`unknown` is a first-class state, not an error. It is what a timeout produces,
and the only exit is provider verification.

### Invoice

```
draft ──▶ open ──▶ processing ──▶ paid ──▶ partially_refunded ──▶ refunded
            │  ▲        │
            │  └────────┴──▶ failed ──┐
            │                          │ (retry creates a NEW attempt)
            │◀─────────────────────────┘
            │
            ├──▶ uncollectible   (grace expired → downgrade)
            └──▶ void            (operator only, audited, reason required)
```

### Subscription

```
free ──▶ active ──▶ past_due ──▶ grace ──┬──▶ active      (paid in time)
           ▲                              └──▶ downgraded ──▶ free
           │
           └── cancelled (at period end)
```

Subscription state is **derived and stored**, never a boolean. `active` requires
a paid invoice for the current `cycle_seq`; the downgrade claim re-checks that
rather than trusting the column.

### Mandate

```
pending ──▶ active ──┬──▶ expired
                     ├──▶ revoked
                     └──▶ failed
unknown ──(verification)──▶ active | failed
```

**`unknown` triggers verification, never an assumption.** A newly created
mandate is `pending` until the token reports `confirmed`.

---

## 5. Schema

Integer paise everywhere. No floats, ever.

### `platform_billing_settings` — singleton, operator-managed

The owner's GST decision lives here.

```sql
create table platform_billing_settings (
  id              boolean primary key default true check (id),  -- one row, enforced
  legal_name      text,
  gstin           text,                    -- NULL until StoreMink has one
  address         jsonb,
  state_code      text,                    -- place of supply origin
  tax_enabled     boolean not null default false,
  tax_inclusive   boolean not null default false,  -- billing_05_tax_mode.sql
  tax_rate_bps    integer not null default 1800,   -- 18.00%
  invoice_prefix  text not null default 'SM',
  updated_at      timestamptz not null default now(),
  updated_by      text
);
```

- **★ `tax_inclusive` is the operator's choice, and it changes more than the
  arithmetic.** EXCLUSIVE (the default) means ₹15,000 + 18% = ₹17,700 charged;
  INCLUSIVE means ₹15,000 charged, of which ₹2,288.14 is GST — carved out as
  `gross × r / (1 + r)`, **not** `gross × r`. Three consequences:
  - **Under inclusive, switching GST on later changes nothing a merchant pays.**
    Under exclusive the same switch raises every bill 18%, against a mandate
    ceiling authorised before it — which is the entire reason
    `mandateSizePaise` provisions ×1.18, and that provision is dropped in
    inclusive mode (`taxInclusive: true`).
  - **Inclusive keeps more plans auto-collectable.** Basic yearly stays at
    ₹15,000, on the AFA line, instead of ₹17,700, over it (§2a).
  - **It must match what the pricing page advertises.** The page derives from
    `PLAN_META`, so a merchant reading "₹1,500" and being debited ₹1,770 will
    say so. Exclusive is the ordinary Indian B2B convention and lets them claim
    input tax credit cleanly; inclusive is the honest-headline-price option.
- **`tax_enabled = false` until a GSTIN exists.** Invoices then carry
  `tax_paise = 0`, render no GSTIN block, and state that tax is not applicable.
- **Turning tax on is never retroactive.** It applies to invoices finalized
  after the change. Historical invoices are immutable (§23), so a merchant's
  April invoice does not sprout GST in September.
- Edited from the operator console beside `pricing-panel.tsx`. Every change is
  audited with the operator's identity.

### `billing_accounts` — one per store

`store_id` PK, billing email, legal name, address, `state_code`, and the
**merchant's** `gstin` (nullable — they need it on the invoice to claim input
tax credit). Operator-editable; merchant-editable later.

### `subscriptions`

`store_id` PK, `plan`, `period`, `state`, `current_cycle_seq int`,
`current_period_start/end`, `billed_locations`, `scheduled_plan`,
`scheduled_period`, `cancel_at_period_end`, `grace_started_at`, `grace_ends_at`,
`mandate_id`, and the **existing** `plan_source` / `plan_expires_at`, which are
load-bearing (§8 below).

### `mandates`

`provider`, `provider_customer_id`, `provider_token_id`, `method`
(`card|upi|emandate|nach|unknown`), `status`, `max_amount_paise`,
`authenticated_at`, `expires_at`, `revoked_at`, `provider_metadata jsonb`.
**No card data, ever.**

`max_amount_paise` is read back from the token, not computed by us — which is
what replaces `mandateMaxPaise()`'s invented ₹1,30,000 ceiling.

### `invoices`

```sql
kind            text not null check (kind in ('subscription','ai_credits')),
number          text,          -- allocated on finalize, never on draft
number_seq      integer,
status          text not null,
subtotal_paise  bigint not null,
discount_paise  bigint not null default 0,
tax_paise       bigint not null default 0,
total_paise     bigint not null,
currency        text not null default 'INR',
cycle_seq       integer,       -- subscription only
period_start    timestamptz,
period_end      timestamptz,
finalized_at    timestamptz,
due_at          timestamptz,
paid_at         timestamptz,

constraint invoice_one_per_cycle
  unique (store_id, kind, cycle_seq)      -- NULLs don't collide, so ai_credits is unaffected
```

**That unique constraint is the whole answer to §35.** Two renewal workers
cannot both create an invoice, regardless of transaction isolation or worker
coordination. `cycle_seq` — not a timestamp — is the idempotency key.

### `invoice_line_items`

`kind` ∈ `base_plan | location | addon | proration | discount | tax |
account_credit`, with description, quantity, `unit_amount_paise`, `amount_paise`.
A trigger rejects INSERT/UPDATE/DELETE once the parent invoice is finalized —
immutability enforced by the database, not by convention.

### `payment_attempts`

```sql
idempotency_key  text not null unique,   -- OURS, minted before calling Razorpay
mode             text not null check (mode in ('automatic','manual')),
state            text not null,
amount_paise     bigint not null,
provider_order_id, provider_payment_id, provider_token_id  text,
failure_code, failure_reason  text,

create unique index one_attempt_in_flight on payment_attempts (invoice_id)
  where state in ('created','processing','authorized');
```

**That partial index is the whole answer to §28 and §36.** Three clicks, or an
automatic retry racing a manual payment, cannot produce two in-flight attempts —
the second INSERT fails at the database.

**★ This is `lib/payments/issue-refund.ts` generalised, not a new invention.**
That module is the only path in the codebase that already handles "we never
learned the outcome" correctly, and every element transfers:

| `issue-refund.ts`                                                                                           | Here                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| INSERT `order_refunds` `pending` with our `idempotencyKey`, inside one transaction with the amount check    | INSERT `payment_attempts` `created` before any gateway call                                 |
| Key sent as **both** `X-Razorpay-Idempotency-Key` and `notes.sm_refund_key`                                 | Same — the `notes` copy is what reconciliation matches on if the header is ever unsupported |
| Settlement is `UPDATE … WHERE status = 'pending'`, and a lost claim reports `pending` rather than asserting | Identical claim on `payment_attempts`                                                       |
| `outcome: "unknown"` → **do not fail, do not retry**, return `pendingReconcile`                             | Identical — this is Rule 6's primitive                                                      |

And `RzpResult` **already** carries the distinction the spec asks for
(`lib/payments/razorpay.ts:47`): `status >= 500 → "unknown"`, a network throw →
`"unknown"`, 4xx and own-precondition failures → `"rejected"`. §43/§69 do not
need new plumbing; they need every caller to respect what is already there.

### `billing_webhook_events` — extend, do not replace

**This table already exists** (`subscriptions_01_schema.sql`): `event_id text
primary key`, `event_type`, `received_at`. The dedup idea is right and the unique
key is the right one. Four things are missing or wrong:

1. **The marker and the work are in different transactions.** The marker is
   inserted and committed, then processing runs; on a throw the marker is
   _deleted_ as compensation — and that delete is `.catch(() => {})`. If it
   fails, the event is permanently marked processed and never applied. Silent
   loss.
2. **Processing is fully synchronous inside the request**, including outbound
   email and `revalidateTag`. Razorpay's timeout is the effective budget, and a
   DB blip inside the suppression lookup returns 500 and makes Razorpay redeliver
   the whole plan-activation path.
3. **No payload is stored**, so an event cannot be replayed — only re-received.
4. **No retention path** — text PK, no `received_at` index, no pruning job. It
   grows forever.

Add: `payload jsonb`, `signature_verified`, `status` ∈
`received | processed | failed | ignored`, `attempts`, `last_error`,
`processed_at`, and an index on `received_at` plus a §32 retention entry.

**Persist first, process asynchronously.** The endpoint verifies the signature
against the raw body, inserts (conflict ⇒ already seen ⇒ 200), and returns.
A worker processes — the `data_jobs` lease pattern (`SELECT … FOR UPDATE SKIP
LOCKED` + lease write in **one** transaction) is already in the codebase and is
the template. That removes the compensating-delete hazard entirely: the marker
_is_ the queue row, and failure just leaves it claimable again.

⚠ **`withService` is one transaction per call.** Sequential `withService` calls
are separate transactions — which is precisely why the current webhook (six of
them) and `settlePurchase` (two) are non-atomic. Anything that must be atomic
goes in a single callback.

### `reconciliation_items`

`kind` ∈ `unknown_payment | orphan_payment | amount_mismatch | missing_webhook |
state_conflict | wrong_association`, with `provider_payment_id`, optional
`invoice_id`, `detail jsonb`, `status`, and resolution attribution. Nothing is
ever guessed; ambiguity lands here.

### `billing_credits` — append-only ledger

Mirrors `customer_credit_ledger` (§29), which already solves this shape. Needed
for the post-downgrade rule in §7.

---

## 6. Invoice numbering

GST requires a gapless consecutive series per financial year. This codebase has
already paid for getting serials wrong twice, so reuse both lessons rather than
re-deriving them:

- **Allocated by a trigger on finalization**, never on draft creation — the same
  reason the credit-note serial is allocated on settlement (§28): a draft that is
  never finalized would otherwise burn a number, and _a gap is what an audit
  flags_.
- **Routed through `sm_pad()`**, never bare `lpad()`, which truncates as well as
  pads and silently produced duplicate order references past 9999
  (`identifiers_05_no_truncate.sql`).
- **One series across both invoice kinds.** Multiple series are permitted but
  each must be independently consecutive; one is simpler and there is no reason
  for two.
- The counter is **platform-level**, not `store_counters` — StoreMink is the
  supplier here, not the merchant.

---

## 7. The billing rules, as implemented

### Renewal

Per §2a: finalize at T-4d, collect, evaluate at T0.

### Grace and downgrade — one conditional claim

```sql
update subscriptions s
   set plan = 'free', state = 'downgraded', downgraded_at = now(), billed_locations = 0
 where s.store_id = $1
   and s.state = 'grace'
   and s.grace_ends_at <= now()
   and s.plan_source <> 'comp'
   and not exists (
     select 1 from invoices i
      where i.store_id = s.store_id and i.kind = 'subscription'
        and i.cycle_seq = s.current_cycle_seq and i.status = 'paid')
returning store_id;
```

Zero rows means: already downgraded, or they paid, or they are comped. **§11,
§37 and §39 all fall out of this single statement** — no lock, no second query,
no read-then-write window. It is the codebase's established exactly-once pattern
(`increment_coupon_usage`, the reserved→released stock claim, `pickup_warned_at`).

The same transaction marks the unpaid invoice `uncollectible`.

### Payment after downgrade

Per the review and unchanged by the owner's clarifications: once downgraded, the
invoice is **`uncollectible` and no longer payable**. It stays fully recorded
with its amount, attempts, failure reasons and grace timestamps — §8 is satisfied
because the outcome is _stated_, not hidden. Re-subscribing creates a fresh
invoice.

If money arrives anyway (a late settlement, a race), it becomes an
**`account_credit`** in `billing_credits`, applied to their next subscription
invoice. The plan is **not** reactivated. This keeps the owner's "no phantom
reactivation" rule while never collecting money for a service period that was
not delivered.

### Plan and location changes

Settled, following the reasoning the codebase already committed to in §15b —
keep refunds out of the system entirely:

| Change          | When                                     | Money                                                              |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Upgrade         | Immediate                                | Prorated charge on its own immediate invoice; new cycle starts now |
| Downgrade       | Next cycle boundary                      | None. They keep what they paid for                                 |
| Add location    | Next invoice (forced by the T-4d freeze) | None now                                                           |
| Remove location | Next cycle                               | None                                                               |

No negative invoices, no partial refunds, no duplicate credits in the
subscription path — which removes most of §20's worry list by construction.

### Comped and operator-granted plans

`plan_source = 'comp'` stores have **no mandate and no invoice**. They must be
skipped by the renewal worker entirely and are excluded from the downgrade claim
above. `plan_expires_at` and the plan-expiry cron remain a separate, parallel
route to Free and must not double-fire with this one. The existing
`billingMayApplyPlan` rule — _a comp is a floor, not a ceiling_ — survives
unchanged; it exists because a comped store that later paid for Pro had all
three webhooks discarded.

---

## 8. AI credits — separate domain, shared infrastructure

An AI credit purchase is an `invoices` row with `kind = 'ai_credits'`, its own
payment attempt, and **never** a line on a subscription invoice.

- `cycle_seq` is NULL, so the one-invoice-per-cycle constraint does not apply.
- The credit grant is keyed on `invoice_id`, **unique in the ledger** — three
  identical webhooks grant once (§53). The existing `ai_credit_ledger` already
  has a unique partial index on `(kind, ref) WHERE kind='purchase'` and
  `try_spend_ai_credit` is already a single conditional UPDATE, so this is an
  extension of a working design rather than a new one.
- Subscription state is never consulted when granting, and credits are never
  revoked by a subscription downgrade.
- Purchases succeed while a subscription is in grace, and vice versa. There is
  no code path where one reads the other.

**Three concrete gaps to close, all narrow:**

1. **The unreconcilable window.** `startCreditPurchase` inserts the pending row,
   then creates the Razorpay order, then writes `rzp_order_id` back. If that last
   write fails, the row is `pending` with a null order id — and
   `reconcilePendingPurchases` _skips exactly those_ (`if (!p.rzp_order_id)
continue`). A merchant who paid in that window can never be credited by any
   automated path. Fix: mint our own `idempotency_key` first and pass it in
   `notes`, so reconciliation can find the order without needing the id round
   trip — the `issue-refund.ts` pattern again.
2. **The claim and the grant are separate transactions.** `settlePurchase`
   claims `pending → paid`, then calls `add_ai_credits`. If the second fails, the
   purchase is `paid` with no credits, and reconcile filters on
   `status='pending'` so nothing ever retries it. Fix: one transaction, or a
   `credit_granted_at` column that reconciliation targets.
3. **No `payment.captured` webhook.** Everything rests on the merchant's browser
   returning plus a reconcile-on-page-load. Adding the webhook removes both the
   window and the dependence on a page nobody may visit.

---

## 9. What is reused, and what goes

**Reused as-is:**

- `lib/plans.ts` — catalog, `PLAN_LIMITS`, `PLAN_RANK`, `effectivePlan`,
  `normalizePlan`, `expiryWarnWindow`. Pure and tested.
- `lib/plans/pricing.ts` — the cached/live split is exactly right and already
  observed: **`getPlanPricingLive` wherever the number decides a charge**,
  cached elsewhere. Keep the discipline.
- `billingMayApplyPlan` — the comp-is-a-floor rule, unchanged.
- `plan_events` — the audit log, plus a dedup key it currently lacks.
- `lib/payments/razorpay.ts` transport: `rzpFetch`, `rzpCreateOrder`,
  `verifyWebhookSignature`, `verifyCheckoutSignature`, and **`RzpResult`'s
  `rejected` / `unknown` discrimination**, which is Rule 6's primitive already
  built.
- `lib/payments/issue-refund.ts` — the template for `payment_attempts` (§5).
- The AI credit ledger, `add_ai_credits`, `try_spend_ai_credit`.
- The `data_jobs` lease/cursor worker (`SELECT … FOR UPDATE SKIP LOCKED` +
  lease in one transaction) as the webhook processor and renewal worker.
- `splitGst`'s remainder trick — **re-implemented in paise**. The existing one
  rounds to two decimals (rupees) and must not be called directly from invoices.
- `lib/plans/renewal.ts` — and it should finally be _used_ by the expiry warning
  path, which is bug 7 above.

**Removed:** Razorpay Subscriptions entirely. `rzpCreatePlan`,
`rzpCreateSubscription`, `rzpUpdateSubscription`, `rzpCancelSubscription`,
`resolveRazorpayPlanId`, the `razorpay_plans` cache table, every `subscription.*`
webhook case, `mandateMaxPaise()`'s computed ceiling, `totalCyclesFor`,
`reconcileStaleSubscription`, and the half of `decidePlanChange` that exists only
because the price lives in a provider-side plan id. `store_subscriptions`'
Razorpay status CHECK goes with it — our own vocabulary replaces it.

**Kept but rewritten:** `cancelSubscription` (no gateway subscription to cancel —
it sets `cancel_at_period_end` and lets the cycle run out), and the plan-expiry
cron, which must not double-fire with the new downgrade claim.

---

## 10. Still to verify before Phase 3

Recorded honestly rather than guessed. The flow, methods, limits and timing above
are verified; these are not:

- The exact endpoint and request body for creating a subsequent recurring
  payment (the docs index references it without reproducing the signature).
  Confirm against the API reference **and a test-mode dry run**.
- The exact webhook event names for token-based recurring, and whether
  `token.confirmed` / `token.cancelled` are emitted.
- The largest `max_amount` Razorpay will actually register for a **UPI** mandate
  (cards have no practical cap). §2c settles the AFA threshold at ₹15,000; the
  registration ceiling is a gateway/acquirer question, not a regulatory one.
- Whether StoreMink's MCC could ever qualify for the ₹1,00,000 AFA-exempt
  category. Assume **no** until the acquirer says otherwise in writing.
- MCC restrictions on the platform's own Razorpay account for recurring.
- Who sends the pre-debit notification for token-based recurring on **cards**
  (confirmed for UPI AutoPay), and whether `sms_notify` / `email_notify` are
  sufficient.
- Whether `duration_days` for yearly is 365 or 360.

---

## 11. Non-negotiables

1. Never charge twice because a status is uncertain.
2. Never mark an invoice paid without verified payment.
3. Never grant AI credits without verified successful payment.
4. Never trust the frontend for amount or state.
5. Never delete a financial record.
6. Never downgrade on an unknown payment state caused by a provider outage.
7. After the 2-day grace, an unpaid subscription moves to Free automatically.
8. A payment after downgrade never reactivates the plan.
9. AI credits are completely separate from subscription billing.
10. When state is ambiguous, reconcile — never guess.
