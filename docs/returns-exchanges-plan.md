# Returns, exchanges & refunds — the design

**Status:** ✅ **all seven steps built** — §9 (refunds), §10 (cancellation),
§11 (returns config), §12 (the request flow), §13 (exchanges), §14 (BORIS),
§15 (credit notes), §16 (store credit).
**Slots into:** `docs/roadmap.md` Steps 2 (refunds), 3 (returns), 4 (store credit).
**Depends on:** `CODEBASE.md` §12 (checkout), §17 (tax/invoices), §18 (Razorpay),
§22 (POS), §23 (locations), §24 (notifications), §25 (policies).

This doc answers three questions and makes the decisions the roadmap left open.

---

## 1. What already exists (do not rebuild it)

`pos_12_returns.sql` is **applied**. In-store returns of in-store sales work.

| Piece                                                    | State                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `order_returns` + `order_return_items` + `order_refunds` | ✅ tables, RLS (admin read, service-role write), `gateway_refund_id` UNIQUE                     |
| `lib/pos/returns.ts` — `refundBreakdown`                 | ✅ pure, tested, and already solves the order-discount re-allocation trap                       |
| `app/actions/pos-return-actions.ts` + `/pos/pickups`     | ✅ full/partial, per-line `sellable`/`damaged`, restock, cash out of the drawer, shift-stamped  |
| `returns` location capability (`requires: pos`, Pro)     | ✅ registry + UI, but **nothing reads it yet** — it was added for this work                     |
| `order.refund_issued` notification event                 | ✅ registered AND emitted — by `processReturn` (the till) and now `refundOrder` (the dashboard) |
| **Gateway refunds** (roadmap Step 2 / build order §7.1)  | ✅ **built** — see §9                                                                           |
| **Any customer-facing return request**                   | ❌ `/orders/[id]` has no return UI                                                              |
| **Any merchant return settings**                         | ❌ nothing in `lib/settings/registry.ts`                                                        |
| **Exchanges**                                            | ❌ the word does not appear anywhere in the repo                                                |

Three gaps in the existing code this work must close:

- **`getReturnableSale` filters on `eq(orders.locationId, op.locationId)`.** An
  online order's `location_id` is its _fulfilment_ location or null, so BORIS
  finds nothing. The lookup has to become store-scoped, with the
  location used for the _stock_ decision only.
- **`orders` has no `delivered_at`.** A return window measured from `created_at`
  can expire before the parcel lands. ★ Blocking for any window at all.
- **`products` has no returnability flag**, and there is no return-reason enum.

---

## 2. Decision 1 — what the merchant configures

### 2.1 The registry only holds `boolean | number`

`SettingDef.type` is `"boolean" | "number"`. That is not a limitation to route
around — it is the reason each of the following lands where it does.

| Question                     | Where it lives                     | Why                                                                                                                                               |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| May this store take returns? | setting `returns.enabled`          | one boolean, store-wide                                                                                                                           |
| How long?                    | setting `returns.windowDays`       | one number                                                                                                                                        |
| Fee?                         | settings (percent + flat)          | numbers                                                                                                                                           |
| **Which products?**          | **`products.returnable` column**   | per-row data, exactly like `tax_class_id` — a setting cannot address one SKU                                                                      |
| **Where does the money go?** | **per-refund choice, from a menu** | it is a decision per refund, not a store constant (§3)                                                                                            |
| **Why is it coming back?**   | **`RETURN_REASONS` enum in code**  | a fixed list the platform owns, like `USP_ICONS` — merchant-editable reasons make analytics meaningless across stores and break the who-pays rule |
| Return policy prose          | `store_pages` slug `refund-policy` | already built (§25) — the footer already links it                                                                                                 |

### 2.2 The settings

Group **Returns**, section `orders` (a return is an order operation; it needs no
new permission key, and every merchant who can refund can already edit orders).

| Key                                | Type    | Default | Notes                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `returns.enabled`                  | boolean | `false` | ★ **backfills OFF.** Invariant 1: a migration may not change what a live store does, and a store that has never taken a return must not wake up advertising one. New stores get it ON at signup — a creation default and a backfill are different questions. |
| `returns.windowDays`               | number  | `7`     | 0–365. From **delivery**, not order date. `0` = same-day only.                                                                                                                                                                                               |
| `returns.selfServe`                | boolean | `true`  | Customer can open a request from `/orders/[id]`. Off ⇒ they must contact the merchant, and the whole storefront flow hides.                                                                                                                                  |
| `returns.autoApprove`              | boolean | `false` | On ⇒ a request inside the window on a returnable product goes straight to `approved`. Off ⇒ a human decides.                                                                                                                                                 |
| `returns.allowExchanges`           | boolean | `true`  | Exchanges are cheaper for the merchant than refunds. On by default deliberately.                                                                                                                                                                             |
| `returns.restockingFeePercent`     | number  | `0`     | 0–50. Percent of the returned goods value. **Never applied to a defect** (§2.4).                                                                                                                                                                             |
| `returns.returnShippingFee`        | number  | `0`     | Flat ₹ deducted when the customer ships it back. Same defect exemption.                                                                                                                                                                                      |
| `returns.requireReason`            | boolean | `true`  | Off ⇒ reason optional. It drives the fee rule, so on by default.                                                                                                                                                                                             |
| `returns.requirePhotoForDamage`    | boolean | `true`  | `dependsOn: returns.requireReason`. GCS upload already exists.                                                                                                                                                                                               |
| `returns.allowInStore`             | boolean | `false` | BORIS master switch. Pro (`minPlan: "pro"`) because it needs POS. Per-location still gated by the `returns` capability.                                                                                                                                      |
| `returns.ownerOnlyRefunds`         | boolean | `false` | The §22 discount rule, weaker on purpose (§6.3).                                                                                                                                                                                                             |
| `returns.maxRefundWithoutApproval` | number  | `0`     | `0` = no cap. Above it, a manager's signed grant (`lib/pos/approval.ts`).                                                                                                                                                                                    |

**Not settings, deliberately:**

- _"Refund to store credit only."_ A merchant switch that forces credit for a
  defective item is a switch that creates consumer-protection exposure for
  them. Store credit is **offered** (§3.3), never imposed.
- _"Auto-refund on cancel."_ The roadmap asks whether cancelling should refund
  automatically. **No — and not as a setting either.** Money leaving without a
  human looking at it is the one irreversible act in this system with no
  physical trace, which is the same argument §22 makes for owner-only
  discounts. Cancel _prompts_ to refund, pre-filled, one click. That is not
  friction worth removing.

### 2.3 Per-product returnability

```sql
-- returns_01_product_policy.sql
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS returnable boolean NOT NULL DEFAULT true;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS return_window_days integer;  -- NULL = use the store's
```

`true` by default because most things are returnable and a backfill of `false`
would silently make every existing catalogue final-sale. The product editor
gets a **Returns** card next to the existing Tax class card: a "Final sale — no
returns" checkbox and an optional per-product window override. That covers
perishables, personalised items, and clearance without a second table.

> **Why not a `return_profiles` table**, mirroring `tax_classes`? Because tax
> classes exist since rates vary per product _by law_ and a merchant must be
> able to name the buckets. Return rules almost never vary by more than
> "returnable or not, and for how long". Build the table when a merchant asks
> for the third axis — not before. The upgrade path is a nullable
> `products.return_profile_id`, which is additive.

### 2.4 The reason drives the fee — this is the rule worth encoding

`lib/returns/reasons.ts` (pure):

| Reason             | Merchant's fault | Fees apply | Who pays return shipping |
| ------------------ | ---------------- | ---------- | ------------------------ |
| `damaged`          | yes              | **no**     | merchant                 |
| `defective`        | yes              | **no**     | merchant                 |
| `wrong_item`       | yes              | **no**     | merchant                 |
| `not_as_described` | yes              | **no**     | merchant                 |
| `changed_mind`     | no               | yes        | customer                 |
| `size_fit`         | no               | yes        | customer                 |
| `arrived_late`     | yes              | **no**     | merchant                 |
| `other`            | no               | yes        | customer                 |

A flat "10% restocking fee on everything" charges a customer for the merchant's
own mistake. Every serious retailer distinguishes these, and encoding it means
the merchant sets one number and the right thing happens. `merchantFault` is one
boolean on the reason def; `feesFor(reason, settings)` is the only reader.

★ **A customer-selected reason is a claim, not a fact.** With `autoApprove` on,
"defective" waives the fee with nobody looking — which is a free-shipping
exploit. So `autoApprove` **only auto-approves no-fault-waiving reasons**;
anything claiming merchant fault goes to a human regardless. That is not a
setting, it is what makes auto-approve safe to offer at all.

---

## 3. Decision 2 — where the money goes

### 3.1 The rule, before the options

> **The tender that paid decides where the refund goes. It is not a preference,
> and the merchant does not get to override it downward.**

This is not tidiness. Refunding cash for a card sale is the classic
card-not-present laundering path: buy online with a stolen card, return in store,
walk out with clean cash. It is also, for card payments, what the networks and
RBI require. A UI that lets a cashier pick "cash" for an online card order is a
UI that will be used that way.

### 3.2 Online (Razorpay) — refund to source

Roadmap Step 2. `POST /v1/payments/:id/refund` with the **store's own** decrypted
credentials (§18 — the platform never touches order funds, so it cannot refund
them either).

**The idempotency design is the whole thing.** The roadmap says "idempotency on
the gateway id, not on our own state", which is right about the record and
incomplete about the call: you cannot key on an id you do not have yet. A
network timeout on the refund call is indistinguishable from a failure, and
retrying it refunds twice.

So, in order:

1. **INSERT `order_refunds` first**, `status: 'pending'`, carrying our own
   `idempotency_key` (uuid) under a UNIQUE index. The row exists before any
   money is asked to move.
2. **Call Razorpay** with that key in `X-Refund-Idempotency`, so a retry
   of the same key returns the same refund rather than making a second one.
   Razorpay requires at least 10 characters and permits only letters, numbers,
   hyphens and underscores; StoreMink validates that before making the call.
3. **On a known outcome**, claim `pending → completed|failed` conditionally,
   writing `gateway_refund_id`. On an **unknown** outcome (timeout, 5xx) leave
   it `pending` and return "we're checking" — never retry inline.
4. **Reconcile on read**, the §18 decision unchanged: when anyone opens the
   order, `rzpFetchPaymentRefunds(payment_id)` and match by amount + our key.
   No webhook endpoint to secure. The pickup-expiry cron gets a second job
   sweeping `pending` refunds older than 15 minutes.

Hard invariants, each a conditional claim rather than a check-then-act:

- `Σ completed refunds ≤ captured amount`, enforced in the same UPDATE that
  claims the transition, not in a prior SELECT.
- A refund never exceeds what `refundBreakdown` says those lines were worth.
- `order_refunds.shift_id` is **NULL** for gateway refunds. It never touches a
  drawer, and the shift report must not count it (`pos_12` already indexes
  `WHERE shift_id IS NOT NULL`, so this is free).

### 3.3 COD — the options, and the decision

Nothing was captured. There is no instrument to send money back to.

| Option                                       | Verdict                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Automated bank/UPI payout (RazorpayX)** | ❌ **not v1.** Separate product, separate KYC — most COD-heavy Indian D2C merchants do not have it, so it is a path 90% of stores could not use. It also means holding customer bank details, which is a phishing target and a data-protection surface this platform does not otherwise have. |
| **B. Store credit**                          | ✅ **offered, never forced.** No money movement, no bank details, instant, entirely under our control — and it is what makes exchanges work without a gateway. But it is _not a refund_, and imposing it for a defective product is where merchants get into trouble.                         |
| **C. Manual, recorded**                      | ✅ **the default.** The merchant pays them however they already do — UPI from their own phone, bank transfer — and records the reference. Low-tech, and it is what actually happens today.                                                                                                    |
| **D. Cash at the counter**                   | ✅ for in-store returns. They paid cash; they get cash. Already built for POS sales.                                                                                                                                                                                                          |
| **E. "Reverse" gateway push to a card**      | ❌ does not exist. You cannot refund a payment that was never made.                                                                                                                                                                                                                           |

> **Decision: no automated COD payout in v1. The merchant picks per refund from
> `{store credit, manual transfer (recorded), cash at counter}`, and the
> customer is asked which they want when they open the request.**

**Shopify parity check:** on a manual-payment order Shopify records the refund
and tells the merchant to move the money themselves — Option C _is_ the parity
baseline. Store credit is the newer addition. So this matches Shopify and adds
its best recent feature; it does not fall short of it anywhere.

★ **Two COD-specific traps to surface in the UI, not solve:**

- **The money may not have arrived yet.** COD cash sits with the courier for
  days or weeks. Refunding a COD order can mean paying out money the merchant
  has not been remitted. This is why nothing about COD is ever automatic, and
  why the refund panel shows "collected on delivery — confirm you've received
  this remittance" rather than a bare Refund button.
- **A "manual" refund is the merchant's word.** The reference field is not
  optional decoration; it is the only evidence the row will ever carry.

`RazorpayX` slots in later as one more `method`, appearing only when the
merchant has connected it — the §18 BYO pattern, no schema change. That is the
whole reason `order_refunds.method` is free text rather than a CHECK.

### 3.4 The refund matrix

| Order paid by | Returned where | Money goes                                     | Touches a drawer |
| ------------- | -------------- | ---------------------------------------------- | ---------------- |
| Razorpay      | online request | gateway → original instrument                  | no               |
| Razorpay      | **in store**   | gateway → original instrument (**never cash**) | no               |
| COD           | online request | store credit \| manual transfer                | no               |
| COD           | **in store**   | cash from the drawer \| store credit           | **yes**          |
| POS cash      | in store       | cash from the drawer                           | **yes**          |
| POS card/UPI  | in store       | the shop's own terminal, recorded              | no               |
| Split (any)   | either         | proportionally, gateway portion first          | partly           |

---

## 4. Decision 3 — exchanges

### 4.1 An exchange is a return plus a new order

It is not a third entity. Shopify models it this way and the reason is
structural: a distinct `exchanges` table means every stock path, tax
calculation, report and invoice grows an "…or exchange" branch, forever.

```
order_returns.exchange_order_id uuid REFERENCES orders(id)
```

The returned value becomes an **exchange credit** that pays for the new order.
Three cases, one mechanism:

| Case                      | Settlement                                                        |
| ------------------------- | ----------------------------------------------------------------- |
| Even (M → L, same price)  | credit == new total. No money moves. **The 80% case.**            |
| Customer owes (upgrade)   | they pay the difference — Razorpay online, any tender at the till |
| Merchant owes (downgrade) | the balance refunds per §3, or becomes store credit               |

At the till this is literally what a shop does: take the return, ring the new
sale, settle the difference. `placePosSale` already exists and needs one new
tender type, `exchange_credit`, scoped to the transaction — no ledger, because
the credit is created and consumed in the same action.

Online it needs the request workflow, because the replacement cannot ship before
the merchant decides. Two sub-decisions:

- **Ship the replacement before the goods come back?** Setting-free: **no** in
  v1. "Advanced exchange" needs a card hold to be safe, and there is no hold
  primitive here. The merchant can always ship early manually.
- **Reserve the replacement's stock at request time?** **Yes** — `holdStock`
  from Phase E, exactly like pickup. Otherwise the size they exchanged for sells
  out while the parcel is in transit and the exchange fails at the last step.
  The hold expires with the request.

### 4.2 What an exchange must not do

- **Not re-apply the coupon.** The original order consumed a promotion; the
  replacement inherits the _price paid_, not the discount code.
- **Not re-run stock reservation twice.** Return restocks the old unit at the
  returning location; the new order reserves at its own fulfilment location.
  Two locations, two movements, both in the ledger.
- **Not silently change the tax.** The new line is taxed at _its_ class and
  _today's_ rate; the credit is what the old line was worth. If they differ, the
  difference is settled — it is not absorbed.

---

## 5. Decision 4 — return online orders in a physical store (BORIS)

The capability (`returns`, `requires: ["pos"]`, Pro) is already in the registry
and read by nothing. This is what reads it.

**Gates, all four:** store setting `returns.allowInStore` → the location's
`returns` capability (`locationCan`) → the operator's `refund` POS capability →
the order is in its return window on returnable products.

**Lookup.** The customer walks in with an order number or a phone, not a
receipt. `findOrderForReturn(query)` matches `order_ref`, phone or email,
**store-scoped and NOT location-scoped** — this is the specific line
`getReturnableSale` gets wrong today. It returns the order regardless of where
it was fulfilled.

**Then the two questions are answered separately, which is what `pos_12`'s
comment already anticipated:**

- **Whose shelf gains the stock?** The shop the customer walked into
  (`order_returns.location_id` = the operator's location). Already correct.
- **Whose money goes back?** The tender's, per §3.1. For an online card order
  that is the gateway — **no drawer, no shift row, no cash**. The till shows
  "₹840 will be returned to the card ending 4242 in 5–7 working days" and there
  is no cash option to click.

**COD order returned in store** is the one case where cash is right: they paid
cash to a courier, they get cash from the drawer, and it _is_ a shift-affecting
movement.

★ **The store credit escape hatch.** For a COD order at a shop whose drawer is
short, store credit settles instantly with no cash at all. This is the argument
for building store credit (roadmap Step 4) alongside returns rather than after
them.

---

## 6. Other cases (the "explore other cases as well" list)

### 6.1 The return window starts at delivery

`orders.delivered_at timestamptz` — set when `updateOrderStatus` moves a row to
`delivered`, backfilled to `updated_at` for existing delivered rows. Without it
a 7-day window on a 10-day delivery has expired before the parcel arrives.

Fallback chain, in order: `delivered_at` → `collected_at` (pickup, exists) →
`created_at` (POS sale — the customer walked out with it).

### 6.2 Cancellation is not a return

Before dispatch there are no goods to come back. Different rules, different
window, and `updateOrderStatus` already restocks. What is missing is the money —
and that is §3.2, which is exactly why the roadmap calls Step 2 "the unblocker".
`order.cancellation_requested` is the one key currently in the coverage guard's
`PENDING`; this work removes it.

### 6.3 Who may refund

A refund is "giving money away", so the §22 owner-only discount argument
applies — **but weaker, and it should be**: a refund leaves a physical trace,
because the goods come back and can be counted. A discount leaves nothing. So:

- **Default: any operator with the `refund` POS capability** (manager+, as now).
- `returns.ownerOnlyRefunds` tightens it to superadmin for merchants who want it.
- `returns.maxRefundWithoutApproval` requires a manager's **signed grant**
  above a threshold — reusing `lib/pos/approval.ts` unchanged, including its
  cart fingerprint. ★ A boolean from the browser is not an approval; that lesson
  is already paid for in §22 and must not be re-learned here.

### 6.4 Coupons are not restored

A full return does **not** call `decrement_coupon_usage`. The promotion was
consumed; restoring it enables buy-use-return-repeat. Shopify does not restore
either. And if a partial return drops the order under the coupon's minimum
order value, the discount is **not** clawed back — the customer met the
condition when they bought.

### 6.5 GST credit notes ★

Under Indian GST a refund against a tax invoice requires a **credit note** with
its own serial number, and it is a legal document, not a receipt. This is
cheap now and expensive to retrofit:

- `order_refunds.credit_note_no` + `credit_note_ref`, allocated by
  `next_credit_note_no(store)` — the `next_order_no` pattern exactly.
- `store_counters.credit_note_seq` ★ **as its own migration file.** §15b's rule
  in capitals: `identifiers_01_schema.sql` uses `CREATE TABLE IF NOT EXISTS`
  and has already run in prod, so editing it is a silent no-op and the column
  never arrives. `pos_12_returns.sql` has run too — every column added here is
  a new file.
- The credit note reuses `components/invoice/` with reversed signs and
  `splitGst` on the refunded tax, so CGST/SGST/IGST reverse the way they were
  charged.

**Not lawyer- or CA-reviewed**, same posture as §25. Flag it in the doc the
merchant reads.

### 6.6 Restocking fee and tax

A restocking fee is arguably a service the merchant supplied, which is a
different GST treatment from simply refunding less. v1 treats it as a
**reduction of the refund**, shown as its own line on the credit note so a
merchant's accountant can see and reclassify it. Flagged, not silently decided.

### 6.7 Smaller ones

- **Partial returns** — already in the schema, per-line quantity. Done.
- **Damaged units** don't restock — already built. The `damaged` inventory
  bucket stays deferred until a write-off workflow reads it (`pos_12`'s own
  reasoning, still right).
- **Serial returners** — the data exists once returns are recorded; a
  returns-per-customer figure is a later analytics widget, not a v1 block.
- **Return shipping labels** (Delhivery/Shiprocket) — out of scope. v1: the
  customer ships it back or walks into a shop.
- **Notifications** — five new keys, each needing a real emitter or the
  coverage guard fails the build: `order.return_requested` (team),
  `order.return_approved` / `order.return_rejected` (customer),
  `order.refund_issued` (both — **already registered, currently unemitted**),
  `order.exchange_ready`.
- **Non-returnable at checkout.** A final-sale line should say so in the cart
  and on the invoice, not surprise them afterwards.

---

## 7. Build order

Each step is shippable and leaves the tree green.

| #     | Step                                                                                                                  | Unblocks              |
| ----- | --------------------------------------------------------------------------------------------------------------------- | --------------------- |
| ~~1~~ | `rzpRefund`, `refundOrder` with the pending-row-first idempotency, reconcile sweep, `delivered_at` — ✅ **DONE (§9)** | everything            |
| **2** | Settings + `products.returnable` + `lib/returns/reasons.ts` + policy card in the product editor                       | 3, 4                  |
| **3** | Customer request flow: `/orders/[id]` → request, dashboard review queue, approve/reject, refund                       | —                     |
| **4** | Exchanges: `exchange_order_id`, held replacement stock, difference settlement                                         | —                     |
| **5** | BORIS: store-scoped lookup, tender-locked refund at the till, `returns` capability finally read                       | —                     |
| **6** | Credit notes + GST reversal                                                                                           | —                     |
| **7** | Store credit (roadmap Step 4) — the ledger the COD and exchange paths both want                                       | better COD, exchanges |

**Step 1 before anything else**, because every other step's money path dead-ends
without it — which is precisely what the roadmap already says.

---

## 8. Invariants this feature must not break

Restated from `docs/roadmap.md` because Steps 1–7 all touch money and stock at
once, which is where these get broken.

1. **A migration may not change what a live store does.** `returns.enabled`
   backfills OFF; `products.returnable` backfills `true` (that _is_ today's
   behaviour — nothing is final-sale now).
2. **Nothing cached is authoritative.** The refund is recomputed server-side
   from the stored order snapshot. The client says which lines and how many,
   never how much money — the rule `pos-return-actions.ts` already follows.
3. **Exactly-once is a conditional claim.** Every refund state transition, and
   the restock, and the request approval.
4. **Cross-location writes are one RPC.** A return that restocks at one shop
   while the money leaves elsewhere is two facts, not one write.
5. **A disabled control is not a permission.** The till hides cash for a card
   order; the server refuses it.
6. **Never refuse a sale over an optional feature.** A returns misconfiguration
   must never break checkout.
7. **Every action emits an event**, and the five keys above need real emitters.
8. **A refund is not a restock.** Damaged goods come back and never reach the
   shelf. `pos_12` already separates these; keep them separate.

---

## 9. Step 1 — what shipped

The money-out capability. A dashboard refund now moves real money and records
it; nothing else in this doc is built yet.

**Migration** `supabase/refunds_01_gateway.sql` — its own file, because
`pos_12_returns.sql` has already run and editing a
`CREATE TABLE IF NOT EXISTS` is a silent no-op (§15b). Adds
`order_refunds.idempotency_key` (UNIQUE), `.reason`, `.reference`, a partial
index for the sweep, and `orders.delivered_at` (backfilled from `updated_at`
for orders already delivered).

**`lib/payments/razorpay.ts`** — `rzpRefund` + `rzpFetchPaymentRefunds`.
`RzpResult`'s error arm gained **`outcome: "rejected" | "unknown"`**, which is
the distinction the whole design turns on: a 4xx is a verdict (nothing
happened), a 5xx or a network throw is not (the refund may exist). Every other
caller ignores it.

**`lib/payments/refunds.ts`** — pure, 21 tests. `refundableAmount` (★ counts
`pending` against the cap — excluding it lets a timed-out refund's money go out
twice), `checkRefundAmount`, `mapGatewayRefundStatus` (an unknown gateway state
maps to `pending`, never to settled), `matchGatewayRefund` (by our planted key,
never by amount — two ₹500 refunds on one order are indistinguishable by
amount).

**`app/actions/refund-actions.ts`** — `refundOrder` / `getOrderRefundState`.
The order of operations is the design and must not be "tidied":

1. `SELECT … FOR UPDATE` on the order, inside one `withService` transaction, so
   two admins clicking Refund serialise instead of both passing the cap;
2. insert the refund row `pending` with a key **we** generated;
3. call Razorpay with that key (header **and** `notes`);
4. claim `pending → completed|failed` conditionally;
5. ★ **an `unknown` outcome returns `pendingReconcile`, not an error** — the row
   stays pending and reconciliation finds out later.

**`lib/payments/refund-reconcile.ts`** — `reconcileOrderRefunds` (on read, when
anyone opens the order) and `sweepPendingRefunds` (the daily cron, wired into
`/api/cron/expire-pending-payments` on **both** return paths, since money out is
a different queue from money in). `syncOrderRefundState` derives
`orders.payment_status` from refunds that actually **settled**, so a failed
refund moves the order back off `refunded` rather than stranding it.
A row whose refund Razorpay has never heard of is only failed after ~30
minutes — failing it sooner would free the amount for a second payout of money
possibly already on its way.

**`app/actions/order-actions.ts`** — `delivered_at` stamped via
`coalesce(delivered_at, now())`, so re-marking an order delivered cannot restart
the customer's return window. `PAYMENT_STATUSES` split into the full list (for
filtering — `refunded` was already in the database, written by the till, and the
orders list treated it as invalid so merchants could not find their own refunded
orders) and **`SETTABLE_PAYMENT_STATUSES`** (what a human may choose). The
refund states are derived, never typed in.

**`app/dashboard/orders/refund-panel.tsx`** — in the order drawer. Offers the
gateway only for orders that went through it; a COD order gets an explanation
and the manual path, where a reference is **required** because it is the only
evidence that row will ever carry.

**Deliberately not in Step 1:** no restock (invariant 8), no auto-refund on
cancel or pickup expiry (§2.2 — cancel will _prompt_), no store credit, no
customer-initiated cancellation.

**⚠ Still verify in test mode before shipping:** the current Razorpay API docs
specify `X-Refund-Idempotency`, and the implementation and contract tests now
match it. The `notes` key remains a reconciliation backstop. Nothing here has
yet been exercised against a Razorpay test account.

---

## 10. Step 2's other half — cancellation

Refunds gave the platform a way to move money out. This gives it the two
moments that need to: an order that is cancelled, and one nobody collected.

### Nothing pays automatically, and that IS the feature

The roadmap asked whether cancelling should auto-refund. It should not, and it
should not be a setting either — the same argument §22 makes for owner-only
discounts. So the obligation is made **loud** instead of automatic:

- **In the dashboard**, `OrderRefundState.refundOwed` turns the refund panel
  amber with "This order was cancelled after it was paid for — ₹840 is owed
  back." It is **derived** from the order's status and its settled refunds, not
  stored: a flag would need clearing on refund, on partial refund and on
  reinstatement, and the one you forget is the one that nags forever.
- **From the cron**, which has no one to prompt, `refund_due` rides into the
  `order.pickup_expired` payload — so it reaches the merchant through the
  notification they already read. `refundDueForOrder` computes it;
  `refund_due` was added to `MONEY` in `lib/notifications/format.ts`, or it
  would have arrived as a bare `840` (§24's "Total 281.4" failure).

### `lib/orders/cancel.ts` — one implementation, two callers

The cancel side-effects were inline in `updateOrderStatus`. A second
hand-written copy for the customer path would have been a silent bug: stock
simply never comes back, and it surfaces in a stock count weeks later. The
module takes a `runner` so the dashboard keeps its RLS-scoped
`withUser(admin)` claim while the customer path uses `withService` after
proving ownership itself — neither caller loses the scope it had.

It preserves both branches exactly: **reserved** stock is released at the
location that reserved it (a POS sale must not restock at the store's default
shop), and a **pickup** order releases holds instead, because its units never
left the shelf and restocking would invent them.

### `cancelMyOrder` — one button, two outcomes

★ The client never decides which. Whether an order is stoppable depends on its
status, its age and the store's window; the server re-checks all three inside
the same statement that cancels, so a dispatch racing a cancel means one of
them matches nothing rather than both "succeeding".

- **Still stoppable** (`pending`/`processing`, not collected, inside the
  window) ⇒ cancelled outright, stock released, `order.cancelled` emitted
  carrying `refund_due`.
- **Too late** ⇒ `order.cancellation_requested`, and the order is not touched.
  The button deliberately does NOT disappear once an order ships: someone who
  wants out still wants out, and hiding it just turns into a support email the
  merchant handles by hand anyway.
- **It never moves money.** A shopper must not be able to trigger a payout from
  a public storefront action; the refund stays a human decision. Tested.

Settings (registry, group **Orders**, section `orders`, rendered at
`/dashboard/orders/settings`): `orders.allowCustomerCancellation`
(**default OFF** — new behaviour on a live store, invariant 1) and
`orders.cancellationWindowHours` (default 24).

### Two things this forced elsewhere

- **`blog-actions.test.ts` hardcoded an exhaustive `StoreSettingValues`
  literal**, so adding any setting anywhere broke tests that say nothing about
  blogs. It now derives the base from `resolveStoreSettings(null, "pro")`.
- **`PENDING` in the coverage guard is empty.** Every registry event has an
  emitter — `order.cancellation_requested` was the last one waiting.

**Still not verified against a live gateway or a browser.** New acceptance
cases: PS-12.13 – PS-12.20.

---

## 11. Step 2 — what shipped

The whole configuration surface, plus the two pure modules Steps 3–5 are built
on. **No return can be STARTED yet** — that is Step 3.

**Migration** `supabase/returns_01_product_policy.sql` — `products.returnable`
(backfilled TRUE, because nothing is final-sale today and a migration may not
change what a live store does) and `products.return_window_days` (nullable
override, CHECK 0–365).

★ **Nullable, not a copy of the store value.** Writing the store's window into
each product at save time would freeze it, so a merchant widening their
store-wide window later would silently not reach any product ever saved. The
same reason `0` is meaningful and had to survive a null check rather than `||`.

**Twelve `returns.*` settings**, group **Returns**, section `orders`, rendered
at `/dashboard/orders/settings`. All but three hang off `returns.enabled` via
`dependsOn`, so a store that hasn't switched returns on sees ONE switch instead
of a wall of config for a feature it doesn't use. `returns.enabled` defaults
**OFF** (invariant 1); `returns.allowInStore` is Pro, because it needs POS.

**`lib/returns/reasons.ts`** (pure, tested) — eight reasons, and the field that
matters is `merchantFault`. ★ **A fee is never charged for the merchant's own
mistake**: damaged / defective / wrong item / not as described / arrived late
waive fees WHOLESALE and put return postage on the store. A flat "10%
restocking fee on everything" bills the customer for a parcel that arrived
broken. Three guards fell out of writing it:

- the deduction is **capped at the goods value** — a ₹50 flat postage fee on a
  ₹25 item would otherwise compute a NEGATIVE refund, i.e. the customer owing
  money for sending something back;
- an **absent reason is not merchant-fault**, or anyone could waive fees by not
  answering (`returns.requireReason` is what makes that visible);
- a photo is only requested where one could **settle** the claim — it proves a
  dented tin, and nothing at all about a change of mind.

**`lib/returns/eligibility.ts`** (pure, tested) — one answer to "can this come
back, and until when", so the storefront badge, the request form, the review
queue and the till cannot disagree. The window starts at **possession**:
`delivered_at` → `collected_at` → `created_at` (POS only — they walked out with
it). Two decisions worth keeping:

- ★ **Undelivered is NOT expired.** `not_yet_delivered` is its own answer;
  collapsing them tells someone their day-old order is too old to return.
- ★ **It FAILS OPEN when a delivered order has no timestamp.** Refusing a
  genuine return because OUR backfill couldn't date a legacy row is the store's
  problem to absorb, not the customer's.

**Product editor** — a Returns card beside Tax class: "Final sale" plus an
optional window override, which hides itself when the product is final sale
(a window on something that can never come back is dead config).

**Storefront** — a **Final sale · no returns** badge on both PDP layouts
(classic and grocery). Shown regardless of whether returns are switched on: it
is a statement about that product, and a shopper is entitled to it before they
pay rather than after.

**Two settings are enforced immediately**, because they gate the refund path
that already exists: `returns.ownerOnlyRefunds` and
`returns.maxRefundWithoutApproval` now gate `refundOrder` via
`isStoreSuperadmin()`. ★ The cap is re-checked **inside the transaction**, once
the amount resolves — an omitted amount means "refund everything left", so
checking only `input.amount` would be bypassed by leaving the field blank.
The POS variant of this rule takes a manager's signed PIN grant; there is no
dashboard analogue of standing at a keypad, so here the escalation goes to the
person whose money it is.

**Not yet consumed** (Steps 3–5): selfServe, autoApprove, allowExchanges, the
two fee settings, requireReason, requirePhotoForDamage, allowInStore.

**Still unverified in a browser**, and none of the fee arithmetic has been
exercised against a real return — there is no way to start one yet.

---

## 12. Step 3 — what shipped

A return can now be **asked for, reviewed, and booked in**. It still never
moves money by itself — approving says what is owed and a human presses Refund
on the order, the same rule cancellation follows (§2.2).

**Migration** `supabase/returns_02_requests.sql` — a lifecycle on
`order_returns`: `requested → approved → received → completed`, plus
`rejected`/`cancelled`, with `channel`, `requested_by`, `reason_code`,
`photos`, the two fee snapshots, and the review fields.

★ **`status` DEFAULTS to `completed`, and that is load-bearing.** Every
existing row is a till return that was finished the moment it was written —
goods in hand, money out of the drawer. Defaulting to `requested` would
retroactively reopen every return the shop has ever taken, and
`pos-return-actions.ts` (which doesn't set the column) would start filing
completed counter refunds as pending paperwork. Invariant 1.

★ **A lifecycle on the existing table, not a `return_requests` sibling.** A
till return and a posted-back one are the SAME fact reached by different
routes; a second table means every reader — the refund maths, the restock, the
customer's history, any future report — either joins both or silently ignores
one. What differs is only how much of the lifecycle each route traverses.

**RLS**: customers gain SELECT on their own returns, scoped by the owning
order's `customer_id` **AND** store — the pairing
`pos_08_customer_order_store_scope.sql` applies to orders, because a Firebase
uid is global and uid alone would expose a return filed on another store.
Writes stay service-role.

**`app/actions/return-actions.ts`** — both ends of the object in one file. The
client says WHICH lines and HOW MANY; everything else is recomputed here.

Five rules worth keeping:

- ★ **AUTO-APPROVE NEVER COVERS A FAULT CLAIM.** "Arrived damaged" waives every
  fee, so auto-approving it lets anyone opt out of a store's return charges by
  picking the right radio button. Those always go to a person. This is not a
  setting — it is what makes `returns.autoApprove` safe to offer at all.
- ★ **A REJECTION MUST CARRY A REASON**, refused server-side. The customer reads
  that text verbatim; a silent no is the most complained-about thing a returns
  process does.
- ★ **ONLY `sellable` UNITS REACH THE SHELF**, and the condition is decided at
  RECEIPT — with the goods in front of someone — never at request time when
  nobody has seen them. A dented tin restocked is a shop selling the same
  broken thing twice.
- ★ **Only OPEN statuses hold units.** A rejected or cancelled request gives its
  quantities back; otherwise one declined return would make those items
  unreturnable forever, which is the opposite of what declining means.
- **Every state change is a conditional claim** — two admins deciding at once
  produce one decision, and an approved return can't be silently withdrawn by
  the customer.

`countReturnedUnits` **fails toward refusing**: a DB error returns
`MAX_SAFE_INTEGER` per line rather than an empty map, because "we don't know"
must not read as "nothing returned yet" and let a line be claimed twice.

**Three new events**, all with real emitters so the coverage guard stays green:
`order.return_requested` (team, both channels — a request nobody sees is a
customer waiting; the shopper already knows, they just pressed the button),
`order.return_approved` and `order.return_rejected` (both audiences).
`fees` joined `MONEY` in `format.ts` or it would have rendered as a bare `70`.

**Storefront** (`/orders/[id]`): a Returns card with the request form, previous
requests and their status, and the store's rejection note. The fee preview is
computed CLIENT-side from the SAME pure module the server uses, so choosing
"arrived damaged" visibly drops the deduction to zero — a customer who can see
they aren't being charged for the store's mistake stops arguing. It is a
preview; the server's number is the one that counts, and the copy says so.
Final-sale lines render **disabled with the reason** rather than hidden: a
missing row reads as a bug, a row that says why is an answer.

**Dashboard** (`/dashboard/orders/returns`): the queue, with fault claims
flagged "Our fault — no fees" since those are both the urgent ones and the ones
carrying no deduction. Declining is a form, not a button.

**Deliberately deferred:** photo UPLOAD (the column, sanitiser and dashboard
rendering exist; the storefront tells the shopper a photo may be asked for
rather than shipping a half-wired uploader), per-line damaged marking in the
receive step (it books in as sellable, matching the till, and never silently
destroys stock), and exchanges (Step 4).

**Never run in a browser**, and no return has been taken end to end.
New acceptance cases: PS-13.1 – PS-13.14.

---

## 13. Step 4 — what shipped

Exchanges. A shopper can swap a line for another variant of the same product,
the units are held from the moment they ask, and the replacement order is
raised when the goods arrive.

**Migration** `supabase/returns_03_exchanges.sql` —
`order_returns.exchange_order_id` plus, per line,
`exchange_product_id` / `exchange_variant_id` / `exchange_price` /
`exchange_hold_id`.

★ **An exchange is a return PLUS a new order, not a third entity.** Shopify
models it this way and the reason is structural: a distinct `exchanges` table
means every stock path, tax calculation, invoice, report and customer-history
query grows an "…or exchange" branch forever. Here it is two rows that already
exist and one foreign key between them — so the orders list, the invoice and
fulfilment routing all pick the replacement up with no changes at all.

**The target is per LINE.** "Send back the medium, I want the large" is a
statement about one line, not the basket, so one return can mix exchanged and
refunded items.

**★ THE PRICE IS SNAPSHOTTED AT REQUEST TIME.** Weeks pass between someone
asking and the parcel arriving. Re-reading the price at receipt would mean a
customer quoted "no extra charge" being billed the difference because the store
repriced in the meantime. The variant NAME is read fresh, because a name
changing is cosmetic — that asymmetry is the point.

### The v1 boundary, and why it's arithmetic rather than a flag

★ **A replacement may not cost MORE than what's coming back.**
`lib/returns/exchange.ts` (pure, 10 tests) computes the settlement and refuses
a dearer swap with a sentence telling the shopper to place a new order instead.

Collecting a difference is a payment flow that does not exist outside checkout
— it needs a Razorpay payment link, or an order left unpaid that somebody has
to chase. Half-building it produces replacement orders sitting in `pending`
forever, which is worse than not offering it.

It is deliberately the **arithmetic** that decides, not a feature flag:
`customerOwes` is still computed when the swap is refused, so the day a
payment-link flow exists the number to charge is already there. Same-price
swaps — the 80% case — settle to zero and need none of it. Cheaper swaps are
allowed and the balance goes back through the ordinary refund path.

### Stock: held at REQUEST, committed at RECEIPT

★ **Held when they ask, not when the merchant approves.** Otherwise the size
they swapped for sells out while the parcel is in transit and the exchange
fails at the last step — the worst possible moment to discover it. A hold
doesn't take units off the shelf (`locations_04`); it stops them being promised
twice. `resolveFulfilmentLocation` picks where, so an exchange can't hold stock
at a shop that never fulfils online.

Released on **decline** and on **withdrawal** — holding units for an exchange
that will never happen makes that size unsellable to everyone else. The TTL
sweep is the backstop. Committed against the new order at receipt, so the units
leave the shelf exactly once.

### Three things the replacement order must NOT do (§4.2, now enforced)

- **No coupon.** The original order consumed that promotion; the replacement
  inherits the price paid, not the code.
- **No second reservation.** `stock_status: 'none'` on the new order, because
  committing the hold IS the stock movement. Reserving again would take the
  same units twice.
- **No netted tax.** The replacement is taxed at its own class and today's
  rate; the returned lines' tax is refunded from their snapshot. Different
  transactions with the government, so the settlement compares GOODS values
  only.

`payment_method: 'exchange'`, `payment_status: 'paid'` — already paid for, by
the goods that came back. It must never show up as unpaid revenue to chase.

**Deliberately deferred:** shipping the replacement BEFORE the goods return
(an advance exchange needs a card hold, and there's no hold primitive here —
the merchant can always send one early by hand), and cross-product swaps, which
are a pricing minefield when a size or colour change is what people actually
want.

**New event** `order.exchange_ready`, emitted when the replacement order is
raised. **Never run in a browser.** New acceptance cases: PS-14.1 – PS-14.10.

---

## 14. Step 5 — what shipped

Buy Online, Return In Store. The `returns` location capability has been in the
registry since Phase 0 and read by nothing; this is what reads it.

### The bug that made BORIS impossible

`getReturnableSale` filtered on `orders.location_id = op.locationId`. An online
order's location is its FULFILMENT location — or null — so the till could never
find one. It is now **store-scoped**, and the location question splits into the
two it always was:

- **Whose shelf gains the stock?** The shop they walked into. Unchanged.
- **May this counter accept it?** `canTakeReturnHere` — a new question.

### One extraction, because the money mechanics must not be copied

`lib/payments/issue-refund.ts` now holds the refund mechanism, and both
`refundOrder` (dashboard) and `processReturn` (till) call it after their own
authorization — the same split `lib/orders/cancel.ts` uses.

★ A second hand-written copy of "reserve under a row lock, write the pending
row first, call the gateway with our key, treat an unknown outcome as
not-a-failure" is the last thing this codebase should have. Get one of those
wrong in the copy and a customer is refunded twice — silently, at a till, where
nobody is watching a log.

It returns a stable `code` alongside the message so each caller can say
something its OWN audience can act on: "Reconnect it in Channels" is right for
a merchant at a desk and useless to a cashier who has no way to get there.

### `lib/returns/in-store.ts` (pure, 14 tests)

★ **A sale rung at THIS counter is ALWAYS returnable here**, regardless of the
BORIS settings. Not a loophole — invariant 1. The till has taken its own
returns since `pos_12`; making that conditional on a setting introduced later
would break every shop doing it today the moment they upgrade.
`returns.allowInStore` governs the NEW capability and nothing else.

★ **THE TENDER DECIDES WHERE THE MONEY GOES.** An online order refunds to the
gateway and the till shows **no cash button at all** — a control that always
fails server-side, in front of a customer, is worse than no control.
`isTenderAllowed` is the server refusing it anyway. Handing cash back for a
card sale is the card-not-present laundering path: buy online with a stolen
card, return in store, walk out with clean cash. COD is the one case where cash
at the counter is right.

★ **A gateway refund carries NO `location_id` and NO `shift_id`.** It never
touches the drawer, and stamping a shift would make the cash report count money
that never left the till.

### Two failure modes worth stating

- **A failed gateway refund does NOT undo the return.** The customer has handed
  the items over and is walking away with nothing; the goods are booked in, the
  return stands, and the till shows a _warning_ naming what to do. Unwinding
  the receipt would lose a restock that physically happened.
- **`borisGates` fails CLOSED.** Refusing a return the merchant can still take
  by hand is recoverable; accepting one at a counter that isn't set up for it
  puts stock on the wrong shelf and money out of the wrong drawer.

### Also shipped

`findOrderForReturn` — store-scoped search by order ref, receipt, phone or
email, behind `/pos/pickups`. It shows orders the counter may NOT accept,
labelled "Bought elsewhere", because an empty result reads as "your order
doesn't exist" and a labelled one reads as an answer.

**Not built:** the return window and final-sale rules are NOT enforced at the
till. Adding them would change what the counter does today (invariant 1), and
the merchant is standing right there and can refuse. Wire them in behind an
explicit setting if a merchant asks.

**Never run in a browser.** New acceptance cases: PS-15.1 – PS-15.10.

---

## 15. Step 6 — what shipped

GST credit notes. Under Indian GST, refunding against a tax invoice requires
one, and it is a **legal document, not a receipt**: it is what reverses the
output tax the store has already declared, and a merchant's CA will ask for it.

### ★ The serial must have no gaps, and that decides the whole design

A missing number in a GST document series is precisely what an audit flags. So
the serial is allocated when a refund **SETTLES**, never when it is raised —
§9's design writes the row as `pending` BEFORE calling Razorpay, and a pending
refund that then fails would burn a serial and leave a hole.

That ruled out doing it in application code: `completed` is reached from FOUR
places (the till's direct insert, `issueRefund`'s non-gateway insert, its
gateway claim, and the reconcile sweep). Four call sites is four chances to
forget one. So it is a **trigger**
(`trg_order_refunds_credit_note`, `returns_04_credit_notes.sql`) — the same
reasoning convention #14 gives for `order_ref` and SKUs being trigger-owned: no
insert path can produce a settled refund without a number.

`credit_note_no IS NULL` makes it exactly-once, so a row that flips
completed → failed → completed keeps its ORIGINAL serial rather than taking a
second and leaving the first as a gap.

**No credit note on an untaxed order.** There is no output tax to reverse, so
issuing one would put a number in the series that reverses nothing.

**★ No backfill, deliberately.** Historical refunds were made without a credit
note, and inventing serials for them now would fabricate documents dated to
periods already filed — the opposite of what this is for. The series starts
from the next settled refund; past refunds go through the merchant's
accountant, which is the correct process.

### The document

`lib/billing/credit-note-data.ts` + `components/invoice/credit-note-document.tsx`,
reusing the invoice's stylesheet on purpose: the two get filed together, and a
merchant printing one after the other shouldn't be able to tell they were built
by different people. What differs is what it SAYS.

Three things make it a credit note rather than a refund receipt:

1. **Its own serial** — `CRN100100015`, the §14 identifier grammar with a Luhn
   check, mirrored in SQL by `sm_credit_note_ref` and cross-checked by
   `lib/identifiers.test.ts` against `formatCreditNoteRef`.
2. **The invoice it reverses**, named explicitly. One that doesn't name an
   invoice reverses nothing.
3. **The tax split the way it was charged** — CGST+SGST intra-state, IGST
   inter-state, via `splitGst`. Getting this wrong doesn't just look wrong; it
   files the reversal against the wrong head.

Everything comes from the ORDER's snapshot, never live settings: the rate on
the invoice is the rate that was charged, possibly months ago, and a store that
has since changed its rates must not reverse at the new one.

**Fees retained are shown as their own line.** Otherwise a refund that doesn't
match the credited value is an unexplained discrepancy on a legal document.

**A refund with no serial renders an EXPLANATION, not a blank page** — "hasn't
settled yet" or "no tax was charged". Both are correct behaviour, and a blank
document looks like a bug and gets printed anyway.

Keyed by REFUND at `/dashboard/orders/credit-notes/[refundId]`, not by order:
one order can be refunded more than once and each settled refund is its own
note. Linked from the refund panel.

**⚠ NOT reviewed by a CA or a lawyer**, the same posture §25 takes on the
platform's own policies. It covers the fields the format needs; get a
professional to check it before a merchant files against it.

---

## 16. Step 7 — what shipped

Store credit: a balance a store owes a customer, spendable at checkout. Two
paths were waiting on it — COD refunds (§3.3), where nothing was captured and
there is no instrument to reverse, and exchanges where the replacement costs
less.

**Migration** `supabase/store_credit_01_schema.sql` — `customer_credit_balances`
(one row per store+customer, `CHECK (balance >= 0)`), the append-only
`customer_credit_ledger`, two RPCs, and `orders.store_credit_used`.

Modelled on `ai_credits.sql`, which already solves this exact problem here: the
**ledger is the truth**, the balance is a cached sum, every mutation is a
single conditional UPDATE, and issuing is idempotent per `(store, customer,
kind, ref)` so a double-confirmed refund credits once.

★ **`try_spend_customer_credit` puts `balance >= amount` INSIDE the UPDATE**, so
two checkouts racing on one balance cannot both pass a prior check-then-act and
overdraw it.

★ **`reinstate` is its own ledger kind, not a second `grant`.** A report that
can't tell a returned spend from a goodwill gesture will overstate what the
store gave away.

### ★ Credit is a PAYMENT, not a discount

`orders.total` stays the FULL value of the goods; `store_credit_used` records
how much of it was settled with credit, and only the REMAINDER is charged.

Netting it off the total would be quietly wrong in three places at once: the
invoice would understate the sale, GST would be computed on a base that isn't
what was sold, and the credit note (§15) would reverse the wrong amount. A
customer paying ₹200 of a ₹500 order with credit still bought ₹500 of goods,
and the tax authority's share doesn't shrink because of how they settled it.
Pinned by a test that asserts the same basket writes the same total with and
without credit.

### ★ The unpayable-remainder gap

`lib/credit/apply.ts` (pure, 13 tests). A ₹200.50 order against a ₹200 balance
naively leaves **₹0.50** to charge — and Razorpay refuses anything under ₹1, so
checkout would fail with an error about the amount being too small, on an order
the customer nearly had enough credit for. It only appears when the balance
lands within a rupee of the total, which is exactly the kind of thing that
reaches production.

So when the remainder would fall in that gap, **less** credit is applied — just
enough to leave a chargeable amount, and the difference stays on the balance.
Rounding the credit UP to cover the whole order was rejected: it spends money
the customer didn't agree to spend, to save them a rupee they were willing to
pay. The rule is off for COD and the counter, which have no floor.

The checkout summary uses the SAME pure function as the server, so the preview
and the charge cannot disagree on the rule — and it says so when credit was
held back, since silently charging ₹1 more than expected is worse than a line
of text.

### The rest

- **Fully covered ⇒ the order is `store_credit` / `paid`.** Without that a COD
  courier is told to collect ₹0 and the gateway is asked for an amount it
  refuses.
- **Cancelling reinstates.** `lib/orders/cancel.ts` calls
  `reinstateCreditForOrder`, keyed on the order so a second cancel reinstates
  nothing rather than minting money. Without it, cancelling silently destroys
  the customer's balance.
- **Spending never refuses a sale** (invariant 6). A balance that moved
  underneath us means they pay the full amount, not that checkout fails.
- **Offered, never forced.** The refund panel adds a "Store credit" option
  only when the order has a customer account, and says to make sure they have
  agreed to it rather than a refund — a customer owed money for a faulty item
  is entitled to refuse a balance (§3.3).

**Not built:** gift cards (codes bought and redeemed — they share this ledger
shape, which is why `kind` is an enum), expiry (`'expire'` is reserved in the
CHECK so it needs no migration), a merchant UI to grant credit by hand
(`issueCredit` takes `kind: 'grant'` and is ready for one), and split-tender
refunds — refunding an order that was part-paid with credit currently offers
the full amount to whichever method the merchant picks.

**Never run in a browser.** New acceptance cases: PS-17.1 – PS-17.12.
