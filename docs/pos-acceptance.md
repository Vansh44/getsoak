# POS & Locations — acceptance tests

Everything built across POS Phases 0–4 and Locations Phases A–F.1, as stories
you can run against staging. **Keep this current: a phase isn't done until its
stories are here.**

- **Design detail:** `docs/pos-plan.md`, `docs/locations-ia.md`
- **What's next:** `docs/roadmap.md`
- **★ marks a story testing a non-obvious invariant** — something that looks
  right by accident and breaks silently. Those are the ones worth re-running
  after any refactor near them.

---

## 0. Before you can test anything

| Prerequisite                                                                              | Why                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Migrations `pos_00`–`pos_11`, `locations_01`–`locations_06`, `locations_08` as `postgres` | Column-not-found errors otherwise                                                          |
| Store on the **Pro** plan                                                                 | POS and Locations are Pro-gated                                                            |
| `POS_SESSION_SECRET` set                                                                  | Without it device authorization and PIN login refuse with a clear error rather than 500ing |
| `RESEND_*` configured                                                                     | Staff invitations and pickup emails go nowhere otherwise                                   |

**Status on staging:** `pos_00`–`pos_11` and `locations_01`–`locations_06`
applied; `locations_07` was applied and is now reverted by
**`locations_08`, which must be run.**

---

## 1. Plan gating & enabling POS

**PS-1.1 — A free store is told, not blocked from seeing it**
Sidebar on a free/basic store → Point of Sale.
**Expect:** an "Included in Pro" badge linking to `/dashboard/plans`. No POS
pages reachable.

**PS-1.2 — Pro store enables POS**
Pro store → sidebar → Point of Sale → "Enable POS".
**Expect:** the section expands to Overview + Settings + Staff + Devices.
`pos.enabled` flips on.

**PS-1.3 ★ — The plan gate is server-side**
With POS enabled, downgrade the store to Basic from the platform console.
**Expect:** POS pages stop working immediately. **Nothing is deleted** —
locations, staff and stock are all intact when you restore Pro. Soft-on-
downgrade: caps block NEW rows, never destroy existing ones.

**PS-1.4 — A single-location store never sees Locations**
Fresh Pro store with one location and POS off.
**Expect:** no Locations entry in the sidebar. It appears once the store has 2+
locations or POS is on.

---

## 2. Locations & capabilities

**PS-2.1 — Create a second location**
`/dashboard/locations` → add "Mumbai Shop", type Shop.
**Expect:** it appears in the list; a default-capability set is applied from its
type; the sidebar Locations entry is now visible.

**PS-2.2 — Capabilities are per location**
Open Mumbai → tick **Customer pickup**.
**Expect:** refused with _"Turn on Sell here first"_ until **Sell here** is
ticked. Someone has to physically hand the goods over.

**PS-2.3 ★ — A disabled checkbox is not a permission**
Turn off **Sell here** on a location that has **Customer pickup** on, and save.
**Expect:** pickup is stored OFF too — the cascade is applied server-side, so
stored state can never disagree with what `locationCan` reports.

**PS-2.4 ★ — The last fulfilling location can't be switched off**
Ensure exactly one location has **Fulfil online orders**, then try to untick it.
**Expect:** refused with _"This is the only location that fulfils online
orders."_ Otherwise the store advertises products it has no way to ship and
every checkout fails with no visible cause.

**PS-2.5 ★ — The backfill preserved behaviour**
On a store that existed before `locations_01`: check the default location.
**Expect:** **Fulfil online orders ON** (it describes what was already
happening), **Customer pickup and Accept returns OFF** (they introduce new
behaviour). A migration may not change what a live store does.

**PS-2.6 — Pickup and returns are Pro-only**
On a Basic store (if you can reach the page).
**Expect:** a padlock on Customer pickup and Accept returns.

---

## 3. Location scope — staff see only their location

**PS-3.1 — An unbound admin sees everything**
`/dashboard/locations` → Admin access → leave an admin with no locations ticked.
**Expect:** they see every location's orders and inventory. **Absence is not
restriction.**

**PS-3.2 ★ — A bound admin sees only their shop**
Bind an admin to Mumbai only. Sign in as them.
**Expect:** `/dashboard/orders` shows only orders routed to Mumbai;
`/dashboard/inventory`'s location selector offers only Mumbai.

**PS-3.3 ★ — Naming another location in the URL is refused**
As that Mumbai-bound admin, hit `/dashboard/inventory?location=<pune-id>`.
**Expect:** refused server-side, not just hidden in the UI.

---

## 4. Inventory — the dashboard

**PS-4.1 — A single-location store sees no selector**
**Expect:** `/dashboard/inventory` looks exactly as it did before multi-location.

**PS-4.2 — "All locations" is read-only**
Multi-location store → select **All locations**.
**Expect:** totals shown, editing disabled. You cannot adjust a sum.

**PS-4.3 ★ — A correction is computed against THAT shelf**
Product with 10 in Mumbai and 5 in Pune (total 15). Select Mumbai, set stock to 8.
**Expect:** Mumbai becomes 8, Pune stays 5, total 13. **Not** a delta computed
against 15 — that would write a wildly wrong correction.

**PS-4.4 ★ — A shop that never carried a SKU counts as zero**
Bulk-adjust a SKU at a shop that has never stocked it.
**Expect:** it's stocked from zero, not skipped. That's the normal case when
opening a new shop.

**PS-4.5 — Ledger**
Any adjustment → open the history drawer.
**Expect:** an append-only row with quantity, reason, actor and location.

---

## 5. Inventory — from the shop floor (`/pos/inventory`)

**PS-5.1 — A cashier can't**
Sign in as a cashier → `/pos/inventory`.
**Expect:** refused. A cashier sells stock; they don't declare how much exists.

**PS-5.2 — Receive / correct**
As a manager: search or scan a product → receive +10.
**Expect:** on-hand at the operator's own location rises by 10; a ledger row is
written.

**PS-5.3 ★ — A count is stored as a DELTA**
Count a product to an absolute figure while a sale for it is rung on another
till.
**Expect:** the sale is not erased — the count goes through the same atomic
adjustment and leaves a normal ledger row. A count that matches writes nothing.

**PS-5.4 ★ — A transfer is atomic**
Send 5 units from Mumbai to Pune.
**Expect:** Mumbai −5 and Pune +5, with paired `transfer_out` / `transfer_in`
ledger rows. Both legs commit or neither does — one plpgsql transaction, so
units can never cease to exist on the store's books.

**PS-5.5 ★ — Two managers can't both move the last units**
Two managers transfer the last 5 units simultaneously.
**Expect:** one succeeds, one is refused. The source decrement is conditional on
having the stock.

**PS-5.6 — A correction to zero still alerts**
Manually correct a tracked SKU to 0.
**Expect:** the out-of-stock notification fires, exactly as if a sale had
emptied it.

---

## 6. Staff, devices & the register shell

**PS-6.1 — Invite a cashier**
`/dashboard/pos/staff` → invite by name, email, role, locations.
**Expect:** an email arrives with a `/pos/register?token=…` link. **The admin
never sets or sees a PIN.**

**PS-6.2 — Self-registration**
Open the link → password twice → phone OTP → 8-digit PIN twice.
**Expect:** account created, status invited → active, token consumed. Re-opening
the link now fails.

**PS-6.3 ★ — Staff are bounced out of the dashboard**
As that cashier, visit `/dashboard`.
**Expect:** redirected to `/pos`. The role claim in the session cookie is what
does this — no DB query in the proxy.

**PS-6.4 — Login, both modes**
`/pos` → email + PIN, and email + password.
**Expect:** both work. PIN mints the `pos_operator` cookie; password uses the
standard session.

**PS-6.5 ★ — A cashier cannot sell from an unauthorized browser**
Sign in as a cashier in a fresh private window.
**Expect:** refused with a pairing prompt, not a sale screen. Owners are not
device-restricted.

**PS-6.6 — Authorize a device**
As owner on the till: "Authorize this device". Or dashboard → Devices →
generate a code → enter it at `/pos`.
**Expect:** authorized; the code is single-use and expires in 10 minutes.

**PS-6.7 ★ — A copied cookie is detected**
Copy the `pos_device` cookie to another browser and use it after the original
signs in again.
**Expect:** the device is revoked and `device_clone_detected` appears in
`/dashboard/pos/devices`. A valid signature can't catch a clone — the rotating
nonce can.

**PS-6.8 ★ — Revoking ends the session at once**
Revoke a device while its operator is mid-session.
**Expect:** their next request fails. The cookie is never trusted for
authorization — `pos_staff` is re-read on every resolve.

**PS-6.9 — Deactivating a staff member ends their session**
Same, via Staff → deactivate.
**Expect:** signed out on the next request, not when the token lapses.

**PS-6.10 — Forgot PIN or password**
`/pos` → "Forgot PIN or password?" with a real address, then a bogus one.
**Expect:** identical success message both times (enumeration-safe); only the
inbox differs. The link is single-use, 1 hour.

**PS-6.11 — Idle auto-lock**
Sign in with a PIN, leave the till for `pos.idleLockMinutes` (default 10).
**Expect:** a 20-second countdown, then locked. Owners are exempt.

---

## 7. The register (`/pos/sell`)

**PS-7.1 — Scan and sell**
Scan a barcode (hardware scanner, or camera on mobile).
**Expect:** the line is added in well under a second. Unknown code → a clear
miss, and the server is asked before giving up (a product created since the last
sync must stay sellable).

**PS-7.2 ★ — The quoted total is the charged total**
Add items on a taxed product, and note the total on screen. Complete the sale.
**Expect:** identical. Tendering exactly the quoted amount is accepted, and
change is calculated from that same figure. Both sides call `posTotals`.

**PS-7.3 ★ — Money compares in paise**
Tender the exact total on a cart whose total has a fractional component.
**Expect:** accepted as paid in full. A rupee-float compare would refuse an
exactly-covering payment.

**PS-7.4 — Line discount**
Mark one line down (a damaged tin).
**Expect:** the receipt prints `2 × ₹100 … ₹200 / Less −₹30 = ₹170`, and the
line total is net of it.

**PS-7.5 ★ — Splitting a giveaway doesn't dodge the cap**
With `pos.maxDiscountPercent` set, split the same total discount across several
line discounts instead of one order discount.
**Expect:** still counted together, still needs a manager PIN above the cap.

**PS-7.6 — Manager override**
Exceed the cap.
**Expect:** a manager PIN is required and recorded.

**PS-7.7 ★ — Prices are re-read server-side**
Tamper with a price in the client before completing.
**Expect:** the server's price wins. The catalog cache is never authoritative.

**PS-7.8 — Sold-out sinks**
Take a product to zero.
**Expect:** it moves to the end of the grid and is disabled — the ordering and
the disabled state agree because they share one definition.

**PS-7.9 — Register layout**
As manager: "Edit layout" → drag products from the left panel into the grid.
**Expect:** an in-place slide-over (not a new page), finger-draggable, showing
"12 of 20 products". Cashiers don't see the button.

**PS-7.10 ★ — Layout never makes a product unsellable**
Leave products out of the layout, then search for one.
**Expect:** found and sellable. The layout decides the IDLE grid only.

**PS-7.11 ★ — Restocking restores the manager's position**
Restock a sold-out product that had sunk to the end.
**Expect:** back in its configured slot with no edit. The shift is computed at
render, never written back.

**PS-7.12 ★ — No layout row = the whole catalogue**
A location that has never configured a layout.
**Expect:** every product shows. The feature cannot blank a till that predates
it, and a failed read degrades to everything rather than an empty screen.

**PS-7.13 ★ — A register sale emits like a sale**
Complete a sale that empties a SKU.
**Expect:** an entry in `/dashboard/activity`, the team notification fires, and
the low/out-of-stock alert fires. An in-store sale is a sale.

**PS-7.14 ★ — Cancelling a POS sale restocks at ITS OWN shop**
Sell from Mumbai, then cancel that order from the dashboard.
**Expect:** Mumbai regains the units. **Not** the default location — that would
silently compound an error on every cancellation.

**PS-7.15 — Attach a customer**
Search by phone/name/email.
**Expect:** only existing customers of this store. The till cannot create one.

**PS-7.16 ★ — A foreign customer is refused**
Attempt a sale against another store's customer id.
**Expect:** refused server-side. They hold RLS SELECT on their own orders and
would otherwise see a foreign order in their history.

**PS-7.17 — GSTIN on the bill**
Enter a business buyer's GSTIN.
**Expect:** format-validated, uppercased, printed. It works with no customer
attached.

**PS-7.18 — Offline-ish speed**
Throttle the network to slow-3G and search the catalogue.
**Expect:** search still instant — it's served from the local IndexedDB cache.
Completing a sale still needs the server.

---

## 8. Pickup — click & collect

**PS-8.1 — Turn it on**
Locations → Online fulfilment → Checkout → "Offer pick up in store"; give a
shop the **Customer pickup** capability.
**Expect:** the option appears at checkout.

**PS-8.2 ★ — A pickup HOLDS, it does not sell**
Place a pickup order for a tracked product.
**Expect:** the shop's **on-hand is unchanged** and `reserved` rises. The goods
are still physically on the shelf; selling them on screen would make the shop
reorder stock it already has.

**PS-8.3 ★ — Available excludes someone else's hold**
With 1 unit left and it held for another customer's collection.
**Expect:** that shop is shown but disabled — _"Not everything in your bag is in
stock here."_ Offering it is how two people get promised the same box.

**PS-8.4 — Collect it**
`/pos/pickups` → Mark ready → Hand over.
**Expect:** the customer gets the ready notification; on hand-over the holds
commit (on-hand finally drops) and the order leaves the queue.

**PS-8.5 ★ — Cancelling a pickup does NOT restock**
Cancel a pickup order from the dashboard.
**Expect:** the holds are released and on-hand is **unchanged**. Restocking
would add units that never left. Cancel twice — the second is a no-op.

**PS-8.7 — Ship / Pickup toggle**
Storefront checkout with pickup on.
**Expect:** a two-button Ship / Pickup control ABOVE the address, like ALDO. Ship
shows the address form; Pickup shows "There are N locations with your items",
one shop card with its full address, and "N more locations".

**PS-8.8 — The location picker**
Tap "N more locations".
**Expect:** a dialog with a search box, a radio list of every shop (address +
FREE), and Save. Type a postcode or city — the list narrows. Out-of-stock shops
are last and disabled.

**PS-8.9 ★ — Pickup is offered to everyone**
Check out from any address, anywhere.
**Expect:** the Pickup option is always shown when a shop can hand the basket
over. Geography is the SHOPPER's business — they know whether they collect near
home, near work, or on a route; a delivery postcode never decides for them.

**PS-8.10 — The summary drops shipping**
Choose Pickup.
**Expect:** the order summary row reads "Pickup in store", not "Shipping".

**PS-8.6 ★ — The confirmation says where to go**
Check the pickup order's confirmation email and `/orders/[id]`.
**Expect:** the shop's name and the deadline, not a delivery address they never
gave. A delivery order's email is unchanged.

**PS-8.13 — Billing address**
Ship → the Billing Address card.
**Expect:** "Same as my delivery address" ticked by default. Untick it and a
form appears; the entered address prints as **Bill To** on the invoice while
Ship To stays the delivery address. Ticked ⇒ nothing stored, and the invoice
falls back to shipping as it always did. The card does not appear for a pickup —
there is no delivery address for it to differ from.

**PS-8.14 — Three stores, then "See all N"**
Pickup with 7 pickup-capable shops.
**Expect:** three shop cards inline with address and "Ready …", then
"See all 7 stores" opening the searchable dialog.

**PS-8.15 — Pickup details**
Select a store.
**Expect:** a summary block — Collect from / Address / Ready — so what was
agreed to is visible before placing the order. The hold window is NOT shown:
it's the merchant's expiry policy, not something a shopper needs at the moment
of buying.

**PS-8.20 ★ — A date, not a countdown**
Set ready days to 2, then to 0.
**Expect:** 2 ⇒ every store card reads "Ready Fri, 1 Aug" — an exact date, not
"in 2 days" for the shopper to work out on a calendar. 0 ⇒ **"Available today"
in green**, on the cards and in the details row, because same-day is the thing
someone chooses collection FOR. The date is formatted server-side off the same
clock that stamps `pickup_ready_at`, so the date quoted is the date stored.

**PS-8.16 ★ — Pay at store replaces COD**
Choose Pickup.
**Expect:** the cash option reads "Pay at store · Pay at the counter when you
collect", the button reads "Place Order (Pay at store)", and the order stores
`payment_method: pay_at_store`. Choosing it for a DELIVERY order is refused
server-side — otherwise an order could be placed that nobody ever pays for.

**PS-8.17 ★ — Handing over settles the payment**
Collect a pay-at-store order at `/pos/pickups`.
**Expect:** payment_status flips pending → paid. An order already paid online is
untouched, and a failed payment is not marked paid by a hand-over.

**PS-8.18 ★ — The hold starts when it's READY**
Set ready = 3 days, hold = 5 days, place a pickup order.
**Expect:** `pickup_expires_at` is 8 days out, not 5. Otherwise a slow shop eats
the customer's collection window, and the busier the shop the shorter it gets.

**PS-8.19 — The confirmation email names the right address**
Place one delivery order and one pickup order.
**Expect:** delivery says where it's going; pickup says which shop, its address
and when it'll be ready. Neither carries the other's rows.

**PS-8.11 — Expiry**
Let a pickup pass `pickup_expires_at`, then run
`/api/cron/expire-pending-payments`.
**Expect:** cancelled, holds released, customer told. **No refund** — that's
deliberate until returns lands.

**PS-8.12 ★ — The nudge fires once**
Run the cron twice with an order 20 hours from expiry.
**Expect:** exactly one reminder. The claim on `pickup_warned_at` is what
guarantees it, not the schedule.

---

## 9. Shifts & cash (`/pos/shift`)

**PS-9.1 — Open with a float**
Open a shift with an opening float.
**Expect:** open; the equation is shown, not just the answer.

**PS-9.2 ★ — One open shift per LOCATION**
Two managers at the same shop tap Open simultaneously.
**Expect:** one wins; the other gets a friendly "already open", not a raw
constraint error. Enforced by a partial unique index, not app logic.

**PS-9.3 ★ — Change is subtracted once**
Settle a sale with TWO cash tenders, then close the shift.
**Expect:** expected cash is correct. The change is written onto every cash
tender row, so summing would deduct it twice and report the drawer short every
time — which gets blamed on a cashier.

**PS-9.4 ★ — A sale lands in the shift it was rung in**
Ring a sale seconds before closing.
**Expect:** counted in that shift. Stamped at sale time, not inferred from a
time window.

**PS-9.5 — Close and reconcile**
Count the drawer and close.
**Expect:** variance = counted − expected, flagged against
`pos.cashVarianceTolerance`. A second close is refused.

**PS-9.6 ★ — A closed shift's figures are frozen**
Edit an order that was in a closed shift, then re-open the Z-report.
**Expect:** unchanged. Snapshotted at close.

**PS-9.7 — A cashier can't declare the drawer**
As a cashier.
**Expect:** can sell into the drawer, cannot open/close or bank cash.

---

## 10. Online orders & routing

**PS-10.1 ★ — Orders route to a location with stock**
Two shops, stock only in the second, both fulfil online.
**Expect:** the order reserves at the second and stamps `location_id`.

**PS-10.2 ★ — Routing never refuses a sale**
Break the fulfilment rules (no rules row, or no eligible location).
**Expect:** the order still completes against the default location. Routing must
never be the reason a sale fails.

**PS-10.3 ★ — The storefront promises only what it can ship**
Stock at a location WITHOUT "Fulfil online orders".
**Expect:** the website shows it out of stock (`online_stock`) while the
dashboard shows the total (`stock`). Then enable the capability.
**Expect:** the website updates without touching the SKU — a trigger recomputes
on the capability change.

---

## 11. Known gaps

Real and deliberate, so nobody files them as bugs:

| Gap                                                            | Status                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No refunds anywhere**                                        | Cancel returns stock and notifies; the money must be refunded by hand in Razorpay. Blocks returns and pickup-expiry refunds — first item on the roadmap                                                            |
| **Location address is never collected**                        | The editor asks for name/type/GSTIN/state only, so the checkout card, the confirmation email and the order page all name a shop with **no address** — a collect-in-store feature that can't say where the store is |
| **The pickup emails use generic copy**                         | `order.ready_for_pickup` / `order.collected` / `order.pickup_expiring` have no `CUSTOMER_INTRO` entry, so the most important message in the feature opens "There's an update on your order"                        |
| **The success page says nothing about collection**             | Right after paying — when they most want the address and the deadline — it shows only the order reference                                                                                                          |
| **The dashboard is blind to pickups**                          | The orders list and detail drawer have no pickup awareness at all: office staff can't see that an order is a collection, nor its status. Only `/pos/pickups` can                                                   |
| **The invoice shows a shipping address for a collected order** | `invoice-data.ts` and `InvoiceDocument` don't know `fulfilment_type`                                                                                                                                               |
| **Pickup has never been run end to end**                       | Blocked on `locations_07`; no browser verification of PS-8.1–PS-8.12                                                                                                                                               |
| **`/dashboard/locations` errors until `locations_07`**         | Applies to staging right now                                                                                                                                                                                       |
| **`pos-pickup-actions.ts` has no test file**                   | Every other POS action has one                                                                                                                                                                                     |
| **Analytics has no location filter**                           | Store-wide figures only                                                                                                                                                                                            |
| **No dashboard view of pickup orders**                         | Only `/pos/pickups`; the orders list doesn't distinguish them                                                                                                                                                      |
| **`order.pickup_expiring` email only**                         | No in-app pre-expiry banner                                                                                                                                                                                        |
| **Offline selling**                                            | The catalogue is cached; completing a sale needs the server                                                                                                                                                        |
