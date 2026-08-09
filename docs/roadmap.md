# Roadmap — POS, locations & fulfilment

**The single ordered plan, and the specification for each step.** What ships
next, in what order, why that order, and in enough detail to start work from.

Three design docs stay authoritative for HOW an already-shipped piece works —
`docs/pos-plan.md` (register, staff, devices, shifts),
`docs/inventory-fulfilment-roadmap.md` (locations, routing, reservations) and
`docs/returns-exchanges-plan.md` (returns, exchanges, refunds). This file is the
sequence AND the spec for everything still to build.

- **Acceptance tests:** `docs/pos-acceptance.md` — a step is not done until its
  user stories are in there
- **Architecture:** `CODEBASE.md` §22 (POS), §23 (locations), §24 (notifications)

> **Keep this current.** Any commit that finishes, splits or reorders a step
> updates the table below in the same commit — the rule `AGENTS.md` carries. A
> roadmap nobody trusts is worse than none: it gets read once, found wrong, and
> then quietly ignored.

> **★ marks a non-obvious invariant** — something that looks right by accident
> and breaks silently. Those are the lines worth re-reading during review.

---

## Status at a glance

| #      | Step                                                           | Size | State   |
| ------ | -------------------------------------------------------------- | ---- | ------- |
| —      | POS 0–4: locations, register, GST, shifts, shop-floor stock    | —    | ✅ done |
| —      | LOC A–F: capabilities, scope, routing, reservations, pickup    | —    | ✅ done |
| —      | Refunds, cancellation, returns, exchanges, BORIS, credit notes | —    | ✅ done |
| —      | Store credit                                                   | —    | ✅ done |
| —      | Metered extra-location billing (POS 7)                         | —    | ✅ done |
| **1**  | Checkout payment defaults + pickup payment policy              | S    | ✅ done |
| **2**  | **Cancellation: per-product policy + refund to source**        | M    | ⏭ next |
| **3**  | Pickup end to end: collection code, QR, manager/cashier split  | L    | ⏳      |
| **4**  | POS customer capture (Shopify parity) + claim/merge            | L    | ⏳      |
| **5**  | Receipts — email, then WhatsApp/SMS (POS 6)                    | M    | ⏳      |
| **6**  | Channel stock policy (LOC H)                                   | M    | ⏳      |
| **7**  | Transfer lifecycle (LOC I)                                     | M    | ⏳      |
| **8**  | More routing strategies (LOC J)                                | M    | ⏳      |
| **9**  | Gift cards                                                     | M    | ⏳      |
| **10** | Offline outbox (POS 9)                                         | XL   | ⏳      |
| **11** | Full omnichannel (POS 8 = LOC K)                               | XL   | ⏳      |

**Where we actually are.** Everything in the top block works. **Pickup is the
outlier**: every piece exists — holds, routing, the collection queue, tender
capture at hand-over, four email events — and _none of it has ever been run end
to end in a browser_. Steps 1 and 3 finish it.

---

# Part 1 — What to build

---

## Step 1 — Checkout payment defaults, and who pays when ✅ DONE

Two small changes to the same screen, shipped together because they touch the
same state (`995f83d`).

**✅ Shipped:** `lib/fulfilment/payment-policy.ts` (pure + tested — the one rule
the picker and `placeOrder` both ask), the `fulfilment.pickupPayment` setting,
the derived checkout default, server enforcement in `placeOrder`, and the
`canRequirePrepaid` guard on save. Acceptance: **PS-C.1–C.8**.

**★ THE DEFAULT IS DERIVED DURING RENDER, NOT SET IN AN EFFECT.** State holds
only the shopper's explicit choice (`null` = hasn't chosen); the displayed and
submitted method is computed. Two eslint rules caught the wrong shapes on the
way — `set-state-in-effect` (a cascading render and a visible frame on the wrong
option) and `refs` (a ref read during render). Deriving removes both, and the
"don't stomp a choice" race with them.

**★ The settings registry gained its first `select` type** to carry this, and
`saveStoreSettings` now validates EVERY type before writing — it used to store
whatever arrived, on the reasoning that the read side rejects a wrong-typed
value. True, but it left the stored blob full of values that do nothing, which
is what makes a settings bug impossible to diagnose from the database.

**⚠ NOT verified in a browser.** The Cloud SQL proxy could not start locally
(ADC needed re-authenticating). PS-C.3 and PS-C.4 move real money — run them
against a test-mode gateway.

Below is the spec it was built from, kept for the reasoning.

### 1.1 A gateway-configured store still defaults to COD

**The bug.** `app/(storefront)/(pages)/checkout/page.tsx:142` is
`useState<PaymentMethod>("cod")`, and nothing ever reconciles it with
`payConfig.onlinePayments` (loaded async at :158). So a merchant who has
connected Razorpay watches every shopper land on Cash on Delivery — the option
that costs them a courier round trip and a collection risk, pre-selected by us.

**Ships.** Default to `razorpay` once the config says online payments are live.

**★ IT MUST NOT STOMP A CHOICE THE SHOPPER HAS ALREADY MADE.** The config
arrives after first paint, so a naive
`useEffect(() => setPayMethod("razorpay"), [payConfig])` yanks the selection out
from under anyone who tapped COD in the intervening moment. Track whether the
control has been touched and apply the default only while it has not. A payment
method that changes itself after the customer picked one is worse than a wrong
default.

**★ Store credit still wins.** When a balance covers the order in full the
method resolves to `store_credit` regardless (§29) — the default only decides
what is pre-selected among the methods actually on offer.

### 1.2 Prepay, or pay at the counter — the merchant's call

**Today** checkout hardcodes
`fulfilment === "pickup" && payMethod === "cod" → "pay_at_store"`. A merchant who
wants collections paid up front has no way to say so, and one who wants cash at
the counter has no way to require it.

**Ships.** A registry setting `fulfilment.pickupPayment`, section `locations`,
group Checkout:

| Value             | Behaviour                                                       |
| ----------------- | --------------------------------------------------------------- |
| `customer_choice` | Both offered (today's behaviour) — **the default**, invariant 1 |
| `prepaid`         | Pickup orders must be paid online; `pay_at_store` is refused    |
| `at_store`        | Pickup orders are always settled at the counter                 |

**★ ENFORCED IN `placeOrder`, NOT ONLY IN THE PICKER.** A hidden radio is not a
permission (invariant 5). A store on `prepaid` that receives a `pay_at_store`
order must reject it — otherwise the goods are held and nobody ever owes
anything.

**★ `prepaid` NEEDS A GATEWAY.** Setting it on a store with no Razorpay
connection makes pickup unorderable. Refuse the setting server-side with a
sentence pointing at Channels.

**Files:** `checkout/page.tsx`, `lib/settings/registry.ts`,
`app/actions/checkout-actions.ts`.
**Acceptance:** PS-C.1–C.6. **Effort: half a day.**

---

## Step 2 — Cancellation: per-product policy, and money back to source

### 2.1 Which products a customer may cancel

**Today** `orders.allowCustomerCancellation` is store-wide. A merchant selling
both stock items and made-to-order goods cannot allow one and refuse the other.

**Ships.** `products.cancellable boolean NOT NULL DEFAULT true`, in its own
migration — **the exact shape `products.returnable` already has** (§28), for the
identical reason: the settings registry holds one value per store and cannot
address a single SKU.

**★ BACKFILL TRUE.** Nothing is non-cancellable today, so `false` would silently
change every live store's policy (invariant 1).

**★ WHOLE-ORDER ONLY, AND ONLY IF EVERY LINE IS CANCELLABLE — SETTLED.**
`cancelMyOrder` and `lib/orders/cancel.ts` cancel an entire order. Partial
cancellation is a different feature: partial refunds, partial restocks, and an
order that stays open afterwards — which is really "refund some items" and
belongs with returns. **Owner decision, 2026-08-09: a customer cannot cancel
part of a mixed order.**

⚠ **CORRECTION (2026-08-09):** an earlier draft of this said "Shopify draws the
same line". It does not. Shopify's self-serve cancellation is **per item** — a
customer cancels the unshipped items and returns the shipped ones in the same
order. (Its MERCHANT-side cancel is all-or-nothing, and refuses outright on a
partially fulfilled order.) The decision above stands on its own merits —
simplicity, and no partial-refund machinery — but not on that comparison.

The order page must say _why_ when the button is absent — "This order contains
items that can't be cancelled online" beats a missing control.

### 2.2 Refund to source on cancel

**This narrows a documented decision, deliberately.** The original rule (below,
in Part 2) was that cancelling never moves money, and it still holds for a
_merchant_ cancelling: money leaving with no human looking at it is the one
irreversible act with no physical trace. It does **not** hold for a customer
cancelling their own prepaid order — there the merchant is sitting on money for
goods that will never ship, and making them press a button for each one is a
support queue, not a control.

**Ships.** `orders.autoRefundOnCancel` (section `orders`, **default OFF** —
invariant 1, and confirmed by the owner 2026-08-09). When on:

- a **customer** self-cancel of a `razorpay`-paid order raises a gateway refund
  to source automatically, through `lib/payments/issue-refund.ts` — the ONE
  refund mechanism (§28), never a second copy;
- a **merchant** cancel still only _prompts_, exactly as today — **settled by
  the owner**: they may want to offer store credit, deduct something, or hold a
  suspicious order, and an automatic payout removes that choice;
- `cod` refunds nothing (no money moved); `store_credit` reinstates, which
  `reinstateCreditForOrder` already does.

**★ THE REFUND IS RAISED AFTER THE CANCEL COMMITS, NEVER INSIDE IT.** The cancel
claim is a conditional UPDATE that decides exactly-once; a gateway call inside
that transaction holds a row lock across a network round trip, and a timeout
would roll back a cancellation the customer has already been told about. Cancel
first, refund in `after()`, let reconcile-on-read settle an unknown outcome.

**★ AN `unknown` GATEWAY OUTCOME IS NOT A FAILURE.** §26 already draws this
distinction; it matters more here because nobody is watching. A 5xx means the
refund may exist, so the row stays `pending` and the sweep settles it. Reporting
it as failed is how a customer gets paid twice.

**★ THE PARTIAL-REFUND CAP STILL APPLIES.** `refundableAmount` must be consulted
even on an auto-refund — an order already partly refunded must not have its full
total sent back.

**Files:** new migration, `lib/settings/registry.ts`,
`app/actions/customer-order-actions.ts`, `lib/orders/cancel.ts`, the product
editor, `(pages)/orders/[id]`.
**Acceptance:** PS-C.7–C.14. **Effort: 2–3 days.**

---

## Step 3 — Pickup, end to end

The largest step and the one with the most already built. Read `CODEBASE.md` §23
first — holds, routing, the queue and tender capture all exist.

### 3.1 A collection code, and a QR for it

**Ships.** `orders.pickup_code text UNIQUE` — short, human-readable and
unambiguous (8 chars, Crockford base32: no `I`, `L`, `O`, `U`), generated at
order time for pickup orders only.

**★ THE CODE IS NOT THE ORDER ID.** Order UUIDs are internal and `order_ref` is
sequential and guessable (§14). A collection code is presented by whoever holds
it, so it must be random — but it is **not** an authorisation on its own: the
counter resolves it store-scoped and the operator still sees whose order it is.
Access control stays UUID + store scope; the code is a _lookup_ key, not a
bearer token.

**★ THE EMAIL LEADS WITH THE CODE, NOT THE QR.** Gmail strips `data:` URIs in
`<img>` and every major client blocks remote images by default. A QR that
renders as a broken-image icon on the one screen the customer holds up at the
counter is worse than no QR. So:

1. the **code in large text** in the email body — always renders, and can be
   read aloud or typed if a scanner fails;
2. a **link to a hosted collection page** showing the QR big enough to scan off
   a phone, plus the shop address and hold deadline.

That page is `/orders/[id]/collect`, owner-gated by the existing customer RLS,
`noindex`. QR generation happens there, client-side — no new server dependency,
no image hosting, and the code is already in the URL.

### 3.2 Manager prepares, cashier hands over

**Today** both `markReadyForPickup` and `markCollected` require only
`posCan(role, "sell")`, which every role holds — so a cashier can mark an order
packed without ever seeing it.

**Ships.** A capability `fulfil_pickup`, held by **manager and above**, gating
`markReadyForPickup`. `markCollected` stays on `sell`: handing a packed order to
a customer standing there is exactly a cashier's job.

**★ THIS CHANGES BEHAVIOUR, AND IS ONLY SAFE BECAUSE NOBODY IS USING IT.**
Invariant 1 forbids changing what a live store does — pickup has never been run
end to end, so there is no live behaviour to preserve. Say so in the commit. **If
any store has already enabled `fulfilment.offerPickup`, the capability must
default open instead.**

**Routing.** New pickup orders should reach managers **at that shop**, not the
whole store. `notification_settings.routing_scope = 'event_location'` already
does this (§24) and `placeOrder` already passes the resolved location — a default
to set, not a mechanism to build.

### 3.3 Scan at the counter

`/pos/pickups` gains a scan box resolving a collection code, reusing
`createKeyboardWedge` and `lib/pos/barcode-camera.ts` — a hardware scanner is a
keyboard, so this is mostly wiring. A code belonging to another shop must say
_which shop_, not "not found": the customer is standing there and the answer
they need is "this is waiting at Andheri".

### 3.4 What the shopper sees

`order-status.tsx` already speaks collection (§23). Missing: the **ready**
notification carrying the code, and the collection page linked from both the
confirmation email and the order page.

**Acceptance:** PS-8.1–8.31 (existing, still never run) + PS-C.15–C.24.
**Effort: 1–1.5 weeks.**

---

## Step 4 — POS customer capture, the Shopify way

### What Shopify does

1. Cart → **Add customer** → search, or **create one inline** (name, email,
   phone — all optional except a name).
2. The sale completes with or without a customer. A walk-in is a first-class
   outcome, never a blocked one.
3. At payment → **receipt options**: print, email, text, none. Contact entered
   _there_ attaches to the sale even with no customer record.

**We have (1) search and (2) optional.** We cannot create, and capture no
contact at receipt time.

### Why creating is hard here

`users.id` **is** the Firebase uid, and `multitenant_01` scopes uniqueness to
`UNIQUE (store_id, phone)` and `UNIQUE (store_id, email)`. So a till-invented row
has no natural primary key — and if that person later signs up online with the
same phone, **their signup collides with the row we invented for them**.

### Ships — an unclaimed customer, and a claim on signup

**Migration.** `users.claimed_at timestamptz` (NULL = never had an account).
Till-created rows get an id of `pos_<uuid>`, which the `text` PK already permits.

**★ AN UNCLAIMED ROW CAN NEVER LOG IN, AND THAT IS AUTOMATIC.** Customer RLS is
`auth.uid() = users.id`; a `pos_…` id matches no Firebase uid, so these rows are
invisible to every session without a single new policy. Do not add one.

**★ THE CLAIM IS THE WHOLE FEATURE.** When someone signs up with a phone
matching an unclaimed row for that store, `upsertCustomerProfile` must **adopt**
it rather than fail the unique constraint: rewrite that row's `id` to the
Firebase uid and stamp `claimed_at`, in ONE transaction. Their in-store purchase
history becomes theirs the moment they create an account — the actual CRM payoff,
not a side effect.

**★ `orders.customer_id` REFERENCES THAT ID.** Rewriting a PK under a live FK
needs `ON UPDATE CASCADE`, or an explicit update of both tables in the same
transaction. Either way it must be ONE transaction: a half-claimed customer has
orders pointing at an id that no longer exists.

**★ A COLLISION WITH A _CLAIMED_ ROW IS NOT A CLAIM.** If the matching row
already has `claimed_at`, that phone belongs to a real account — the till must
attach to it, not adopt it. Adopting would hand one customer's order history to
whoever typed their number.

**Receipt contact.** The tender panel gains an optional email field feeding the
existing notification machinery, so a walk-in gets an emailed receipt with no
account. SMS waits for Step 5.

**Acceptance:** PS-C.25–C.34. **Effort: 1–1.5 weeks**, and the riskiest work
here — it touches identity. Land it behind tests before anything else in Step 4.

---

## Step 5 — Receipts

Email receipts for POS sales (Step 4 captures the address), then WhatsApp/SMS via
Twilio behind the existing channel abstraction — `sms` and `whatsapp` are already
declared and `available: false` in `lib/notifications/channels.ts`. Unlocking
them is the work; the fan-out, the queue and the templates exist.

**Effort: 3–4 days** for email, **~1 week** for Twilio.

---

## Step 6 — Channel stock policy _(LOC H)_

Per-location, per-channel reserve buffers: "never sell the last 2 online at this
shop", so the shelf can't be emptied by the website mid-afternoon. Rests on the
Phase E reservations, which is why it comes after them.

---

## Step 7 — Transfer lifecycle _(LOC I)_

Today a transfer is instantaneous — one atomic RPC, both legs or neither. Real
stock spends days on a van. **Ships:** an in-transit state, so units belong to
neither shop's sellable count while they move.

**★ THE GUARD CHANGES HERE.** `transfer_stock` currently checks
`on_hand >= qty` plus reserved. Once stock can be in transit that must become
`on_hand − reserved − in_transit`, or a transfer will ship units already promised
to someone.

---

## Step 8 — More routing strategies _(LOC J)_

`nearest`, `most_stock`, `cheapest`. Each is a file registering itself in
`lib/fulfilment/strategies.ts`; checkout never learns their names. `nearest`
needs location addresses plus geocoding.

**This is also where pickup radius belongs** — the lat/lng answer deliberately
skipped in F.1, because it would put a geocoding call on the checkout render
path. Solve it once, for both.

---

## Step 9 — Gift cards

They share the store-credit ledger shape, which is why
`customer_credit_ledger.kind` is an enum rather than a boolean; what they add is
a redeemable code and a purchase flow.

**Watch for:** a balance is money. Append-only ledger, atomic spend via a
conditional UPDATE — the `ai_credit_ledger` pattern, which already solves this
exact problem in this codebase.

---

## Step 10 — Offline outbox _(POS 9)_

Sell with no network: queue sales locally, reconcile on reconnect.

**Deliberately last.** It breaks the one invariant everything else rests on —
the server re-prices and re-reserves, so nothing cached is authoritative. An
offline sale is authoritative by definition, so this needs conflict rules (what
happens when two tills sold the same last unit) that only make sense once returns
and refunds exist to unwind the loser.

---

## Step 11 — Full omnichannel _(POS 8 = LOC K)_

Ship-from-store, endless aisle, inter-state IGST across locations, and unified
customer history spanning till and website.

---

## Also outstanding — unglamorous, worth scheduling

| Item                          | Why it matters                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Catalogue **delta** sync      | Every register re-pulls the whole catalogue every 5 min — O(catalogue), forever        |
| Money-event **audit**         | All 6 `posAudit` sites are auth-only; discounts, overrides and till refunds leave none |
| Analytics **location filter** | Store-wide figures only, on a multi-location product                                   |
| Sale round trips              | `placePosSale` makes 11 separate transactions — 11 × RTT on the fastest path           |
| Live **Razorpay** run         | Refunds and metered billing have never touched a real account                          |
| `data_jobs` retention         | §32 prunes logs but not CSV job rows; needs two policies + two `created_at` indexes    |

---

# Part 2 — Already shipped

Condensed. `CODEBASE.md` holds the architecture; what is kept here is the
_reasoning_, because several of these decisions constrain the steps above.

### POS 0–4 · LOC A–F

Locations + per-location inventory, the `/pos` shell with staff accounts and
device authorization, the register (GST, thermal receipts, barcode scanning,
local catalogue cache), shifts and cash reconciliation, shop-floor inventory with
atomic transfers. Capabilities, location scope, fulfilment routing, reservations
and the pickup machinery. Specs: `docs/pos-plan.md`,
`docs/inventory-fulfilment-roadmap.md`.

### Refunds & cancellation ★ the unblocker

`refunds_01_gateway.sql`, `lib/payments/refunds.ts` (pure, tested),
`refund-actions.ts`, `refund-reconcile.ts` (reconcile-on-read + cron sweep),
`lib/orders/cancel.ts` (ONE implementation shared by both callers),
`cancelMyOrder`.

- **Idempotency: insert the `order_refunds` row FIRST**, `pending`, carrying our
  own key — you cannot key on a gateway id you don't have yet, and a timeout is
  indistinguishable from a failure.
- **Reconcile-on-read, not webhooks** (§18, unchanged).
- **A refund does NOT imply a restock.** A returned item may be damaged.
- **Auto-refund on cancel: originally NO**, on the grounds that money leaving
  with no human looking at it is the §22 owner-only-discounts argument again.
  **Step 2 narrows this** to customer self-cancel of prepaid orders, default
  OFF — the reasoning still stands everywhere else.
- **COD is not a dead button:** the merchant picks per refund from {store
  credit, manual transfer (recorded), cash at counter}. RazorpayX drops in later
  as one more `method`, no schema change.

### Returns, exchanges, BORIS, credit notes

Spec: `docs/returns-exchanges-plan.md`. The twelve `returns.*` settings,
`products.returnable` + `return_window_days`, reason-driven fees, eligibility,
the customer request flow, the dashboard review queue, exchanges (a return plus
a new order, never a third entity), BORIS at the counter, and GST credit notes
with a trigger-allocated serial issued on settlement.

**Deliberately deferred:** photo upload, per-line damaged marking at receipt,
advance exchanges, cross-product swaps, and enforcing the return window at the
till (invariant 1 — the merchant is standing right there).

### Store credit

Balance + append-only ledger, issued from a refund, spent at checkout, reinstated
on cancel. `orders.total` stays the goods value — credit is a payment, not a
discount — and the unpayable-remainder gap below the gateway minimum is handled.

### Metered extra-location billing _(POS 7)_

**★ An extra location is a PRICE RISE ON THE SAME SUBSCRIPTION, not a second
one.** `razorpay_plans` is keyed on (plan, period, amount), so a different
location count resolves to a different cached plan id with no new table;
`planForRzpPlan` still maps it back to (tier, period) for the webhook; and
`decidePlanChange`'s buy-now / release-at-cycle-end rule applies unaltered,
keeping refunds out of the system. Priced from the operator console
(`plan_prices`, key `extra_location`).

Traps, each already paid for: `changePlan` must carry the count through or the
merchant silently drops to the bare plan price while keeping every shop; the
count is absolute, never a delta; it is written only when the change is live; the
mandate ceiling is checked before the gateway; and it is refused, not clamped, in
both directions.

---

## Invariants — every step obeys these

They are the ones already paid for in bugs.

1. **A migration may not change what a live store does.** Backfill what already
   happens as ON; backfill new behaviour as OFF. Creation defaults and backfill
   values are different questions.
2. **Nothing cached is authoritative.** The server re-prices and re-reserves.
3. **Exactly-once is a conditional claim**, never an app-level check-then-act.
4. **Cross-location writes are one RPC**, because there is no cross-statement
   transaction over the pool.
5. **A disabled control is not a permission.** Re-enforce server-side.
6. **Never refuse a sale over an optional feature.** Routing and pickup both
   fail open.
7. **Every action emits an event.** The coverage guard fails the build otherwise
   — but note it only asserts a key is emitted _somewhere_, not that every path
   which should emit it does.
8. **Absence is not restriction.** An admin bound to no location sees everything.

---

## Decisions

**Settled**

- **Partial cancellation: NO** (owner, 2026-08-09). A customer cannot cancel
  part of a mixed order; an order is cancellable only if every line is.
- **Auto-refund fires on a CUSTOMER cancel only** (owner, 2026-08-09). A
  merchant cancelling from the dashboard still gets the refund button to click,
  because they may want to offer store credit, deduct something, or hold a
  suspicious order — an automatic payout takes that choice away at exactly the
  moment it matters.
- **Auto-refund is OFF by default** (owner, 2026-08-09), a switch each merchant
  turns on. Consistent with every other new behaviour here: nothing changes for
  an existing store until they ask for it.

**Open — the owner's to settle before the step they affect starts**

- **Step 3 pickup capability split.** Making "mark ready" manager-only changes
  current behaviour, which is safe only because pickup has no live users. If any
  store has already enabled `fulfilment.offerPickup`, the capability must default
  open instead.
