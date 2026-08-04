# POS & Locations — acceptance tests

Everything built across POS Phases 0–4 and Locations Phases A–F, as stories
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

**Status on staging:** all applied — `pos_00`–`pos_11` and
`locations_01`–`locations_09`. (`locations_07` added merchant postcode rules
and `locations_08` removed them again; both ran.)

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

**PS-2.7 — Rename a location**
Open a location → Details → change the name → Save details.
**Expect:** saved, and the heading and list both update. Type, address, GSTIN,
GST state code and receipt prefix are all editable on the same card and save
together — the location editor is the full page, matching the products
convention (edit is a page, only "New" is a dialog).

**PS-2.8 ★ — Saving details doesn't blank the rest**
Change only the name and save.
**Expect:** type, address and tax fields are unchanged. `updateLocation`
replaces the whole row, so a partial send would wipe them — and a missing type
would silently turn a warehouse into a shop.

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

**PS-6.6a ★★ — Only the owner may GRANT device trust**
Sign in as a delegated dashboard admin (a non-superadmin role with the POS
section) and try "Authorize this device", then try generating a pairing code.
**Expect:** both refused — _"Only the store owner can authorize a device."_ No
`pos_devices` row is written and no cookie is set. A device grant hands a
browser the lasting ability to take money, so it is not delegable. Redeeming a
code (`pairDevice`) is unchanged: the code itself is the authorization.

**PS-6.6b ★★ — But that same admin CAN revoke**
As the delegated admin, revoke a device from dashboard → POS → Devices.
**Expect:** it works. Revocation only ever takes trust away, and making the
owner the only person who can kill a stolen or cloned till would leave it live
for hours. The asymmetry is intentional and test-pinned.

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
**Expect:** a **5-minute** countdown ("Locking in 1:58"), then locked. Touching
the screen or "Stay" dismisses it. **Only the superadmin is exempt** — a
delegated dashboard admin locks like any operator.

**PS-6.11a ★★ — The lock actually locks a session-cookie actor**
Sign in with email + PASSWORD (staff), or as a delegated admin, and let the
timer run out.
**Expect:** you land on `/pos/login` and **STAY** there. Clearing the
`pos_operator` cookie alone would not do it — `resolvePosOperator` re-resolves a
session cookie and `/pos/login` sends a resolvable operator straight back to
`/pos`, so the lock would be a flash for exactly these people. `posLock` clears
`sm_session` too, which means **it also signs them out of `/dashboard`** — that
is the intended trade (the walked-away session is the risk) and the reason the
superadmin is exempt.

**PS-6.12 ★ — The warning never outruns the idle window**
Set `pos.idleLockMinutes` to 1 (its minimum) and leave the till.
**Expect:** the banner appears with 30s left, not immediately — the warning is
capped at half the window, so a short setting doesn't put it on screen
permanently.

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
As the owner, mark one line down (a damaged tin).
**Expect:** the receipt prints `2 × ₹100 … ₹200 / Less −₹30 = ₹170`, and the
line total is net of it.

**PS-7.4a ★ — Only the owner can discount (default)**
Sign in as a **cashier**, then as a **manager**. Look at the cart.
**Expect:** no "Discount ₹" field and no per-line "Less ₹" field for either.
Sign in as the owner (the store's superadmin): both are there.

**PS-7.4b ★ — And the server says no, not just the screen**
As a cashier or manager, call `placePosSale` directly with `orderDiscount: 50`
(or a `lineDiscount`).
**Expect:** refused — _"Only the owner can apply a discount."_ Both kinds are
blocked: "Less ₹50" per line is the same act as "Discount ₹50" on the sale.

**PS-7.4c ★★ — A manager's PIN cannot unlock it**
Repeat PS-7.4b with a genuine `approvalToken` (mint one by entering a real
manager PIN on the same cart).
**Expect:** STILL refused, and NO PIN prompt appears on screen
(`needsApproval` is never returned). The manager is one of the people being
kept out, so their own PIN must not be the key.

**PS-7.4f ★★ — Approval is a signed grant, not a claim**
Turn `pos.ownerOnlyDiscounts` OFF (so the cap machinery is live) and, as a
cashier, call `placePosSale` with `orderDiscount` over `pos.maxDiscountPercent`
and: (a) no `approvalToken`; (b) `approvalToken: "true"`; (c) a token minted for
a SMALLER discount; (d) a token minted for a different cart; (e) a token minted
at another location.
**Expect:** all five come back `needsApproval` and write nothing. Only a token
minted by `verifyManagerPin` for THIS cart, till and operator, inside 3 minutes,
completes the sale. Before this, `managerApproved: true` from the browser was
enough — the PIN pad was a UI step, not a gate.

**PS-7.4d ★★ — A price override is a discount, and is blocked too**
As a manager, call `placePosSale` with a line `priceOverride` well under the
listed price.
**Expect:** refused — _"Only the owner can change a price on a sale."_ Marking a
₹200 tin down to ₹1 is discounting it by ₹199; leaving this open would make
PS-7.4b decorative. `pos.allowPriceOverride` is a different question (may the
till reprice AT ALL — it stops the owner too); this is who.

**PS-7.4e ★★ — POS access is delegable; discounting is not**
Give a second dashboard admin a non-superadmin role that grants the POS section.
Sign in as them at `/pos` and try to discount or reprice.
**Expect:** refused. They resolve as `owner` (not `superadmin`) and run the till
normally otherwise — they can still sell, adjust stock, and authorize this
device. Without this split, "owner only" means "anyone ever given a dashboard
login with POS on".

**PS-7.5 ★ — Splitting a giveaway doesn't dodge the cap**
Turn `pos.ownerOnlyDiscounts` OFF (this is what re-arms the cap at all), set
`pos.maxDiscountPercent`, then split the same total discount across several line
discounts instead of one order discount.
**Expect:** still counted together, still needs a manager PIN above the cap.

**PS-7.6 — Manager override**
With `pos.ownerOnlyDiscounts` off, exceed the cap as a cashier (and separately,
send a `priceOverride`).
**Expect:** a manager PIN is required and recorded for both. A manager is exempt
from the cap (`discount_over_cap`).

**PS-7.6a — Repricing can be switched off outright**
Turn `pos.allowPriceOverride` off and send a `priceOverride` **as the owner**.
**Expect:** refused — _"Price overrides are turned off."_ It is a store policy,
not a permission, so it stops the owner too.

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

**PS-7.19 ★ — Tapping a product must not open the keyboard (iPad)**
On a tablet, tap several products into the cart.
**Expect:** the software keyboard NEVER appears — not on load, not on any tap.
Sticky focus on the search box is switched off wherever `hover: none` and
`pointer: coarse`, because iPadOS answers a programmatic focus by opening the
keyboard over half the till. A laptop with a touchscreen keeps sticky focus.

**PS-7.20 ★ — A tablet still scans, with nothing focused**
On that same tablet, with a paired hardware scanner and no field focused
(e.g. straight after tapping a product tile), scan a barcode.
**Expect:** the line is added. Turning sticky focus off must not cost a tablet
its scanner — a document-level wedge reads the burst instead.

**PS-7.21 ★ — A scan does not re-ring the tapped product**
Tap a product tile (it now holds focus), then scan a DIFFERENT product.
**Expect:** the scanned product is added, once. The wedge swallows the burst —
Space and Enter both activate a focused button, so an unhandled scan would add
the tapped item again.

**PS-7.22 — Typing a search is never intercepted**
Tap the search box and type a product name.
**Expect:** the characters go to the box and the grid filters. The wedge stays
out of the way whenever an editable element has focus.

**PS-7.23 — Overlays keep their own focus**
Open "Add customer" (or the tender panel) and type.
**Expect:** the field keeps focus. The register never pulls focus back to the
scan box while an overlay owns the screen.

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
**Expect:** cancelled, holds released, customer told. **Still no refund** — the
capability now exists (§10c), but wiring it into expiry is deliberately a
prompt, not an automatic payout on a schedule.

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

## 10b. Returns at the till

**PS-11.1 ★ — A cashier can't take a return**
Sign in as a cashier → Sales.
**Expect:** no "Return items" link, and `/pos/returns/<id>` refuses. Handing
money back is a manager capability, like every other way to give money away.

**PS-11.2 — Return part of a sale**
Sales → a sale → Return items → "All 2" on one line → Cash → Refund.
**Expect:** the refund equals that line's value plus its tax. Stock goes back at
this shop, the sale stays "completed" — the customer kept the rest.

**PS-11.3 ★ — The amount is recomputed server-side**
Post a quantity larger than was sold.
**Expect:** clamped to what remains; the refund is what those units were worth,
never a figure from the client.

**PS-11.4 ★ — A discounted sale doesn't over-refund**
Sell with an order-level discount, then return a whole line.
**Expect:** the refund is the line's value MINUS its share of that discount.
`order_items.total` is gross of the order discount while `tax_amount` is net of
it — refunding `total + tax` hands the discount back as well, on every
discounted sale.

**PS-11.5 ★ — A full return equals what was charged**
Return every line of a discounted sale.
**Expect:** exactly `orders.total`, to the paise. The discount is re-allocated
the way the sale allocated it, with the remainder given to the largest lines.

**PS-11.6 — Damaged units don't go back on the shelf**
Tick "Damaged — don't restock" on a line.
**Expect:** refunded, recorded as `damaged`, and stock is NOT increased.

**PS-11.7 ★ — You can't return the same unit twice**
Return 1 of 2, then reopen the sale.
**Expect:** "1 returned · 1 can come back", and a second return is capped at the
remaining unit.

**PS-11.8 ★ — Cash refunds leave the drawer**
Refund in cash, then open the shift.
**Expect:** a "Cash refunds" row, and expected cash reduced by it. Without this
the count comes up SHORT by the day's refunds — and a short drawer gets blamed
on a cashier.

**PS-11.9 — A card/UPI refund doesn't touch the drawer**
Refund the same amount as Card.
**Expect:** expected cash unchanged. The money went back through the shop's own
card machine.

**PS-11.10 — Returning everything marks the sale refunded**
Return every remaining unit.
**Expect:** the sale shows "Cancelled/Refunded" in the list and offers no
further return.

---

## 10c. Refunds from the dashboard (CODEBASE §26)

Money out. Run these in the order drawer on `/dashboard/orders`.
A Razorpay **test-mode** gateway is enough for all of them.

**PS-12.1 — A COD order offers no gateway button**
Open a `cash_on_delivery` order.
**Expect:** an explanation that there is no online payment to reverse, and only
"I paid them by hand". No dead Refund-online button.

**PS-12.2 — A manual refund demands a reference**
Choose "I paid them by hand", leave the reference blank, submit.
**Expect:** refused. The reference is the only evidence that row will ever
carry — the money moved somewhere this system cannot see.

**PS-12.3 — A full online refund**
Refund a paid Razorpay order, amount left blank.
**Expect:** the whole total goes back, the row shows `completed` with a
Razorpay refund id, and the order's payment status becomes `refunded`.

**PS-12.4 — A partial refund**
Refund ₹200 of an ₹840 order.
**Expect:** payment status `partially_refunded`, and ₹640 still refundable.

**PS-12.5 ★ — The cap holds**
After PS-12.4, try to refund ₹700.
**Expect:** refused, naming ₹640. The amount is recomputed server-side; the
client never says what is allowed.

**PS-12.6 ★ — A pending refund still counts**
With a refund sitting `pending`, try to refund the same money again.
**Expect:** refused. It has not settled but it might, and letting a second one
through is how the customer is paid twice.

**PS-12.7 ★★ — A timeout is not a failure**
Point the app at an unreachable Razorpay (block the host) and refund.
**Expect:** **no error toast.** The row stays `pending`, the panel says we're
checking, and the button is gone. This is the single most important behaviour
here: reporting a timeout as a failure is what produces a double refund.

**PS-12.8 — Reconciliation settles it**
Restore connectivity and reopen the order.
**Expect:** the pending row resolves against the gateway (matched by the key in
its `notes`, never by amount) with no further action.

**PS-12.9 — A rejection frees the money again**
Force a 4xx (refund more than Razorpay allows via a stale amount).
**Expect:** the row is marked `failed` and the amount becomes refundable again
— a verdict, unlike PS-12.7.

**PS-12.10 — A refunded order is still editable**
On a fully refunded order, change fulfilment status to `shipped`.
**Expect:** it saves. Payment status shows as a read-only pill, not a dropdown:
it is derived from the refunds that settled, never typed in.

**PS-12.11 — `delivered_at` doesn't restart**
Mark an order delivered, then move it to `processing` and back to `delivered`.
**Expect:** `orders.delivered_at` keeps its FIRST value. A return window must
not restart because someone corrected a status.

**PS-12.13 — Cancelling a paid order prompts for the refund**
Cancel a paid order from the dashboard.
**Expect:** the refund panel turns amber and names the amount owed. **No money
moves on its own** — that is the decision, not an omission.

**PS-12.14 — The prompt clears itself**
Refund that order.
**Expect:** the amber prompt is gone. It is derived from the order, not a
stored flag.

**PS-12.15 — An expired pickup says what's owed**
Let a PAID pickup order lapse, run `/api/cron/expire-pending-payments`.
**Expect:** the `order.pickup_expired` notification carries "Refund due
₹1,240.00" — formatted as money, not a bare number. A cron cannot prompt, so
it has to tell.

**PS-12.16 — Self-cancellation is off by default**
On a store that has never touched the setting, open `/orders/<id>`.
**Expect:** no cancel button. New behaviour never switches itself on.

**PS-12.17 — A shopper cancels in time**
Switch on Order Settings → customer cancellations. As the customer, cancel a
`pending` order placed an hour ago.
**Expect:** cancelled immediately, stock back on the shelf, the store notified.

**PS-12.18 ★ — A shipped order becomes a REQUEST**
Cancel an order already marked `shipped`.
**Expect:** "We've asked the store to cancel this order." The order is NOT
touched and no stock moves. The button must still be there — someone who wants
out after dispatch needs somewhere to say so.

**PS-12.19 — Past the window behaves the same**
With a 24-hour window, cancel a `pending` order placed 48 hours ago.
**Expect:** a request, not a cancellation.

**PS-12.20 ★ — The setting is enforced server-side**
Switch customer cancellations OFF, then call `cancelMyOrder` directly.
**Expect:** refused. A hidden button is not a permission.

**PS-12.12 — The team hears about it**
**Expect:** an `order.refund_issued` entry in `/dashboard/activity` and the
customer notified — the same event the till emits.

## 10d. Returns requested online (CODEBASE §28)

Switch on Order Settings → Accept returns first. Customer steps are on
`{slug}.storemink.com/orders/<id>`; merchant steps on
`/dashboard/orders/returns`.

**PS-13.1 — Nothing shows until the store opts in**
With Accept returns OFF, open a delivered order as the customer.
**Expect:** no Returns card at all.

**PS-13.2 — Request a return**
Switch it on, pick 1 of a 2-unit line, reason "Changed my mind", submit.
**Expect:** "We've asked the store to review", and the request appears in the
dashboard queue as Waiting.

**PS-13.3 ★ — The fee preview reacts to the reason**
Set a 10% restocking fee and ₹50 return postage. Toggle the reason between
"Changed my mind" and "Arrived damaged".
**Expect:** the deduction goes to ₹0 for damaged, with "this one's on us".
The customer must be able to SEE they aren't charged for the store's mistake.

**PS-13.4 ★ — Auto-approve does NOT cover a fault claim**
Switch on auto-approve. Request with "Changed my mind" ⇒ approved instantly.
Request with "Arrived damaged" ⇒ **still Waiting**.
**Expect:** exactly that. Otherwise anyone waives your fees with a radio button.

**PS-13.5 — A final-sale item can't be sent back**
Mark a product final sale in the product editor, then open an order containing it.
**Expect:** the line is shown, disabled, with "Final sale". Calling
`requestReturn` for it directly is refused.

**PS-13.6 — Past the window**
Set the window to 1 day and open an order delivered a week ago.
**Expect:** "The return window for this order has closed", no form.

**PS-13.7 — Not yet delivered**
Open a `shipped` order.
**Expect:** "You can return this once it arrives" — NOT "window closed".

**PS-13.8 ★ — Declining demands a reason**
In the queue, click Decline and try to submit an empty note.
**Expect:** refused, both in the form and by the server.

**PS-13.9 — The customer sees the decline reason**
Decline with "Past the 7-day window." and reload the customer's order page.
**Expect:** the note is shown verbatim under the request.

**PS-13.10 — Approve, then receive**
Approve a request, then click "Goods received".
**Expect:** status Received, and the product's stock goes UP by the returned
quantity. Check `/dashboard/inventory`.

**PS-13.11 ★ — A declined return frees its units**
Request 2 of a 2-unit line, get it declined, then request again.
**Expect:** both units are available again. A declined return that permanently
consumed the line would be the opposite of declining.

**PS-13.12 — Withdraw**
Request a return, then click Withdraw as the customer.
**Expect:** withdrawn. Do the same on an APPROVED one — refused.

**PS-13.13 — Receiving needs an approval first**
Call `receiveReturn` on a request still Waiting.
**Expect:** refused. Goods arriving for something nobody agreed to is a
conversation, not a stock movement.

**PS-13.14 — The refund is still a human decision**
After PS-13.10, open the order in the dashboard.
**Expect:** the refund panel shows what's owed. **Nothing was refunded
automatically** — that is the design, not a missing step.

## 10e. Exchanges (CODEBASE §28)

Needs a product with 2+ variants. Order Settings → Accept returns AND Offer
exchanges both on.

**PS-14.1 — The swap picker appears**
As the customer, open a delivered order and set a quantity on a line whose
product has other variants.
**Expect:** a "Refund me instead / Swap for …" dropdown appears under it.

**PS-14.2 ★ — An even swap settles to zero**
Swap for a same-price variant.
**Expect:** "Nothing to pay · ₹0.00", and the button reads "Request exchange".

**PS-14.3 ★ — A dearer swap is REFUSED before submitting**
Swap for a more expensive variant.
**Expect:** the blocked sentence naming the difference and telling them to
place a new order, and the submit button disabled. Calling `requestReturn`
directly is refused too.

**PS-14.4 — A cheaper swap owes the customer the balance**
**Expect:** the balance shown as coming back, and the request accepted.

**PS-14.5 — An out-of-stock variant can't be chosen**
Zero a variant's stock.
**Expect:** it shows "— out of stock" and is disabled. Calling with its id
directly is refused.

**PS-14.6 ★ — The replacement is HELD immediately**
Request an exchange, then check `stock_reservations`.
**Expect:** a `held` row with `owner_type = 'exchange'`, and the variant's
AVAILABLE stock down by the quantity while `on_hand` is unchanged.

**PS-14.7 ★ — Declining gives the units back**
Decline the request from the queue.
**Expect:** the reservation is released. Holding stock for an exchange that
will never happen makes that size unsellable to everyone else.

**PS-14.8 — Withdrawing does the same**
**Expect:** released.

**PS-14.9 ★ — Receiving raises the replacement ORDER**
Approve, then "Goods received".
**Expect:** a NEW order appears in `/dashboard/orders` with payment method
`exchange` and status `paid`, containing the swapped-for variant. The
returned line's stock goes UP; the replacement's `on_hand` goes DOWN exactly
once (the hold is committed, not re-reserved). The customer is notified.

**PS-14.10 — A plain refund return raises nothing**
Receive a return with no swaps.
**Expect:** no new order, no hold committed.

## 10f. BORIS — returning an online order at a counter (CODEBASE §28)

Needs: Order Settings → Accept returns AND "Accept online returns in your
shops" on, plus the location's **Accept returns** capability (Locations). Sign
in at `/pos` as a manager.

**PS-15.1 ★ — An online order is FOUND at all**
`/pos/returns`, search the online order's reference.
**Expect:** it appears, tagged "Bought elsewhere". Before this step the till
filtered by its own location and could never see one.

**PS-15.2 — Search by phone**
Search the customer's phone number instead.
**Expect:** the same order.

**PS-15.3 ★ — A card order shows NO cash button**
Open an online (Razorpay-paid) order.
**Expect:** no tender buttons at all — just "Refunded to the card or account
they paid with… 5–7 working days".

**PS-15.4 ★ — And the server refuses cash anyway**
Call `processReturn(orderId, lines, "cash")` directly.
**Expect:** refused. Cash back for a card sale is the card-not-present
laundering path.

**PS-15.5 — A COD order DOES offer the counter tenders**
**Expect:** Cash / Card / UPI, and cash reduces the drawer.

**PS-15.6 ★ — A gateway refund never touches the drawer**
Take a card-order return, then open `/pos/shift`.
**Expect:** expected cash is UNCHANGED. The `order_refunds` row has no
`shift_id` and no `location_id`.

**PS-15.7 — Stock lands at THIS shop**
**Expect:** the returning location's `inventory_levels.on_hand` goes up — not
the shop that sold it, and not the store default.

**PS-15.8 ★ — Turn the location capability off**
Untick "Accept returns" for this location and retry.
**Expect:** refused, naming Locations. Same when `returns.allowInStore` is off.

**PS-15.9 ★ — But this till's OWN sales still work**
With both BORIS switches OFF, return a sale rung at this register.
**Expect:** works exactly as before. Invariant 1 — the till has done this since
pos_12 and a later setting must not break it.

**PS-15.10 ★ — A failed gateway refund keeps the return**
Disconnect Razorpay in Channels, then return a card order.
**Expect:** the return SUCCEEDS with a warning telling the cashier to have the
owner refund from the dashboard. The customer handed the goods over — undoing
that would be worse.

## 10g. GST credit notes (CODEBASE §28)

Needs tax enabled (Invoices & Billing) with a tax class on the product.

**PS-16.1 — A settled refund raises a credit note**
Refund a taxed order from the order drawer.
**Expect:** a `CRN…` link appears on the refund row; opening it prints a
Credit Note naming the invoice it reverses.

**PS-16.2 ★ — A PENDING refund has no serial**
Force a gateway refund to stay pending (block Razorpay), then open the credit
note page for it.
**Expect:** an explanation, not a blank document and not a number. A serial
issued for a refund that then fails would leave a gap — which is exactly what
an audit flags.

**PS-16.3 ★ — …and gets one when it settles**
Restore connectivity and reopen the order so reconcile runs.
**Expect:** the refund settles and NOW has a serial.

**PS-16.4 ★ — Serials are consecutive per store**
Refund three taxed orders.
**Expect:** CRN…0001, 0002, 0003 for that store, with no gaps — and a second
store's series starts at its own 0001.

**PS-16.5 ★ — Exactly once, even if the status moves around**
Take a refund from completed → failed → completed (via the DB).
**Expect:** it keeps its ORIGINAL serial. A second one would leave the first
as a gap.

**PS-16.6 — No tax, no note**
Refund an order placed while tax was disabled.
**Expect:** the page explains there's no output tax to reverse. No serial is
consumed.

**PS-16.7 ★ — The tax splits the way it was charged**
Refund an intra-state order, then an inter-state one.
**Expect:** CGST+SGST columns on the first, IGST on the second, and the halves
re-summing exactly to the tax credited.

**PS-16.8 — A partial return credits only those lines**
Return 1 of a 2-unit line and refund it.
**Expect:** the note credits one unit, not the whole order.

**PS-16.9 — Fees retained show as their own line**
With a restocking fee configured, refund a change-of-mind return.
**Expect:** "Less fees retained" and a Refunded total below the credited value.

**PS-16.10 — Nobody else's note**
Open another store's refund id in the URL.
**Expect:** 404.

## 10h. Store credit (CODEBASE §29)

**PS-17.1 — Refund as store credit**
Refund a COD order, method "Store credit".
**Expect:** the refund row shows `Store credit`, no money moves, and the
customer's balance goes up by that amount.

**PS-17.2 — A walk-in can't be credited**
Open a POS sale with no customer attached.
**Expect:** no "Store credit" option. There is nobody to give a balance to.

**PS-17.3 — The balance shows at checkout**
Sign in as that customer and open `/checkout`.
**Expect:** a "Store credit" line under the total and a reduced "To pay now".

**PS-17.4 ★ — The order total is NOT reduced**
Place that order, then open its invoice.
**Expect:** the invoice shows the FULL goods value and the full tax. Credit is
a payment, not a discount — netting it off would understate the sale and
compute GST on the wrong base.

**PS-17.5 — `store_credit_used` records the split**
**Expect:** `orders.store_credit_used` = the amount applied, `orders.total`
unchanged, and the gateway charged only the remainder.

**PS-17.6 ★ — The unpayable-remainder gap**
Get a balance to within under ₹1 of an order total (e.g. ₹200 against ₹200.50)
and pay online.
**Expect:** checkout SUCCEEDS, charging ₹1, with a note that some credit was
held back. Razorpay refuses under ₹1, so applying the full ₹200 would fail.

**PS-17.7 — A fully-covered order collects nothing**
Have more credit than the order total.
**Expect:** payment method `store_credit`, status `paid`, no gateway call, and
COD does not tell the courier to collect anything.

**PS-17.8 ★ — Cancelling gives the credit back**
Cancel an order that used credit.
**Expect:** the balance is restored and the ledger shows a `reinstate` row —
distinct from `grant`, so reports can tell them apart.

**PS-17.9 ★ — …exactly once**
Cancel the same order twice.
**Expect:** the credit comes back ONCE. A second reinstate would mint money.

**PS-17.10 ★ — The balance can never go negative**
Spend the balance in one tab, then complete a second checkout that also
wanted it.
**Expect:** the second order charges the full amount. Checkout must NOT fail —
a race on an optional feature never refuses a sale (invariant 6).

**PS-17.11 ★ — Crediting the same refund twice credits once**
Trigger the refund confirmation twice (reconcile plus the callback).
**Expect:** one ledger row, one balance increase.

**PS-17.12 — Credit is per store**
Check the balance while browsing a DIFFERENT store's subdomain.
**Expect:** zero. Credit is the issuing merchant's money.

## 11. Known gaps

Real and deliberate, so nobody files them as bugs:

| Gap                                                            | Status                                                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cancel doesn't offer a refund**                              | Refunds themselves are BUILT (dashboard order drawer, gateway + manual — CODEBASE §26). What's left is wiring the prompt into cancel and pickup expiry; by decision it must prompt, never auto-pay |
| **The success page says nothing about collection**             | Right after paying — when they most want the address and the deadline — it shows only the order reference                                                                                          |
| **The dashboard is blind to pickups**                          | The orders list and detail drawer have no pickup awareness: office staff can't see that an order is a collection, nor its status. Only `/pos/pickups` can                                          |
| **The invoice shows a shipping address for a collected order** | `invoice-data.ts` and `InvoiceDocument` don't know `fulfilment_type`                                                                                                                               |
| **Pickup has never been run end to end**                       | No browser verification of PS-8.1–PS-8.20. Nothing blocks it now — the migrations are applied                                                                                                      |
| **`pos-pickup-actions.ts` has no test file**                   | Every other POS action has one                                                                                                                                                                     |
| **Analytics has no location filter**                           | Store-wide figures only                                                                                                                                                                            |
| **`order.pickup_expiring` email only**                         | No in-app pre-expiry banner                                                                                                                                                                        |
| **Offline selling**                                            | The catalogue is cached; completing a sale needs the server                                                                                                                                        |
