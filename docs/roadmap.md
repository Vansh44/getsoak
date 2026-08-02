# Roadmap — POS, locations & fulfilment

**The single ordered plan.** What ships next, in what order, and why that order.

Three design docs feed this one and stay authoritative for HOW each piece works —
`docs/pos-plan.md` (register, staff, devices, shifts),
`docs/inventory-fulfilment-roadmap.md` (locations, routing, reservations) and
`docs/returns-exchanges-plan.md` (returns, exchanges, refunds — Steps 2–4). The
first two each carried their own phase list, which is how "POS Phase 5" and
"Locations Phase G" ended up being the same work described twice. **This file is
the sequence; those are the specifications.**

- **Acceptance tests:** `docs/pos-acceptance.md`
- **Architecture:** `CODEBASE.md` §22 (POS), §23 (locations), §24 (notifications)

> **Keep this current.** Any commit that finishes, splits or reorders a step
> updates the table below in the same commit — the same rule `CODEBASE.md`
> already carries. A roadmap nobody trusts is worse than none, because it gets
> read once and then quietly ignored.

---

## Status at a glance

| #      | Step                                                                | State   |
| ------ | ------------------------------------------------------------------- | ------- |
| —      | POS 0: locations, per-location inventory, plan gate                 | ✅ done |
| —      | POS 1: `/pos` shell, staff accounts, device authorization           | ✅ done |
| —      | POS 2: the register, GST, thermal receipt, catalog cache            | ✅ done |
| —      | POS 3: shifts & cash reconciliation                                 | ✅ done |
| —      | POS 4: inventory from the shop floor, transfers                     | ✅ done |
| —      | LOC A–C: capabilities, Locations section, scope, inventory selector | ✅ done |
| —      | LOC D–F: routing, reservations, pickup, searchable store picker     | ✅ done |
| **1**  | **Finish pickup + close the gaps**                                  | ⏭ next |
| **2**  | **Refunds & cancellation** — the money-out path                     | ✅ done |
| **3**  | Returns & **exchanges** — in-store ✅ done; the rest waits on 2     | ◐ part  |
| **4**  | Store credit & gift cards                                           | ⏳      |
| **5**  | Metered extra-location billing (POS 7)                              | ⏳      |
| **6**  | Channel stock policy (LOC H)                                        | ⏳      |
| **7**  | Transfer lifecycle (LOC I)                                          | ⏳      |
| **8**  | More routing strategies (LOC J)                                     | ⏳      |
| **9**  | WhatsApp/SMS receipts (POS 6)                                       | ⏳      |
| **10** | Offline outbox (POS 9)                                              | ⏳      |
| **11** | Full omnichannel (POS 8 = LOC K)                                    | ⏳      |

---

## Step 1 — Finish pickup, and close the open gaps

Pickup's own unfinished edges. Phases A–F built the machinery and the shopper's
side of it; what's left is everywhere ELSE a collection order shows up.

**Done so far:** location address fields, the ALDO-style Ship/Pickup toggle and
searchable store picker (merchant-typed postcode serviceability was built as
F.1 and then **removed** — the shopper knows where they are and the merchant
cannot), the billing address, pay-at-store, the configurable ready-by date, and
real copy for the four pickup emails.

**Still open:**

1. **Pickup on the success page.** Right after paying is when someone most
   wants the address and the date; it shows only the order reference.
2. **Pickup in the dashboard.** The orders list and detail drawer have zero
   pickup awareness, so office staff can't see that an order is a collection
   or what state it's in. Only the till can. **The biggest of these** — it is
   the merchant's own view of their orders.
3. **The invoice knows it was collected.** `invoice-data.ts` and
   `InvoiceDocument` don't read `fulfilment_type`, so an invoice prints a
   shipping address for an order nobody shipped.
4. **Tests for `pos-pickup-actions.ts`.** Every other POS action has a
   co-located test; this one shipped without.
5. **Run PS-8.1 – PS-8.20 in a browser.** The pickup flow has never been
   exercised end to end. Nothing blocks it now.
6. **Location filter on analytics.** The one item unrelated to pickup.

**Done when:** the acceptance doc's Known gaps table loses those rows, and its
section 8 has been run for real.

---

## Step 2 — Refunds & cancellation ✅ DONE ★ the unblocker

**Money now moves both ways, and it never moves on its own.** Implementation
notes: `docs/returns-exchanges-plan.md` §9 (refunds) and §10 (cancellation).
The three features that were waiting on this are unblocked.

**✅ Shipped:** `supabase/refunds_01_gateway.sql`, `rzpRefund` +
`rzpFetchPaymentRefunds`, `lib/payments/refunds.ts` (pure, tested),
`app/actions/refund-actions.ts`, `lib/payments/refund-reconcile.ts`
(reconcile-on-read + a cron sweep), `orders.delivered_at`, the refund panel in
the order drawer, `lib/orders/cancel.ts` (ONE implementation of the cancel
side-effects, shared by both callers), `cancelMyOrder` + the storefront button,
and the two `orders.*` settings.

**★ `PENDING` in `lib/notifications/coverage.test.ts` is now EMPTY** — every
registry event has a real emitter. `order.cancellation_requested` was the last
entry, and it fires when a shopper asks to cancel an order that has moved too
far to stop.

**Shipped (detail)**

- `rzpRefund` + `rzpFetchRefund` in `lib/payments/razorpay.ts` (plain fetch,
  the existing pattern, pure helpers tested).
- ~~A **`refunds` table**~~ — `pos_12_returns.sql` already shipped
  `order_refunds`, precisely so this step needed no new table. It took only
  additive columns, in their own file (`refunds_01_gateway.sql`) per §15b's
  never-edit-an-applied-migration rule.
- `refundOrder` — partial from day one, claiming its state transition
  conditionally like every other exactly-once path here.
- **Reconcile-on-read, not webhooks** — the §18 decision, unchanged. A refund
  can lag; asking Razorpay when someone looks is cheaper than a webhook
  endpoint to secure.
- `order.refund_issued` is emitted by the dashboard path as well as the till.
  It was never in `PENDING` — `order.cancellation_requested` is, and stays
  there until the cancellation half of this step lands.

**Decisions — made, in `docs/returns-exchanges-plan.md` §3**

- **Auto-refund on cancel: NO**, and not as a setting either. Cancel _prompts_
  to refund, pre-filled, one click. Money leaving with no human looking at it is
  the same argument §22 makes for owner-only discounts.
- **Pickup expiry: same** — it prompts, it does not pay out on a schedule.
- **COD: not a dead button.** The merchant picks per refund from {store credit,
  manual transfer (recorded), cash at counter}. No automated payout in v1 —
  RazorpayX is a separate product most COD merchants don't have, and it drops in
  later as one more `method` with no schema change. This is Shopify parity: on a
  manual-payment order Shopify records the refund and the money moves offline.
- **Idempotency: insert the `order_refunds` row FIRST**, `pending`, carrying our
  own unique key — you cannot key on a gateway id you don't have yet, and a
  timeout is indistinguishable from a failure. Reconcile-on-read resolves the
  unknowns.

**Watch for**

- A refund must never exceed what was captured, and never double-refund. The
  gateway id makes the RECORD idempotent, but it cannot make the CALL
  idempotent — you don't have the id until the call returns, and a timeout
  looks exactly like a failure. Hence the pending-row-first design above.
- A refund does **not** imply a restock. A returned item may be damaged — that's
  Step 3's decision, and conflating them here would pre-empt it.

---

## Step 3 — Returns _(POS 5 = LOC G)_ — spec: `docs/returns-exchanges-plan.md`

**In-store returns of in-store sales are DONE** (`pos_12_returns.sql`,
`lib/pos/returns.ts`, `/pos/returns`). What remains is everything the customer
and the merchant's own dashboard touch, plus **exchanges**, which the design doc
adds to this step: an exchange is a return plus a new order, not a third entity.

**✅ Also done** (returns-plan Step 2, see its §11): the twelve `returns.*`
settings, `products.returnable` + `return_window_days`, `lib/returns/reasons.ts`
(reason-driven fees) and `lib/returns/eligibility.ts`, the product-editor policy
card, and Final-sale badges on both PDP layouts.

**✅ Also done** (returns-plan Step 3, see its §12): the customer request flow
on `/orders/[id]`, the dashboard review queue at `/dashboard/orders/returns`,
approve/reject with a mandatory decline reason, and receive-and-restock.

**✅ Also done** (returns-plan Step 4, see its §13): exchanges — per-line swap
targets, replacement stock held from the moment it's requested, and the
replacement order raised at receipt.

**Still ships:** return-in-store for ONLINE orders (BORIS) at locations
carrying the `returns` capability — which is in the registry today and read by
nothing. Plus photo upload, per-line damaged marking, and advance exchanges,
all deliberately deferred.

**Three gaps in the existing code this step closes:** `getReturnableSale`
filters on `orders.location_id = operator's location`, so it can never find an
online order; `orders` has no `delivered_at`, so a window measured from
`created_at` can expire before the parcel lands; `products` has no returnability
flag.

**Introduces the first extra inventory bucket, `damaged`** — added here because
this is the first workflow that moves stock into it, not before.

**Where the returned stock lands** (this location / transfer back / hold for
inspection) is merchant config, per the original spec.

**Watch for:** a return at a location that didn't sell it. The money is the
store's, the stock is that shop's — those are two different questions and the
schema has to keep them apart.

---

## Step 4 — Store credit & gift cards

Store credit is the natural refund alternative once Step 3 exists, and the
cheaper one for the merchant. Gift cards share the ledger shape.

★ **Two things now pull this earlier than its number suggests** — a COD refund
has no instrument to go back to, and an exchange settles cleanest as a credit
that the replacement order consumes. See `docs/returns-exchanges-plan.md` §3.3
and §4.1. It is still ordered after returns, because a credit with nothing to
issue it is a balance nobody can earn.

**Watch for:** a balance is money. Append-only ledger, atomic spend via a
conditional UPDATE — the `ai_credit_ledger` pattern, which already solves this
exact problem in this codebase.

---

## Step 5 — Metered extra-location billing _(POS 7)_

₹1,000/mo beyond the 2 included. Currently `PLAN_LIMITS.posLocationsIncluded`
hard-gates at 2, so a merchant who wants a third **cannot buy one** — this is
revenue sitting behind a check.

**Ships:** metered subscription line on the existing Razorpay autopay mandate,
a location count that bills, and soft-on-downgrade behaviour (never delete a
location; block creating new ones).

---

## Step 6 — Channel stock policy _(LOC H)_

Per-location, per-channel reserve buffers: "never sell the last 2 online at this
shop", so the shelf can't be emptied by the website mid-afternoon.

Rests on Phase E reservations, which is why it comes after them and not before.

---

## Step 7 — Transfer lifecycle _(LOC I)_

Today a transfer is instantaneous — one atomic RPC, both legs or neither. Real
stock spends days on a van. **Ships:** an in-transit state, so units belong to
neither shop's sellable count while they're moving.

**★ The guard changes here.** `transfer_stock` currently checks `on_hand >= qty`
plus reserved. Once stock can be in transit, that has to become
`on_hand − reserved − in_transit`, or a transfer will ship units already
promised to someone.

---

## Step 8 — More routing strategies _(LOC J)_

`nearest`, `most_stock`, `cheapest`. Each is a file that registers itself in
`lib/fulfilment/strategies.ts`; checkout never learns their names. `nearest`
needs the location addresses from Step 1 plus geocoding.

**This is also where pickup radius belongs** — the lat/lng answer deliberately
skipped in F.1 because it would put a geocoding call on the checkout render
path. Solve it once, for both.

---

## Step 9 — WhatsApp/SMS receipts _(POS 6)_

Twilio behind the existing channel abstraction in
`lib/notifications/channels.ts`, where `sms` and `whatsapp` are already declared
and LOCKED pending a provider. Unlocking them is the work.

---

## Step 10 — Offline outbox _(POS 9)_

Sell with no network: queue sales locally, reconcile on reconnect.

**Deliberately last.** It breaks the one invariant everything else rests on —
the server re-prices and re-reserves, so nothing cached is ever authoritative.
An offline sale is authoritative by definition, so this needs conflict rules
(what happens when two tills sold the same last unit) that only make sense once
returns and refunds exist to unwind the loser.

---

## Step 11 — Full omnichannel _(POS 8 = LOC K)_

Ship-from-store, endless aisle, inter-state IGST across locations, and unified
customer history spanning till and website.

---

## Invariants — every step obeys these

They're the ones already paid for in bugs. Restated because Steps 2–4 all touch
money and stock together, which is exactly where they get broken.

1. **A migration may not change what a live store does.** Backfill what already
   happens as ON; backfill new behaviour as OFF. Creation defaults and backfill
   values are different questions.
2. **Nothing cached is authoritative.** The server re-prices and re-reserves.
3. **Exactly-once is a conditional claim**, never an app-level check-then-act.
4. **Cross-location writes are one RPC**, because there is no cross-statement
   transaction over the pool.
5. **A disabled control is not a permission.** Re-enforce server-side.
6. **Never refuse a sale over an optional feature.** Routing and pickup both
   fail open — no rules, no eligible location, or a failed query all fall back
   rather than stopping a checkout.
7. **Every action emits an event.** The coverage guard fails the build
   otherwise — but note it only asserts a key is emitted _somewhere_, not that
   every path which should emit it does.
8. **Absence is not restriction.** An admin bound to no location sees
   everything.
