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
| —      | Signup recovery, full business address + live pricing          | —    | ✅ done |
| —      | Shopify-shaped fulfilment + Shiprocket logistics core          | L    | ✅ done |
| —      | Checkout shipping policies, live courier rates and ETAs        | M    | ✅ done |
| —      | Shopper Online / In-store omnichannel order history            | S    | ✅ done |
| **P1** | **Release verification and high-risk action hardening**        | XL   | ◐ part  |
| **0**  | **Platform → merchant billing rebuild**                        | XL   | ◐ part  |
| **1**  | Checkout payment defaults + pickup payment policy              | S    | ✅ done |
| **2**  | Cancellation & refund flow                                     | M    | ✅ done |
| **3**  | Pickup end to end: collection code, QR, role split             | L    | ✅ done |
| **4**  | POS customer capture (Shopify parity) + claim/merge            | L    | ✅ done |
| **5**  | **Receipts — SMS opt-out webhook, then a real send (POS 6)**   | M    | ⏭ next |
| **12** | POS payments — gateway tender at the till                      | M    | ✅ done |
| **13** | Return restock lands at the shop that took it                  | S    | ✅ done |
| **6**  | Channel stock policy, per location and configurable (LOC H)    | M    | ⏳      |
| **7**  | Transfer dispatch note (LOC I — rescoped, no in-transit state) | S    | ⏳      |
| **8**  | More routing strategies (LOC J)                                | M    | ⏳      |
| **9**  | Gift cards                                                     | M    | ⏳      |
| **10** | Offline outbox (POS 9)                                         | XL   | ⏳      |
| **11** | Full omnichannel (POS 8 = LOC K)                               | XL   | ⏳      |

**★ THE NUMBER IS A STABLE ID, NOT A SEQUENCE.** Row ORDER is the priority; the
number only names the step. Steps 12 and 13 are newer than 6–11 and sit above
them deliberately. Do not renumber to make the column ascending —
`docs/inventory-fulfilment-roadmap.md` cites "Step 8" by number, and the
returns plan cites Steps 1–4, so a tidy-up silently repoints those references.

**★ WHAT `✅ done` MEANS IN THIS TABLE: the code shipped.** It does NOT mean
anyone has run it in a browser — that is tracked in **P1** and in each step's
own ⚠ notes. Steps 2, 3, 4, 12 and 13 are all `✅ done` and every one of them is
still unexercised against a real till, browser or gateway. Reading `done` as
`shippable` is how this table stops being trusted; if a step's code is finished,
mark it done and put the caveat in the section, rather than leaving the row at
`◐ part` on a different standard from its neighbours.

**★ MIGRATIONS ARE NO LONGER A CAVEAT — they are all applied** (owner,
2026-08-18; spot-verified the same day against `storemink` AND
`storemink_staging`: `pos_parked_sales`, `store_sms_providers`,
`sms_suppressions`, `platform_announcements`,
`order_payments_gateway_ref_key`, `orders.pickup_code`,
`orders.cancellation_status`, `users.claimed_at`, `order_returns.location_id`,
`store_payment_providers.webhook_secret_enc`, and all six FKs to `users.id`
carrying `ON UPDATE CASCADE`). ⚠ That is a point-in-time check of the objects
those files create, not proof that every statement in every file ran — ask the
database, not this paragraph, before depending on a specific one.

**Where we actually are.** Everything in the top block works. **Step 0 is
numbered 0 because it is not optional and not sequenced with the rest** — it is
how StoreMink gets paid, and the old path cannot change an amount on a UPI or
e-mandate mandate at all (`docs/billing-architecture.md` §2). **Pickup is the
outlier**: every piece exists — holds, routing, the collection queue, tender
capture at hand-over, four email events, and since 2026-08-10 the collection
code, QR page and role split — and _none of it has ever been run end to end in a
browser_. Steps 1 and 3 built it and its migration is applied; what is left is
purely the run, which sits in the P1 gate rather than in a feature step.

**Release-hardening P1 is verification-first, not another feature track.** The
ordered gate is: notification actions → shipment/shipping actions → pickup in
a browser → Razorpay test-mode refunds/billing → autopay → remaining exposed
actions. The notification action surface is covered by focused tests for
recipient and host isolation, permission gates, input validation, persistence,
email safety, personal preferences, audience routing and failed-delivery retry.
Its default email layer now has hand-written customer transaction journeys,
action-specific team alerts, contrast-safe store branding and mobile-verified
order/pickup/refund layouts; preview and test sends preserve the selected
audience rather than rendering customer copy with staff chrome.
Shipment and shipping actions are also covered: server-side catalog pricing,
stock and PIN validation; connection and location mapping gates; booking leases;
resumable provider stages; pickup, tracking, NDR and cancellation; and the
manual-courier fallback. The remaining exposed action pass now covers help
centre public/operator boundaries, Shiprocket connection secrets and warehouse
mapping, custom-domain state transitions and store-signup provisioning/rollback.
The code-only action hardening is complete. The release gate remains open:
browser pickup still needs an authorized disposable environment/data set, then
Razorpay refunds, billing and the new counter tender (Step 12) need test-mode
credentials; autopay follows only after those real provider behaviours are
observed. Schema is no longer part of this gate — every migration is applied. This gate does not change
Step 4's place in the product roadmap; it decides when the already-built system
is safe to expose to real transactions.

---

# Part 1 — What to build

---

## Delivered foundation — Shiprocket logistics ✅ DONE

The delivery lifecycle is no longer an order-status dropdown pretending to be
a warehouse. `logistics_01_shiprocket.sql` adds Shopify-shaped fulfilment work,
parcels and append-only carrier events; each merchant connects their own
Shiprocket API user in Channels and maps every `online_fulfil` location to a
pickup address. Location address lines are normalized for Shiprocket's primary
address and minimum-length rules, including older locations whose house/flat
details were saved in the optional second line.

The order drawer now covers the warehouse path: confirm the packed weight and
dimensions, create the Shiprocket order, persist its IDs before continuing,
assign an AWB, generate the label, schedule pickup and expose the manifest.
Checkout rejects malformed or repeated-placeholder Indian mobile numbers, and
the drawer lets staff correct a legacy order's delivery phone before any
Shiprocket order/shipment/AWB exists, then retry booking.
Every stage is resumable under one local idempotency key. A timeout after AWB
creation therefore retries the missing label instead of buying a second
shipment. A merchant can record another courier manually without losing the
same tracking/order semantics.

Shiprocket webhook and manual refresh both feed one provider-neutral,
duplicate-safe, non-regressing status machine. Pickup, transit, delivery, NDR
and RTO propagate to the order/customer timeline; the dashboard can ask for a
re-attempt or return-to-origin. Credentials, raw events and carrier internals
are service-only, while the shopper sees courier, AWB, tracking link and scans.

**Deployment state:** `supabase/logistics_01_shiprocket.sql` is enrolled in the
checksummed migration ledger and applied to staging **and production**
(2026-08-14). The remaining merchant setup is to set `PAYMENT_CRED_KEY`, connect
the merchant account, sync warehouses, and copy the generated provider-neutral
URL/token into Shiprocket's webhook settings. The callback path deliberately
omits Shiprocket's reserved provider keywords so its dashboard accepts the
address.

**Added checkout layer:** `shipping_01_checkout_rates.sql` and Settings →
Shipping & delivery let each merchant choose always-free, one fixed order rate,
or live Shiprocket courier rates, with an optional free-above threshold. Manual
rates carry a merchant-entered delivery range; live rates include handling time,
an optional price adjustment, and either the cheapest courier or up to five
choices. Checkout re-prices from the selected fulfilment location and freezes
the chosen courier/customer charge/carrier cost/ETA on the order; booking uses
that courier by default.

**Added storefront discovery:** the fixed header now remembers a delivery PIN,
prefers a signed-in shopper's default saved address, and offers an explicit
browser-location lookup. Classic and grocery product pages check that PIN
against online warehouse stock and the same free/fixed/Shiprocket quote engine
used at checkout, showing availability, charge and handling-inclusive ETA. The
PDP passes only ids/PIN/quantity; the server re-reads every commercial value.
The oversized PDP gap below the fixed header and the old hardcoded “tomorrow” /
“free over ₹499” claims are removed.

**Still not in the completed layers:** postal zones, weight/price rate tables,
product-specific shipping profiles, multi-parcel or multi-location splits,
return-label purchasing, weight-dispute and COD-remittance reconciliation.
Those are later Shopify-parity layers, not hidden inside an “integrated” badge.

Acceptance: **PS-SH.1–SH.29**.

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

## Step 2 — Cancellation & refund flow ✅ DONE

**Owner spec, 2026-08-09.** It supersedes the earlier draft below in two ways
worth stating plainly: there is **no per-product `cancellable` control** (the
window is store-level), and cancellation does **not** auto-refund to source —
the refund DESTINATION is chosen and confirmed, Shopify's model.

**✅ Shipped (server):**

- `lib/orders/cancellation.ts` — pure rules + 49 tests: the five-value window
  (`none` / `until_fulfilled` / `1h` / `24h` / `custom`), eligibility, the fixed
  cancel-reason vocabulary, and which refund destinations an order can honour.
- `supabase/orders_01_cancellation.sql` — the request lifecycle as columns on
  `orders` (applied), plus a partial index for the queue.
- Three settings: allow, window (select), approval (select, **approval
  required** by default).
- `lib/orders/approve-cancellation.ts` — ONE implementation of "cancel it",
  shared by the merchant's panel, the Approve button and customer auto-approve.
- `cancelMyOrder` rewritten **request-first**; `getCancellationRequests`,
  `cancelOrder` and `declineCancellation` on the merchant side; the
  `order.cancellation_declined` event.

**✅ Shipped (UI):** the storefront confirmation step (a real panel, not
`window.confirm` — it has to say this cancels the ENTIRE order and that the
store decides, and take the reason that makes the merchant's decision an
informed one), the dashboard queue at `/dashboard/orders/cancellations` with
approve/decline, and the settings selects (registry-driven, so the page needed
only its now-wrong footnote corrected — it claimed cancelling "never moves
money").

**Acceptance:** PS-D.1–D.13. **⚠ Still not verified in a browser** — the
migration is applied now, so nothing blocks it but the run itself.

**★ ASKING IS NOT CANCELLING.** A customer raises a request; a human approves
it. Money and stock move on APPROVAL. Before this, an eligible order was
cancelled outright the moment the button was pressed.

**★ WHOLE-ORDER ONLY, EVERYWHERE.** No item-level cancellation, approval,
refund or state — and none is planned, because it needs partial fulfilment this
system does not have. Owner decision, and written into the module headers so it
survives the next person reading them.

**★ BOTH REFUND DESTINATIONS GO THROUGH `issueRefund`.** It already knows
`store_credit` as a method, so using it for both means an `order_refunds` row
either way, the refund cap applied to both, and the pending-row-first
idempotency. Calling `issueCredit` directly would credit a customer with no
refund row behind it — money out that the order does not know about.

**★ A FAILED REFUND IS NEVER REPORTED AS SUCCESS**, and a `pendingReconcile`
answer is never reported as a failure (§26) — the order is cancelled either way,
but the caller must say which happened.

Below is the earlier draft, kept for the parts still true.

### (superseded) Step 2 — per-product policy, and money back to source

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

## Step 3 — Pickup, end to end ✅ DONE

**✅ Shipped:** `lib/fulfilment/collection-code.ts` (pure + 13 tests — Crockford
base32, so the characters people misread off a phone are not in the alphabet and
the normaliser folds them back), `orders.pickup_code` (migration applied), code
minted at checkout for collections only, the `fulfil_pickup`
capability gating "mark ready" to manager and above, the customer collection
page at `/orders/[id]/collect` with a client-rendered QR, the code carried into
the `order.ready_for_pickup` notification, and `findPickupByCode` for the
counter.

**✅ Also shipped:** the scan box on the collection queue (one box takes both a
scanned code and a typed order number — a scanner is a keyboard, and a counter
should not make anyone choose a field first — since extended to past orders
too, when the queue and the returns lookup merged into `/pos/pickups`; see
CODEBASE.md §22 "the shell"), the code in the confirmation
email, and a per-event **default routing scope** so pickup events reach managers
at the shop it happened at.

**★ `order.placed` DELIBERATELY DOES NOT DEFAULT TO `event_location`.** It fires
for every order including deliveries, so narrowing it would change who hears
about ordinary orders for every existing store (invariant 1). Only the four
pickup-specific events default, and those are safe because pickup has no live
users. A merchant's own choice always wins over the default.

**⏳ Remaining:** running PS-8.1–8.31 and PS-E.1–E.6 in a browser. Nothing
blocks it any more — `supabase/locations_11_pickup_code.sql` is applied
(`orders.pickup_code` verified present in `storemink` and `storemink_staging`,
2026-08-18), so the only thing left is somebody doing the run.

**★ THE ROLE SPLIT WAS SAFE TO MAKE** because no store had pickup enabled
(owner confirmed 2026-08-09) — there was no live behaviour to take away. It is
now covered by tests; `markReadyForPickup` had none at all before.

Below is the spec it is being built from.

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

The collection queue gains a scan box resolving a collection code, reusing
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

## Step 4 — POS customer capture, the Shopify way ✅ DONE

### Shipped foundation — channel-aware shopper history

`/orders` now separates **Online** from **In store** only when that second
journey is real. In store includes StoreMink POS purchases linked to the signed-
in customer and online pickup orders. The split is shown when the store has an
effective POS setting plus an active POS-capable shop, when checkout pickup is
enabled plus an active pickup-capable shop, or when the customer owns a
historical POS/pickup order. That last condition is deliberate: disabling POS,
pickup, a location or a plan may stop future sales but must never hide an owned
receipt. Delivery-only stores keep the simpler single history.

POS detail pages now say **Purchased in store**, show the sale location and do
not render a courier timeline or an empty delivery address. A pickup stays an
online checkout source internally but is grouped under In store because it is
a shop-visit journey for the customer.

That gap is now closed by the identity work below: the till can record a walk-in,
and their later signup adopts the row.

### What Shopify does

1. Cart → **Add customer** → search, or **create one inline** (name, email,
   phone — all optional except a name).
2. The sale completes with or without a customer. A walk-in is a first-class
   outcome, never a blocked one.
3. At payment → **receipt options**: print, email, text, none. Contact entered
   _there_ attaches to the sale even with no customer record.

**All three SHIPPED.** Search, inline create, a sale that completes with or
without a customer, and the receipt-contact box on the tender panel — see
"SHIPPED — receipt contact" below. SMS as a receipt channel is Step 5, not this
step: no POS receipt path sends over SMS today (there is no
`lib/pos/receipt-delivery.ts`).

### Why creating is hard here

`users.id` **is** the Firebase uid, and `multitenant_01` scopes uniqueness to
`UNIQUE (store_id, phone)` and `UNIQUE (store_id, email)`. So a till-invented row
has no natural primary key — and if that person later signs up online with the
same phone, **their signup collides with the row we invented for them**.

### SHIPPED — an unclaimed customer, and a claim on signup

**Migration.** `supabase/pos_13_customer_claim.sql` — ✅ **applied to
`storemink_staging` 2026-08-14** (all six FKs cascading; the guard passed).
`users.claimed_at timestamptz` (NULL = never had an account); till-created rows
get an id of `pos_<uuid>`, which the `text` PK already permits.

**★★ CORRECTED 2026-08-09, AFTER CHECKING THE LIVE SCHEMA. The note below said
"rewrite the id, or update both tables in the same transaction". Neither works.**
**SIX** tables reference `users.id` — `orders`, `customer_addresses`,
`product_reviews`, `blog_comments`, `blogs.submitted_by`, `user_group_members` —
and every one is **NOT DEFERRABLE** with `ON UPDATE NO ACTION`. The FK is checked
at the end of each STATEMENT, so both orderings fail: update the parent and the
children reference an id that is gone; update the children and they reference one
that does not exist yet.

**★ AND THE SCHEMA-FREE ALTERNATIVE IS WORSE.** "Insert the new row, repoint the
children, delete the `pos_` row" needs no migration — but **five of those six FKs
are `ON DELETE CASCADE`**. Miss one table in the repoint and the DELETE does not
fail; it silently cascade-deletes that customer's ORDERS. A seventh FK added next
year reintroduces it, and nothing tells whoever adds it that a hand-written list
exists.

So the migration puts `ON UPDATE CASCADE` on all six and lets the DATABASE keep
the list: adoption becomes one statement, and a future FK either cascades
correctly or fails loudly. `ON DELETE` is left exactly as it was — a different
question this migration has no business answering. The file ends with a guard
that FAILS if any FK to `users.id` still lacks the cascade.

**★ AN UNCLAIMED ROW CAN NEVER LOG IN, AND THAT IS AUTOMATIC.** Customer RLS is
`auth.uid() = users.id`; a `pos_…` id matches no Firebase uid, so these rows are
invisible to every session without a single new policy. Do not add one.

**★ THE CLAIM IS THE WHOLE FEATURE**, and it is ONE statement with every guard
in the `WHERE` (`lib/pos/claim-customer.ts`): store scope, the VERIFIED phone,
`id LIKE 'pos\\_%'`, `claimed_at IS NULL`, and `NOT EXISTS` a row for this uid.
Two signups racing on one walk-in row: the loser matches zero rows and falls
through to an ordinary insert. No lock, no window. Their in-store purchase
history becomes theirs the moment they create an account — the actual CRM payoff,
not a side effect.

**★ IT RUNS BEFORE THE UPSERT, AND HAS TO.** `(store_id, phone)` is UNIQUE, so
without the claim first, signup fails with a duplicate key for exactly the
customers who have shopped here before. Claiming turns that collision into the
feature. A claimed row is then an UPDATE, so `customer.signed_up` does not fire —
correct: the store already knows this person; what is new is the ACCOUNT.

**★ THE PHONE IS THE SECURITY BOUNDARY**, and it comes from the verified auth
identity, never a form. A form-supplied phone would let anyone type a stranger's
number and inherit their in-store order history. `normalizePhone` is shared by
both ends: if the till stores "+91 98765 43210" and signup stores "9876543210",
the claim never fires and the customer silently gets two rows.

**★ A COLLISION WITH A _CLAIMED_ ROW IS NOT A CLAIM.** If the matching row
already has `claimed_at`, that phone belongs to a real account — the till
attaches to it rather than adopting. Adopting would hand one customer's order
history to whoever typed their number. **`claimed_at IS NULL` alone is not
enough**: a real signup row has it NULL too, so the `pos_` id check is what stops
one account taking over another's.

**★ NEVER THROWS, at both layers.** A failed claim costs a link to in-store
history; a thrown one would cost the shopper their signup.

**UI.** The create form opens from the EMPTY search result, not a second button —
"Add customer" beside the search box invites a duplicate of someone already on
file. The typed query seeds whichever field it looks like. `sell`, not a manager
grant: recording who bought something is part of ringing up a sale.

**SHIPPED — receipt contact.** An optional email box on the tender panel
(`lib/email/pos-receipt.ts`). It deliberately does NOT feed the notification
spine: that routes an EVENT to IDENTIFIED recipients honouring preferences and
digests, and a walk-in has no identity — no `users` row, so no inbox, no
preferences, no digest. It is still a `sendEmail` call, so it lands in
`email_logs` and the CI send-coverage guard stays satisfied.
`shouldSendDirectReceipt` (pure) keeps it to exactly ONE receipt: it fires only
where the fan-out will not — no attached customer, or one with no address on
file, read in the same query as the ownership check. A bad address is dropped
rather than refused, because this runs after the money is taken. SMS waits for
Step 5.

**Acceptance:** PS-C.25–C.43 — **written, not yet exercised in a browser.**
117 unit tests cover the pure rules, the claim statement, the actions, the
signup ordering and the receipt; nobody has yet rung up a walk-in on a real
till.

---

## Step 5 — Receipts

**Email is DONE** — it shipped with Step 4, because capturing an address that
nothing sends to would be a field promising a receipt that never arrives.

### ★★ CORRECTED 2026-08-15, AFTER CHECKING TRAI'S RULES

**This step said "unlocking them is the work; the fan-out, the queue and the
templates exist." That is wrong, and wrong in a way that changes the design.**

TRAI's TCCCPR requires every business sending commercial SMS to an Indian number
to register on an operator-run **DLT** portal. Three things are registered, and
all three are per-BUSINESS, not per-platform:

1. the **Principal Entity** (a PE-ID),
2. the **sender header** — 6 characters, alphabetic for transactional,
3. **every message template**, with its variables marked.

A message whose body does not match an approved template, or whose header is not
registered to that entity, is **blocked at the carrier**. It does not bounce and
it does not error usefully — it simply never arrives. Registration takes
**7–21 business days**.

Three consequences, none of them optional:

**★ SMS IS BYO PER STORE, LIKE RAZORPAY (§18), NOT PLATFORM-WIDE LIKE EMAIL.**
StoreMink cannot send from a generic header, because the header IS the
merchant's registered identity. There is no "turn on SMS" switch that could ever
work on its own — which is why `available: false` must not simply be flipped.

**★★ IT BREAKS THE FREE-TEXT TEMPLATE MODEL.** §24's merchant templates are free
text with `{{token}}` substitution, validated only for unknown tokens. DLT is the
opposite: the body is FIXED at registration and only marked variables may vary.
An SMS body therefore cannot be authored in the notification console the way an
email body is — it is authored on the DLT portal, approved there, and MIRRORED
here with its template id.

**★ A SEGMENT IS A UNIT OF COST, AND ONE CHARACTER RE-PRICES A WHOLE MESSAGE.**
GSM-7 fits 160 characters; a single character outside that set — an emoji, curly
quotes, or **₹** — forces the entire message to UCS-2 at 70. A 150-character
template costs one segment until someone types a rupee sign, then three.

### Shipped — the pure rules

`lib/sms/dlt.ts` (+ 30 tests), which is all of the above that can be settled
without a provider account, a merchant registration or a phone:
`checkDltTemplate`, `renderDltBody` (positional, because `{#var#}` carries no
name), `bodyMatchesTemplate` (the carrier asks this, so we ask it first),
`normalizeSenderHeader`, and `smsSegments`.

⚠ Deliberately NOT encoded: the maximum variables per template, and whether a
variable may open a message. Operator documentation asserts these
inconsistently, and a rule invented here would reject templates the merchant's
own portal approved — leaving them unable to tell whose rule they broke.

### Decided 2026-08-15 — BYO per store

Merchants connect their own Twilio account in **Channels → Twilio SMS**.
StoreMink never fronts the carrier bill and never carries their spam risk.

**Shipped since:** the schema (`supabase/sms_01_schema.sql`, applied),
the Twilio client and the `lib/sms/send.ts` choke point with its coverage guard,
the Channels connection card, the SMS log as a sixth log plus a Failures source,
and the DLT template mirror actions. See CODEBASE §37.

### ✅ IT SENDS

All five remaining pieces shipped: the queue worker on the existing email
heartbeat, per-store channel resolution, phone resolution for both audiences,
the SMS tab in the notification console, and STOP enforcement. `available` is
now `true` — safe because it is a PLATFORM statement, while delivery is three
per-store conditions resolved at fan-out. See CODEBASE §37.

### ⚠ What is genuinely left

1. **An inbound webhook to RECEIVE STOP.** `classifyInbound` and `suppressPhone`
   are built and tested; nothing calls them. A merchant's Twilio number needs a
   messaging webhook pointed at us. Until then opt-out is ENFORCED on send but
   can only be RECORDED by hand — the wrong way round for the one part of this a
   regulator cares about.
2. **Nobody has sent a real message.** Every path is unit-tested against mocks;
   none has touched Twilio, and no merchant has a DLT registration to test with.
   The first real send is the first real test.

WhatsApp remains out of scope (owner, 2026-08-15). It needs no DLT but does need
Meta Business verification and Meta-approved templates, so it is a separate track
rather than a cheaper substitute.

---

## Step 6 — Channel stock policy _(LOC H)_

Per-location, per-channel reserve buffers: "never sell the last 2 online at this
shop", so the shelf can't be emptied by the website mid-afternoon. Rests on the
Phase E reservations, which is why it comes after them.

**Owner decision, 2026-08-18: it is CONFIGURABLE, not a hardcoded rule.** A
buffer that cannot be turned off is a rule about someone else's business, and
the right number differs per shop — a flagship holding two back is prudent, a
dark store holding two back is two units of dead stock.

**★★ BUT IT CANNOT BE A REGISTRY SETTING ALONE, AND THAT IS THE WHOLE DESIGN
PROBLEM.** `lib/settings/registry.ts` holds ONE value per STORE (convention #9).
This buffer is per LOCATION _and_ per CHANNEL, which the registry cannot
address — the same wall `products.returnable` hit in §28, where "only certain
products" turned out to be a column and not a setting. So it is two layers:

- **the store-wide default** in the registry (`inventory.onlineReserveBuffer`,
  section `locations`, default **0** — invariant 1, since any non-zero default
  would silently make every existing store stop selling stock it has);
- **the per-location override** on `store_locations`, alongside `capabilities`
  and for its reason: jsonb keyed by channel means a third channel is a registry
  entry rather than a migration plus a check to forget in every consumer.

**★ THE BUFFER BELONGS TO `available`, NOT TO `on_hand`.** Phase E already
defines `available = on_hand − reserved`; a buffer is a third subtrahend and
must land in the same place, or the two definitions drift and one of them is
what the storefront reads. Concretely `online_stock` becomes
`SUM(on_hand − reserved − buffer)` over online-fulfil locations, floored at 0.

**★ IT MUST NOT BLOCK THE TILL.** The buffer's entire purpose is to hold stock
BACK for the counter, so applying it to `placePosSale` would reserve units
against the very sale it exists to protect. It is an ONLINE-channel rule, and
the POS path must be tested to prove it ignores it.

---

## Step 7 — Transfer dispatch note _(LOC I — rescoped 2026-08-18)_

**★★ THE IN-TRANSIT STOCK BUCKET IS CANCELLED (owner, 2026-08-18).** The
original step is struck out below. A POS manages one location's stock, so a
transfer is two ordinary adjustments — Delhi counts it out, Mumbai counts it in
when the van arrives — and modelling a third place stock can "be" buys tracking
nobody asked for.

**What ships instead:** a **transfer note** — a printable document naming the
destination, the items and the quantities, generated when stock is counted out.

**★ IT IS A ROW FIRST AND PAPER SECOND, and that distinction is the whole
value.** A printed sheet with no record behind it cannot be received against:
the destination re-keys the quantities by hand, two people can both "receive"
the same delivery and double-count it, and a van that never arrives is
indistinguishable from a miscount at either end. So `stock_transfers` +
`stock_transfer_items` hold what was sent, and receiving CLAIMS the note —
a conditional UPDATE on `received_at IS NULL`, the pattern every exactly-once
path here already uses (the cancel-restock claim, `billing_claim_downgrade`).
The print view is then a view of the row.

**★ ACCEPT THAT TOTAL STOCK DIPS WHILE THE VAN IS MOVING, KNOWINGLY.**
`products.stock` is `SUM(on_hand)`, so counting out at Delhi before counting in
at Mumbai understates what the business owns for the length of the journey.
Two reasons this is tolerable, and one thing it means:

- for SELLING it is correct — `online_stock` counts only `online_fulfil`
  locations, and units on a van genuinely cannot be shipped from Delhi;
- the dip is visible and self-correcting the moment the note is received.
- ⚠ It means **"stock on hand" stops being an answer to "what do we own"**
  during a transfer. If that figure ever feeds a reorder decision or a valuation
  report, the open-note quantity has to be added back — which is the one job the
  cancelled in-transit bucket was doing for free. The note makes that quantity
  queryable, so the report can do it without a stock state.

**★ THE ATOMIC RPC STAYS FOR SAME-DAY MOVES.** `transfer_stock` commits both
legs in one transaction and is correct when someone carries a box between two
counters in the same building. Do not delete it; the note is the multi-day case,
not a replacement.

**~~Struck: the original in-transit design.~~** _An in-transit state so units
belong to neither shop's sellable count while they move, and `transfer_stock`'s
guard becoming `on_hand − reserved − in_transit`. Recorded so it is not
re-proposed as a new idea — and because if the ownership-reporting caveat above
ever bites hard enough, this is the design to come back to._

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

## Step 12 — POS payments: a gateway tender at the till ✅ DONE

**✅ Shipped.** `lib/payments/pos-gateway.ts` (start + verify, built only on the
three Razorpay calls already live in production since §18),
`startPosGatewayPayment` / `confirmPosGatewayPayment`, the Online method on the
tender pad, and `supabase/pos_15_gateway_tender.sql` (applied — the index is
present in both databases, verified 2026-08-18).

**★★ BOTH COUNTERS VERIFY, FROM ONE IMPLEMENTATION.** `verifyGatewayTenders`
holds the rule — reference present, not already used, then captured for the
exact amount — and is called by `placePosSale` before its order insert and by
`markCollected` before its claim. It shipped inline in the sell path first and
was extracted the moment the collection counter needed the same question
answered: this is a security check on a money path, and both actions are
independently reachable endpoints, so a second hand-written copy is how one
counter ends up settling against an unverified payment.

**★ `razorpay` LEFT `COUNTER_TENDER_METHODS` AND REJOINED IT.** It was removed
while only the sell path checked — accepting it at a collection would have
marked an order paid against money nobody confirmed was taken — and restored
once `markCollected` ran the same verify. A method belongs on an allowlist only
when the action behind it can SETTLE it. `store_credit` is still absent there,
its own spend being unwired; wire that in and the two lists finally merge.

**⚠ THE COLLECTION COUNTER CANNOT UNWIND.** At the sell counter a gateway clash
surfacing at the payments insert releases stock and deletes the order. At a
collection the claim has already committed and the customer is holding the
parcel, so the same clash is logged distinctly for a human to reconcile instead
of being dressed up as the ordinary lost-breakdown case.

The three server-side guards are mutation-checked, and so is the ORDERING at
the collection counter — moving its verify after the claim fails a test.

**★ `getLiveStoreGateway` MOVED TO `lib/payments/provider.ts`.** The three
conditions that decide whether a store may charge a card — connected, enabled,
plan — were private to `checkout-actions.ts`, and the till needed the same
answer. One implementation, two counters; it also gained the tests it never had
(a paused channel, an expired timed grant, an unreadable store row).
⚠ Its failure mode changed in the move: an unreadable store row now returns null
(offline-only, logged) instead of throwing out of `getCheckoutConfig` and taking
the checkout page with it. Fails closed on the money question either way.

**Owner, 2026-08-18: "right now only cash works properly."** That is the right
diagnosis of the symptom and it is worth being precise about the cause, because
half of this step turns out to be built already.

**✅ SPLIT PAYMENT IS DONE.** `lib/pos/tenders.ts` takes up to `MAX_TENDERS` (6)
tenders on one sale, and `settleTenders` derives coverage and change in PAISE.
The owner's example — a ₹500 bill settled ₹300 cash + ₹200 online — already
totals, balances and reconciles. Nothing about the split needs building.

**❌ WHAT IS MISSING IS THE GATEWAY LEG.** `card` and `upi` are, by the original
design (`docs/pos-plan.md` §7, decision 8), an EXTERNAL terminal: the shop
swipes on their own machine and the cashier types the amount and a reference.
StoreMink never talks to a gateway, so nothing is verified — the "payment" is a
number a human typed.

**★★ AND `razorpay` IS ON THE SERVER ALLOWLIST WITH NOTHING BEHIND IT.**
`TENDER_METHODS` includes it; `app/actions/pos-sale-actions.ts` contains no
gateway call at all, and `app/pos/sell/tender-panel.tsx` offers only cash, card
and UPI. So a `razorpay` tender is accepted, recorded and counted in shift
reconciliation as money the gateway never received. This is the exact reasoning
that file gives for keeping `gift_card` OFF the list — "a list the SERVER
accepts must never be wider than what the system can actually settle" — and it
is the one place that rule is currently broken. **Either wire it in this step or
remove it from the list; do not leave it as a third silently-unverified method.**

⚠ Note what this is NOT: a privilege hole. A cashier who can post `razorpay` can
already post `card`, so nothing new is reachable. The damage is to TRUTHFULNESS
— the Z-report claims gateway money that no gateway holds.

**Shipped.**

- A **`razorpay` tender that actually charges**, via the store's OWN BYO gateway
  — Razorpay Standard Checkout on the till, then confirmation before the sale
  completes. The merchant keeps 0% surcharge; the money settles directly to
  them, exactly as online checkout does.
- The tender panel gains the method, gated on a live gateway — a control that
  always fails in front of a customer is worse than no control (the
  `RegisterConfig.canDiscount` rule).
- Card/UPI stay external-terminal records and the panel now SAYS so
  ("Recorded from your own terminal"); Online says "Charged and verified with
  the gateway". Three buttons that looked equally trustworthy were the reason
  nobody noticed only one of them proved anything.

**★★ NO QR-CODE API, DELIBERATELY.** A UPI QR is the natural Indian counter
flow and Razorpay has an API for it — but it is provider surface this codebase
has never called, and §34 already records six unverified Razorpay facts. Every
call used here (`rzpCreateOrder`, `rzpFetchPayment`, `verifyCheckoutSignature`)
has run in production since §18. Standard Checkout offers UPI inside the modal,
so the customer can still scan; and because confirmation is a server-side read
of the PAYMENT, a QR presentation slots in later behind the identical verify.

**★★ THE AMOUNT IS NOT RE-PRICED FROM THE CART, AND THAT IS CORRECT.** A gateway
tender is one leg of a split — "₹200 of this on UPI" — so it is a number the
cashier typed, not a cart total. The cart's authority is enforced where it
belongs: `placePosSale` re-prices the whole sale, and `settleTenders` refuses a
non-cash tender above that total. Charging a cart-derived amount here would be
wrong for every split, which is the case this exists for.

**★★ THE REPLAY GUARD IS A SEPARATE PROBLEM FROM VERIFICATION.** A captured
payment stays captured, so re-presenting the same reference verifies perfectly
every time. Only "has this reference already settled a sale?" stops it paying
for two. That check is in the action AND in a partial unique index, because the
action's version is a read-then-write that two tills can both pass.

**★ THE SALE MUST NOT COMPLETE ON AN UNCONFIRMED CHARGE.** The goods leave the
shelf at the counter, so an optimistic "assume it worked" is unrecoverable in a
way online checkout's retry is not. Confirmation is a server-side read of the
payment, never a client callback — the §18 rule.

**★★ AND AN UNREADABLE GATEWAY IS REFUSED HERE, unlike online.**
`verifyCapturedCheckoutPayment` falls back to the HMAC when Razorpay cannot be
read, which is right for checkout: the order already exists as `pending` and a
sweep reconciles it. A till sale has no pending state — it is born `paid` — so
there is nothing to reconcile back from and an unverified completion is money
the shop may never have received. The customer's money is captured and safe
either way, so "we couldn't check, try again" is the honest answer.

**★ A HALF-TENDERED SALE HAS ITS EXIT.** A dismissed modal or a declined card
stages nothing, leaves the other tenders untouched, and says so — the cashier
takes the amount another way. A cancelled payment is an ordinary counter
outcome, not an error to recover from.

**⚠ THE WINDOW THAT IS NOT CLOSED.** Stock is reserved when the sale completes,
not when the payment is taken, so between "customer paid" and "Complete sale" a
concurrent till could take the last unit — the sale then fails with the existing
"only N left" against a captured payment, which the merchant refunds from the
dashboard (§26). Holding stock at payment time was considered and rejected for
the reason parking holds none: an abandoned hold strands stock and needs a
sweep. The window is seconds, at a counter, with the goods in the customer's
hand — but it is real, and it is why the failure message must name the payment.

---

## Step 13 — Return restock lands at the shop that took it ✅ DONE

**Owner, 2026-08-18**, and the scenario is exact: Delhi is a warehouse that
fulfils online, Mumbai is a shop doing counter sales, pickup and returns. Goods
handed back at Mumbai must land on **Mumbai's** shelf.

**✅ Shipped.** `lib/returns/restock-location.ts` (server-only reader +
`defaultRestockLocation`, pure, 6 tests), a `locationId` argument on
`receiveReturn` validated against that same list BEFORE the claim, the location
written into the claim statement, and a picker on the returns queue. Five new
action tests, both guards mutation-checked. `npm run test` and `test:shuffle`
both green at 4,583.

**★★ ONE CHANGE FROM THE SPEC ABOVE, AND IT MATTERS: THE FILTER IS
`receive_stock`, NOT `returns`.** This section originally said
"capability-filtered to `returns`". Writing it exposed that as wrong. The
`returns` capability means "a customer may hand goods back AT THIS COUNTER" —
it `requires: ["pos"]`, because someone has to be standing there — but a
POSTED return has no counter and goes to whatever address is on the label,
usually the warehouse. Filtering on `returns` would have made Delhi
unselectable for precisely the returns that physically arrive there, which for
an online store is the common case. So candidates are locations that can have
stock booked in at all (`receive_stock`: defaults true for every type, no plan
gate), and the returns desk is used only to pick the DEFAULT. In the owner's
scenario both shops are offered and Mumbai is preselected.

**✅ AT THE TILL, THIS IS ALREADY RIGHT.** `app/actions/pos-return-actions.ts`
restocks through `adjust_stock_at(p_location => op.locationId)` — the operator's
own location, resolved server-side. A BORIS return of an online order walked
into Mumbai already credits Mumbai. No change needed.

**❌ FROM THE DASHBOARD DESK, IT IS WRONG.** `order_returns.location_id` is
never populated by `app/actions/return-actions.ts` — there is no assignment
anywhere in the file — so `receiveReturn` takes the null branch and calls the
bare `adjust_stock` wrapper, which per §22 delegates to the store's **default
location**. The code says so plainly in a comment. In the owner's setup that is
Delhi: the parcel is physically in Mumbai, the books credit Delhi, and both
shops are wrong by the same quantity with nothing to flag it.

**Shipped.** A location on the receive step — picked by the merchant, written
to `order_returns.location_id` so the existing `adjust_stock_at` branch (already
there, already correct) is the one that runs.

**★ THE PICKER IS SCOPED, NOT FREE.** It respects `admin_locations` (§23) — a
branch manager choosing another branch's shelf is the same escape the orders
exporter had — and the action re-validates against the SAME list the picker was
built from. A dropdown is an affordance, not a permission.

**★ VALIDATION RUNS BEFORE THE CLAIM.** Claiming first and validating second
would flip the return to `received` with the goods booked in nowhere — and only
an `approved` return can be received, so the queue offers no way back. Pinned by
a test that asserts zero writes on a rejected location.

**★ THE WRITE IS A `coalesce`, NOT AN ASSIGNMENT.** It fills in an unknown and
never overwrites a recorded one: a till return already knows its own shop, and
that is a fact about where somebody physically stood, not a preference to be
corrected from a desk afterwards.

**★ DEFAULTING IS NOT THE SAME AS GUESSING.** One returns desk ⇒ default to it
and NAME it; several, or none with several candidates ⇒ ask outright, button
disabled until chosen. Silently picking the first would reproduce today's bug
with a nicer implementation. The success toast names the shelf, because that is
the last cheap moment to catch a wrong choice.

**★ A SINGLE-LOCATION STORE IS UNTOUCHED.** No picker, one click, and
`location_id` stays null so the default-location wrapper runs exactly as before
(invariant 1).

**★ DO NOT REACH FOR `resolveFulfilmentLocation`.** It answers "where would this
ship FROM", which is the wrong question for goods coming BACK — it filters on
`online_fulfil`, so in this very scenario it returns Delhi. It is used correctly
elsewhere in that file, for exchange replacement holds; that is not this.

**⚠ Existing rows are not backfillable.** Nothing recorded where past returns
physically arrived, so a migration would be inventing history. Fix forward and
leave the old rows on the default location.

---

## Step 0 — Platform → merchant billing rebuild _(XL, in progress)_

Spec: **`docs/billing-architecture.md`**. StoreMink billing its OWN merchants —
distinct from a merchant invoicing a shopper (§17) and from a merchant's BYO
gateway (§18). Greenfield: one live subscriber, so the cutover is a migration
rather than a project.

**Why it is a rebuild, not a fix.** Razorpay Subscriptions cannot be updated on
UPI or e-mandate — every amount change (tier, period, locations) goes through
`rzpUpdateSubscription`, so `changePlan` and `changeBilledLocations` are both
dead for most Indian merchants, and add-ons are deprecated. StoreMink computes
the amount; the gateway only collects it.

| Phase                                                | State                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| 1 · Architecture + the 13 defects it replaces        | ✅ done                                                              |
| 2 · Schema (`billing_01`…`06`) + 26-check verifier   | ✅ applied to staging                                                |
| 3 · Cycle maths, invoices, collection, renewal cron  | ✅ done                                                              |
| 3b · Enrolment + manual payment + `/dashboard/plans` | ✅ done — three-step purchase dialog + exact gateway cross-check     |
| 4 · Signup enrolment on the new system               | ✅ done                                                              |
| 5 · Buying an extra location on the new system       | ✅ done                                                              |
| 6 · Webhook processor off the request path           | ⏳ reconciliation is rollout fallback                                |
| 7 · Reconciliation detectors + dunning notifications | ✅ done (+ operator queue UI)                                        |
| 8 · AI-credit invoicing                              | ✅ done — one-time receipts finalize paid; legacy open rows repaired |
| 9 · Delete `subscription-actions.ts` + the rzp plans | ✅ done 2026-08-13                                                   |
| 10 · Autopay — mandate capture + recurring charge    | 🧪 **enabled for verification**                                      |

**★ AUTOPAY IS ENABLED FOR VERIFICATION, AND THE MANUAL SYSTEM REMAINS.**
`RECURRING_CHARGE_VERIFIED` is true as of 2026-08-16 for test-mode staging and
an empty production account. Missing credentials, absent/revoked mandates,
amounts above the mandate/AFA ceilings and incident rollback still issue an
invoice payable on `/dashboard/plans`; none is misreported as a failed debit.

**★★ AUTOPAY'S CODE PATH IS BUILT, BUT ITS RELEASE EVIDENCE IS NOT.**
`startEnrolment` can create the Razorpay customer and authorisation order;
`confirmEnrolment` reads the mandate token back from the verified PAYMENT, not
from the browser; and `chargeMandateViaRazorpay` creates a provider order,
persists that order id before debit, then calls the recurring endpoint. Unknown
outcomes remain in flight for reconciliation instead of being retried.

The enrolment window now passes the server-created Razorpay `customer_id` into
Checkout when a mandate is being registered. Every on-session StoreMink payment
also cross-checks the returned payment against Razorpay's read API for captured
status, order, INR currency and exact server-computed amount before granting the
plan, plan change, location or AI credits. A provider read outage retains the
already-verified HMAC path so a captured payment is not stranded or invited to
be paid twice.

Production returns the charge function when platform credentials are present.
The exact recurring request behaviour, provider-side idempotency support,
asynchronous event vocabulary and failure states are being verified through
`docs/autopay-verification.md`. The first rollout also persists the exact
authorised ceiling on the durable attempt (`billing_09`) and requires both owner
email and phone before offering a mandate, so a successful signup cannot create
an unusable automatic-renewal promise.

**★ THERE IS ONE BILLING SYSTEM NOW.** `subscription-actions.ts`,
`lib/payments/subscription.ts`, the `razorpay_plans` cache and the five
`rzp*Subscription` calls were deleted on 2026-08-13. The `store_subscriptions`
table remains as the old system's audit trail; nothing reads it.

**The migration turned out to be a no-op.** `store_subscriptions` was empty in
production by the time `billing_06` was applied, so there was nothing to move —
and the one live subscriber's gateway subscription had already been cancelled by
hand, which was the step that mattered.

---

## Also outstanding — unglamorous, worth scheduling

| Item                            | Why it matters                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalogue **delta** sync        | Every register re-pulls the whole catalogue every 5 min — O(catalogue), forever                                                                                   |
| Money-event **audit**           | All 6 `posAudit` sites are auth-only; discounts, overrides and till refunds leave none                                                                            |
| Analytics **dashboard rebuild** | Spec: `docs/analytics-and-search-console-plan.md` — metric contract → persistent editor → commerce widgets → Search Console; includes the missing location filter |
| Sale round trips                | `placePosSale` makes 11 separate transactions — 11 × RTT on the fastest path                                                                                      |
| Live **Razorpay** run           | Refunds and metered billing have never touched a real account                                                                                                     |
| `data_jobs` retention           | §32 prunes logs but not CSV job rows; needs two policies + two `created_at` indexes                                                                               |
| `billing_webhook_events` growth | One row per delivery, forever — not in `RETENTION_POLICIES`. One entry, no index needed                                                                           |

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

**★ An extra location is a PRICE RISE ON THE SAME STOREMINK BILLING
SUBSCRIPTION, not a second mandate.** The part-period amount is collected by a
verified one-time checkout; `billing_subscriptions.billed_locations` then feeds
every future invoice. Buying applies now and releasing waits for cycle end,
keeping refunds out of the system. Priced from the operator console
(`plan_prices`, key `extra_location`).

Traps, each already paid for: `changePlan` must carry the count through or the
merchant silently drops to the bare plan price while keeping every shop; the
count is absolute, never a delta; it is written only when the change is live; the
the mandate ceiling is checked before the gateway against the **full next
invoice** (base plan + every extra location + tax), and an active mandate whose
ceiling cannot be read fails closed; counts are refused, not clamped, in both
directions.

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

- **Pickup capability split: GO** (owner, 2026-08-09). No store has enabled
  `fulfilment.offerPickup`, so making "mark ready" manager-only takes nothing
  away from anybody — invariant 1 is satisfied because there is no live
  behaviour to preserve.

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

(none — all settled.)
