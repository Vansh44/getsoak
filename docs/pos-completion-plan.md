# Completing POS — the ordered plan

**What is left to make Point of Sale a finished product, in the order it should
ship.** This file is the SPECIFICATION for Steps 1–5 below; `docs/roadmap.md`
stays the single sequence and links here.

- **Architecture:** `CODEBASE.md` §22 (POS), §23 (locations), §24 (notifications)
- **Acceptance tests:** `docs/pos-acceptance.md` — a step is not done until its
  stories are in there
- **Design detail already written:** `docs/pos-plan.md`,
  `docs/returns-exchanges-plan.md`, `docs/inventory-fulfilment-roadmap.md`

> **★ marks a non-obvious invariant** — something that looks right by accident
> and breaks silently. Those are the lines worth re-reading during review.

---

## Where we actually are

Built and working: locations + per-location inventory, the register, GST,
thermal receipts, barcode scanning, shifts and cash reconciliation, shop-floor
inventory with atomic transfers, returns/BORIS, exchanges, credit notes, store
credit, and metered extra-location billing.

**Pickup is the outlier.** Every piece exists — holds, routing, the collection
queue, tender capture at hand-over, four email events — and _none of it has ever
been run end to end in a browser_. Steps 1 and 3 finish it.

---

## Status at a glance

| #   | Step                                                    | Size | Why here                                        |
| --- | ------------------------------------------------------- | ---- | ----------------------------------------------- |
| 1   | Checkout payment defaults + pickup payment policy       | S    | A live money-path bug; also unblocks Step 3     |
| 2   | Cancellation: per-product policy + refund to source     | M    | Independent; closes the oldest known gap        |
| 3   | Pickup end to end: code, QR, manager/cashier split      | L    | The biggest visible hole; needs Step 1's policy |
| 4   | POS customer capture (Shopify parity) + claim/merge     | L    | Identity work; unblocks all CRM                 |
| 5   | Receipts: email now, WhatsApp/SMS behind it             | M    | Needs Step 4's captured contact                 |
| 6+  | The pre-existing roadmap (LOC H–K, offline, gift cards) | —    | Unchanged; see `docs/roadmap.md`                |

---

## Step 1 — Checkout payment defaults, and who pays when

Two small changes to the same screen. Ship them together; they touch the same
state.

### 1.1 The gateway-configured store still defaults to COD

**The bug.** `app/(storefront)/(pages)/checkout/page.tsx:142` is
`useState<PaymentMethod>("cod")`, and nothing ever reconciles it with
`payConfig.onlinePayments` (loaded async at :158). So a merchant who has
connected Razorpay watches every shopper land on Cash on Delivery — the option
that costs them a courier round trip and a collection risk, pre-selected by us.

**Ships.** Default to `razorpay` once the config says online payments are live.

**★ IT MUST NOT STOMP A CHOICE THE SHOPPER HAS ALREADY MADE.** The config
arrives after first paint, so a naive `useEffect(() => setPayMethod("razorpay"),
[payConfig])` will yank the selection out from under anyone who tapped COD in
the intervening moment. Track whether the control has been touched and only
apply the default while it has not. A payment method that changes itself after
the customer picked one is worse than a wrong default.

**★ Store credit still wins.** When a balance covers the order in full the
method resolves to `store_credit` regardless (§29) — the default only decides
what is pre-selected among the methods actually on offer.

### 1.2 Prepay or pay at the counter — the merchant's call

**Today** checkout hardcodes `fulfilment === "pickup" && payMethod === "cod"
→ "pay_at_store"`. A merchant who wants collections paid for up front has no way
to say so, and one who wants cash at the counter has no way to require it.

**Ships.** A registry setting, `fulfilment.pickupPayment`, section `locations`,
group Checkout, three values:

| Value             | Behaviour                                                       |
| ----------------- | --------------------------------------------------------------- |
| `customer_choice` | Both offered (today's behaviour) — **the default**, invariant 1 |
| `prepaid`         | Pickup orders must be paid online; `pay_at_store` is refused    |
| `at_store`        | Pickup orders are always settled at the counter                 |

**★ ENFORCED IN `placeOrder`, NOT ONLY IN THE PICKER.** A hidden radio is not a
permission (roadmap invariant 5). A store on `prepaid` that receives a
`pay_at_store` order must reject it — otherwise the goods are held and nobody
ever owes anything.

**★ `prepaid` needs a gateway.** Setting it on a store with no Razorpay
connection would make pickup unorderable. Refuse the setting server-side with a
sentence pointing at Channels, the way `returns.allowInStore` is Pro-gated.

**Acceptance:** PS-C.1–C.6. Effort: **half a day.**

---

## Step 2 — Cancellation: per-product policy, and money back to source

### 2.1 Which products a customer may cancel

**Today** `orders.allowCustomerCancellation` is store-wide. A merchant selling
both stock items and made-to-order goods cannot allow one and refuse the other.

**Ships.** `products.cancellable boolean NOT NULL DEFAULT true`, in its own
migration — **the exact shape `products.returnable` already has** (§28), for the
identical reason: the settings registry holds one value per store and cannot
address a single SKU. A `cancellation_policies` table was considered and
rejected on the same grounds tax classes were the exception: rules here rarely
vary by more than "yes or no".

**★ BACKFILL TRUE.** Nothing is non-cancellable today, so `false` would silently
change every live store's policy — a migration may not change what a live store
does (invariant 1).

**★ v1 IS WHOLE-ORDER ONLY, AND THE ORDER IS CANCELLABLE ONLY IF EVERY LINE
IS.** `cancelMyOrder` and `lib/orders/cancel.ts` cancel an entire order; partial
cancellation is a different feature — it needs partial refunds, partial
restocks, and an order that stays open afterwards, which is really "refund some
items" and belongs with returns. Shopify draws the same line.

> ⚠ **DECISION FOR THE OWNER.** If you want a customer to cancel _part_ of a
> mixed order, say so before Step 2 starts — it roughly doubles it and pulls in
> the returns machinery. The plan below assumes whole-order.

The customer's order page must say _why_ when the button is absent: "This order
contains items that can't be cancelled online" beats a missing control.

### 2.2 Refund to source on cancel

**This reverses a documented decision, deliberately.** CODEBASE §27 says
cancelling never moves money, and the reasoning stands for a _merchant_
cancelling: money leaving with no human looking at it is the one irreversible
act with no physical trace. But for a **customer cancelling their own prepaid
order**, the merchant is holding money for goods that will never ship, and
making them press a button for every one of those is a support queue, not a
control.

**Ships.** `orders.autoRefundOnCancel` (section `orders`, **default OFF** —
invariant 1), and when it is on:

- a **customer** self-cancel of a `razorpay`-paid order issues a gateway refund
  to source automatically, through `lib/payments/issue-refund.ts` — the ONE
  refund mechanism (§28), never a second copy;
- a **merchant** cancel still only _prompts_, exactly as today. They may be
  cancelling for a reason that changes what is owed;
- `cod` refunds nothing (no money moved) and `store_credit` reinstates, which
  `reinstateCreditForOrder` already does.

**★ THE REFUND IS RAISED AFTER THE CANCEL COMMITS, NEVER INSIDE IT.** The cancel
claim is a conditional UPDATE that decides exactly-once; a gateway call inside
that transaction holds a row lock across a network round trip, and a timeout
would roll back a cancellation the customer has already been told about. Cancel
first, refund in `after()`, and let reconcile-on-read settle an unknown outcome —
the §26 posture, unchanged.

**★ AN `unknown` GATEWAY OUTCOME IS NOT A FAILURE.** §26 already draws this
distinction and it matters more here, because nobody is watching: a 5xx means
the refund may exist, so the row stays `pending` and the sweep settles it.
Reporting it as failed is how a customer gets paid twice.

**★ PARTIAL-REFUND CAP STILL APPLIES.** `refundableAmount` must be consulted
even on an auto-refund — an order that was already partly refunded must not have
its full total sent back.

**Acceptance:** PS-C.7–C.14. Effort: **2–3 days.**

---

## Step 3 — Pickup, end to end

The largest step, and the one with the most already built. Read `CODEBASE.md`
§23 first — holds, routing, the queue and tender capture all exist.

### 3.1 A collection code, and a QR for it

**Ships.** `orders.pickup_code text UNIQUE` — a short, human-readable,
unambiguous code (8 chars, Crockford base32: no `I`, `L`, `O`, `U`), generated
at order time for pickup orders only.

**★ THE CODE IS NOT THE ORDER ID.** Order UUIDs are internal and `order_ref` is
sequential and guessable (§14). A collection code is presented by whoever holds
it, so it must be random — but it is **not** an authorisation on its own: the
counter still resolves it store-scoped and the operator still sees who the order
belongs to. Access control stays UUID + store scope, exactly as §14 states; the
code is a _lookup_ key, not a bearer token.

**★ THE EMAIL LEADS WITH THE CODE, NOT THE QR.** Gmail strips `data:` URIs in
`<img>`, and every major client blocks remote images by default. A QR that
renders as a broken-image icon on the one screen the customer holds up at the
counter is worse than no QR. So:

1. the **code in large text** in the email body — always renders, and can be
   read aloud or typed if a scanner fails;
2. a **link to a hosted collection page** on the storefront showing the QR big
   enough to scan off a phone, plus the shop address and hold deadline.

That page is `/orders/[id]/collect`, owner-gated by the existing customer RLS,
`noindex`. QR generation happens there, client-side — no new server dependency,
no image hosting, and the code is in the URL already.

### 3.2 Manager prepares, cashier hands over

**Today** both `markReadyForPickup` and `markCollected` require only
`posCan(role, "sell")`, which every role holds — so a cashier can mark an order
packed without ever seeing it.

**Ships.** A new capability `fulfil_pickup`, held by **manager and above**,
gating `markReadyForPickup`. `markCollected` stays on `sell`: handing over a
packed order to a customer standing there is exactly a cashier's job.

**★ THIS CHANGES BEHAVIOUR, AND THAT IS ONLY SAFE BECAUSE NOBODY IS USING IT.**
Invariant 1 forbids a migration changing what a live store does — pickup has
never been run end to end, so there is no live behaviour to preserve. Say so in
the commit; if any store has enabled `fulfilment.offerPickup` before this ships,
the capability must default open instead.

**Routing.** New pickup orders should reach managers **at that shop**, not the
whole store. `notification_settings.routing_scope = 'event_location'` already
does this (§24) and `placeOrder` already passes the resolved location — so this
is a default to set, not a mechanism to build.

### 3.3 Scan at the counter

`/pos/pickups` gains a scan box that resolves a collection code, reusing
`createKeyboardWedge` and `lib/pos/barcode-camera.ts` — a hardware scanner is a
keyboard, so this is mostly wiring. A code that resolves to another shop's order
must say which shop, not "not found": the customer is standing there and the
answer they need is "this is waiting at Andheri".

### 3.4 The states a shopper sees

`order-status.tsx` already speaks collection (§23). What is missing is the
**ready** notification carrying the code, and the collection page linked from
both the confirmation email and the order page.

**Acceptance:** PS-8.1–8.31 (existing, still never run) + PS-C.15–C.24.
Effort: **1–1.5 weeks.**

---

## Step 4 — POS customer capture, the Shopify way

### What Shopify actually does

1. Cart → **Add customer** → search, or **create one inline** (name, email,
   phone — all optional except a name).
2. The sale completes with or without a customer. A walk-in is a first-class
   outcome, never a blocked one.
3. At payment → **receipt options**: print, email, text, none. Email or phone
   entered _there_ attaches to the sale even when no customer record exists.

**We have (1) search and (2) optional.** We cannot create, and we capture no
contact at all at receipt time.

### Why creating is hard here

`users.id` **is** the Firebase uid, and `multitenant_01` scopes uniqueness to
`UNIQUE (store_id, phone)` and `UNIQUE (store_id, email)`. So a till-invented
row has no natural primary key, and if that same person later signs up online
with the same phone, their signup **collides with the row we invented for them**.

### Ships — an unclaimed customer, and a claim on signup

**Migration.** `users.claimed_at timestamptz` (NULL = never had an account) and
a relaxed id: till-created rows get `pos_<uuid>`, which the `text` PK already
permits.

**★ AN UNCLAIMED ROW CAN NEVER LOG IN, AND THAT IS AUTOMATIC.** Customer RLS is
`auth.uid() = users.id`; a `pos_…` id matches no Firebase uid, so these rows are
invisible to every session without a single new policy. Do not add one.

**★ THE CLAIM IS THE WHOLE FEATURE.** When someone signs up with a phone that
matches an unclaimed row for that store, `upsertCustomerProfile` must **adopt**
it rather than fail on the unique constraint: rewrite that row's `id` to the
Firebase uid and stamp `claimed_at`, inside ONE transaction. Their in-store
purchase history is theirs the moment they create an account — which is the
actual CRM payoff, not a side effect.

**★ `orders.customer_id` REFERENCES THAT ID.** Rewriting a PK under a live FK
needs `ON UPDATE CASCADE` on the constraint, or an explicit update of both
tables in the same transaction. Whichever is chosen, it must be one transaction:
a half-claimed customer has orders pointing at an id that no longer exists.

**★ A COLLISION WITH A _CLAIMED_ ROW IS NOT A CLAIM.** If the matching row
already has `claimed_at`, that phone belongs to a real account — the till must
attach to it, not adopt it. Adopting would hand one customer's order history to
whoever typed their number.

**Receipt contact.** The tender panel gains an optional email field feeding the
existing notification machinery, so a walk-in gets an emailed receipt with no
account. SMS waits for Step 5.

**Acceptance:** PS-C.25–C.34. Effort: **1–1.5 weeks**, and the riskiest work in
this plan — it touches identity. Do it behind tests before anything else in Step
4 lands.

---

## Step 5 — Receipts

Email receipts for POS sales (Step 4 captures the address), then WhatsApp/SMS
via Twilio behind the existing channel abstraction — `sms` and `whatsapp` are
already declared and `available: false` in `lib/notifications/channels.ts`.
Unlocking them is the work; the fan-out, the queue and the templates exist.

Effort: **3–4 days** for email, **~1 week** for Twilio.

---

## Then: the pre-existing roadmap

Unchanged, and re-sequenced only by the above. See `docs/roadmap.md` Steps 6–11:
channel stock policy (LOC H), transfer lifecycle (LOC I), routing strategies
(LOC J), WhatsApp/SMS (POS 6 — folded into Step 5), offline outbox (POS 9), full
omnichannel (POS 8 / LOC K), and gift cards.

**Also outstanding, unglamorous, and worth scheduling:**

| Item                          | Why it matters                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| Catalogue **delta** sync      | Today every register re-pulls the whole catalogue every 5 min — O(catalogue), forever  |
| Money-event **audit**         | All 6 `posAudit` sites are auth-only; discounts, overrides and till refunds leave none |
| Analytics **location filter** | Store-wide figures only, on a multi-location product                                   |
| Sale round trips              | `placePosSale` makes 11 separate transactions — 11 × RTT on the fastest path           |
| Live **Razorpay** run         | Refunds and metered billing have never touched a real account                          |

---

## Invariants — every step above obeys these

Restated from `docs/roadmap.md` because Steps 1–3 all touch money:

1. **A migration may not change what a live store does.** New behaviour
   backfills OFF; existing behaviour backfills ON.
2. **Nothing cached is authoritative.** The server re-prices and re-reserves.
3. **Exactly-once is a conditional claim**, never check-then-act.
4. **Cross-location writes are one RPC** — there is no cross-statement
   transaction over the pool.
5. **A disabled control is not a permission.** Re-enforce server-side.
6. **Never refuse a sale over an optional feature.**
7. **Every action emits an event.**
8. **Absence is not restriction.**

---

## Open decisions

Three things change scope materially and are the owner's to settle:

1. **Partial cancellation** (§2.1) — whole-order only, or per-line? Per-line
   roughly doubles Step 2 and pulls in the returns machinery.
2. **Auto-refund on cancel** (§2.2) — this reverses §27's "cancelling never
   moves money". The plan scopes it to _customer_ self-cancel of _prepaid_
   orders, default OFF. Confirm that boundary.
3. **Pickup capability split** (§3.2) — safe only because pickup has no live
   users. If any store has already enabled it, the new capability must default
   open instead.
