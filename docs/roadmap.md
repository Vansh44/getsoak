# Roadmap — POS, locations & fulfilment

**The single ordered plan.** What ships next, in what order, and why that order.

Two design docs feed this one and stay authoritative for HOW each piece works —
`docs/pos-plan.md` (register, staff, devices, shifts) and
`docs/inventory-fulfilment-roadmap.md` (locations, routing, reservations). They
each carried their own phase list, which is how "POS Phase 5" and "Locations
Phase G" ended up being the same work described twice. **This file is the
sequence; those are the specifications.**

- **Acceptance tests:** `docs/pos-acceptance.md`
- **Architecture:** `CODEBASE.md` §22 (POS), §23 (locations), §24 (notifications)

> **Keep this current.** Any commit that finishes, splits or reorders a step
> updates the table below in the same commit — the same rule `CODEBASE.md`
> already carries. A roadmap nobody trusts is worse than none, because it gets
> read once and then quietly ignored.

---

## Status at a glance

| #      | Step                                                                | State          |
| ------ | ------------------------------------------------------------------- | -------------- |
| —      | POS 0: locations, per-location inventory, plan gate                 | ✅ done        |
| —      | POS 1: `/pos` shell, staff accounts, device authorization           | ✅ done        |
| —      | POS 2: the register, GST, thermal receipt, catalog cache            | ✅ done        |
| —      | POS 3: shifts & cash reconciliation                                 | ✅ done        |
| —      | POS 4: inventory from the shop floor, transfers                     | ✅ done        |
| —      | LOC A–C: capabilities, Locations section, scope, inventory selector | ✅ done        |
| —      | LOC D–F.1: routing, reservations, pickup, postcode serviceability   | ✅ done        |
| **1**  | **Finish pickup + close the gaps**                                  | ⏭ next        |
| **2**  | **Refunds & cancellation** — the money-out path                     | ⏭ blocks 3, 4 |
| **3**  | Returns (POS 5 = LOC G)                                             | ⏳             |
| **4**  | Store credit & gift cards                                           | ⏳             |
| **5**  | Metered extra-location billing (POS 7)                              | ⏳             |
| **6**  | Channel stock policy (LOC H)                                        | ⏳             |
| **7**  | Transfer lifecycle (LOC I)                                          | ⏳             |
| **8**  | More routing strategies (LOC J)                                     | ⏳             |
| **9**  | WhatsApp/SMS receipts (POS 6)                                       | ⏳             |
| **10** | Offline outbox (POS 9)                                              | ⏳             |
| **11** | Full omnichannel (POS 8 = LOC K)                                    | ⏳             |

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
section 8 has been run for real.

---

## Step 2 — Refunds & cancellation ★ the unblocker

**Money only moves one way today.** A Razorpay order cancelled from the
dashboard returns the stock, notifies the customer, and leaves the payment
sitting there until the merchant remembers to refund it by hand in their own
Razorpay dashboard. `order.refund_issued` has been registered in the events file
and PENDING in the coverage guard since the notification spine was built.

**Three separate features are already waiting on this**, which is the signal to
build the capability rather than the features:

- pickup expiry currently cancels **without** refunding (shipped that way,
  deliberately);
- returns needs "refund to the original tender" before it can start;
- the locked order-cancellation decisions include **automatic** Razorpay
  refunds.

**Ships**

- `rzpRefund` + `rzpFetchRefund` in `lib/payments/razorpay.ts` (plain fetch,
  the existing pattern, pure helpers tested).
- A **`refunds` table**: order, amount, tender, gateway refund id, actor,
  reason, status. A refund with no record is indistinguishable from a bug, and
  this is the row a merchant will be asked about months later.
- `refundOrder` — idempotent on the gateway refund id, partial-ready from day
  one (schema takes a per-line amount even if v1 only refunds wholes), claiming
  its state transition conditionally like every other exactly-once path here.
- **Reconcile-on-read, not webhooks** — the §18 decision, unchanged. A refund
  can lag; asking Razorpay when someone looks is cheaper than a webhook
  endpoint to secure.
- Customer-initiated cancellation, within a merchant-configurable window.
- Emit `order.refund_issued`; drop it from `PENDING`.

**Decisions to make before starting**

- Auto-refund on cancel, or refund as a separate merchant action? _(The locked
  note says auto — worth re-confirming, since auto means money leaves without a
  human looking at it.)_
- Does pickup expiry now auto-refund? _(My instinct: yes once this exists —
  that's why it was deferred rather than declined.)_
- COD orders: nothing to refund. Confirm the UI says so rather than offering a
  dead button.

**Watch for**

- A refund must never exceed what was captured, and never double-refund.
  Idempotency on the gateway id, not on our own state.
- A refund does **not** imply a restock. A returned item may be damaged — that's
  Step 3's decision, and conflating them here would pre-empt it.

---

## Step 3 — Returns _(POS 5 = LOC G)_

**Ships:** `processReturn` (full and partial), refund to the original tender via
Step 2, and a **restock decision per line** — sellable or damaged.
`/pos/returns` at the till, plus return-in-store for online orders at locations
carrying the `returns` capability.

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
6. **Never refuse a sale over an optional feature.** Routing, pickup and
   postcodes all fail open.
7. **Every action emits an event.** The coverage guard fails the build
   otherwise — but note it only asserts a key is emitted _somewhere_, not that
   every path which should emit it does.
8. **Absence is not restriction.** An admin bound to no location sees
   everything.
