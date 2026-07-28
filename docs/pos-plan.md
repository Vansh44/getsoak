# StoreMink Point of Sale (POS) — Technical Design & Implementation Plan

> An omnichannel, settings-based POS that unifies the online storefront with
> physical retail. Built on StoreMink's existing multi-tenant, Cloud-SQL/Drizzle,
> RLS, service-role-RPC, settings-registry and BYO-payment conventions.
>
> **Status:** DESIGN COMPLETE — ready to implement. This doc is authoritative.
> Work happens on branch `pos`.
>
> **Design goals (owner):** the best POS on the market — **least checkout time,
> fastest login**, fully robust, everything settings-based.

## Owner decisions (locked 2026-07-24)

| #   | Decision                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | POS is served at **`{slug}.storemink.com/pos`** — a **separate app shell** from `/dashboard`, with its own auth gate.                                                                                                                                           |
| 2   | **Pro plan only.** Free/basic see an "Included in Pro — upgrade" state in the sidebar.                                                                                                                                                                          |
| 3   | Pro includes **2 POS locations**; each additional location is **₹1,000/mo**. v1 **gates at 2** (adding a 3rd shows upgrade/contact); the recurring charge is a fast-follow (Phase 7).                                                                           |
| 4   | Inventory is **multi-location** from day one (`inventory_levels` is truth; `products.stock` becomes a trigger-maintained aggregate so the storefront is untouched).                                                                                             |
| 5   | POS staff auth = **invited accounts**: admin adds name/email/role → emailed link → staff self-registers (phone OTP + password + own 8-digit PIN). Login is **email + PIN or email + password**. Staff may only sign in on an **owner-authorized device**.       |
| 6   | New POS roles **cashier** and **manager**, both **blocked from `/dashboard`** (only `/pos`). Managers are **location-bound** and auto-scoped on login (m1→Delhi, m2→Mumbai). Managers manage their location's inventory from a **POS-native** inventory screen. |
| 7   | **Full India GST place-of-supply**: CGST/SGST intra-state, **IGST** inter-state, **per-location GSTIN** (state-wise registration).                                                                                                                              |
| 8   | Receipts print to a **thermal printer** (80mm) via the **OS driver / browser print** in v1 (any driver-backed printer, zero hardware integration); raw ESC/POS is a follow-up.                                                                                  |
| 9   | Merchants **scan existing supplier barcodes** (new `barcode` field they populate) — StoreMink does **not** print Luhn-SKU barcodes.                                                                                                                             |
| 10  | Receipts also deliverable via **Twilio (WhatsApp/SMS)** as a fast-follow (Phase 6) behind a channel/provider abstraction so **Meta** slots in later.                                                                                                            |
| 11  | **Offline** deferred to Phase 9 as an IndexedDB outbox (server-authoritative replay; **no CRDT**).                                                                                                                                                              |

---

## 0. Table of contents

1. Current state (verified in code)
2. Architecture overview & the three app surfaces
3. Auth & identity model (hybrid: accounts + device + PIN)
4. Data model (all new tables + column adds)
5. Inventory: locations & the aggregate cache
6. GST place-of-supply engine
7. The sell path (`placePosSale`) + tenders
8. Thermal receipt
9. Settings, roles, plan gating & the sidebar enable flow
10. Performance: "least checkout time / fastest login"
11. Phased execution (file-by-file)
12. Testing & risks
13. Conventions checklist
14. Remaining owner inputs

---

## 1. Current state (verified in code)

| Area         | Today                                                                                                                                                                                                                                                                                | POS reuse                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Inventory    | `products`/`product_variants`: `track_inventory`, `stock` (single int), `low_stock_threshold`, `allow_backorder`, `sku`. Append-only `stock_movements`. Atomic `reserve_stock`/`release_stock`/`adjust_stock` (`supabase/inventory_rpc.sql`). `lib/inventory/status.ts` pure status. | Add `p_location` to RPCs; `inventory_levels` becomes truth; keep `stock` as aggregate.                              |
| Orders       | `orders`/`order_items` (`supabase/orders_table.sql`). `customer_id` **NOT NULL** (FK `users`), `shipping_address` **NOT NULL**. Single `payment_method`/`payment_status`. `stock_status` restock-once claim. `order_no`/`order_ref` via triggers (`identifiers_04_triggers.sql`).    | Relax nullability; add channel/location/register/shift/cashier + GST cols; add `order_payments`.                    |
| Checkout     | `placeOrder` (`app/actions/checkout-actions.ts`): re-price store-scoped, coupon+stock reserve, tax via `computeTax`, service-role writes, full reverse rollback.                                                                                                                     | `placePosSale` mirrors it exactly.                                                                                  |
| Order admin  | `getOrders`/`getOrderDetail`/`updateOrderStatus` (`app/actions/order-actions.ts`), gated `getManagerIdentity("orders")`.                                                                                                                                                             | POS orders show here, filtered by `sales_channel`.                                                                  |
| Tax/billing  | `computeTax` pure (`lib/billing/tax.ts`), `tax_classes`, `store_billing_settings` (public-read; NO secrets). Printable `InvoiceDocument`.                                                                                                                                            | GST split layer on top of `computeTax`; new thermal receipt.                                                        |
| Payments     | BYO Razorpay per store (`store_payment_providers`, AES-256-GCM, `lib/payments/*`, `getStoreGateway`). Platform Razorpay + `storeSubscriptions` autopay for plans (`app/actions/subscription-actions.ts`).                                                                            | Card/UPI tender = the store's own gateway (0% surcharge). Extra-location billing extends the plan subscription.     |
| Settings     | `lib/settings/registry.ts` — per-store keys, `minPlan` gates, per-feature settings pages, server-enforced. `stores.settings` is **anon-readable** (no secrets).                                                                                                                      | New `pos.*` keys, section `pos`, page `/dashboard/pos/settings`.                                                    |
| Roles/access | `SECTIONS` + `can()` + `getManagerIdentity(section)` (`app/dashboard/lib/permissions.ts`, `access.ts`). RLS helper `is_store_admin(store_id)`.                                                                                                                                       | New `pos` dashboard section; **POS roles (cashier/manager) are a separate model** (`pos_staff`), not `roles` slugs. |
| Plans        | `lib/plans.ts` — free/basic/pro, `PLAN_LIMITS`, `effectivePlan` (expiry-aware).                                                                                                                                                                                                      | Add `posEnabled` (pro) + `posLocationsIncluded` (2).                                                                |
| Auth/proxy   | `proxy.ts` gates `/dashboard` + `/auth` via Firebase session cookie (`sm_session`); role rides in custom claims (no DB query). `/pos` currently falls straight through unauthenticated.                                                                                              | New `/pos` gate + device/operator cookies; dashboard-block cashier/manager.                                         |
| Identity     | Firebase (Phase 6). `getServerUser()` seam. uids are **text**.                                                                                                                                                                                                                       | Staff accounts are Firebase users; PIN operators are a signed short-lived cookie.                                   |

---

## 2. Architecture overview & the three app surfaces

On a store host (`echos.storemink.com`) there are now **three** surfaces:

| Surface          | Path                     | Who                                                     | Auth                                                 |
| ---------------- | ------------------------ | ------------------------------------------------------- | ---------------------------------------------------- |
| Storefront       | `/`, `/shop`, `/cart`, … | shoppers (anon)                                         | none (cache-friendly)                                |
| **Dashboard**    | `/dashboard/*`           | store owner/admins                                      | `sm_session` (Firebase); cashier/manager **blocked** |
| **POS register** | `/pos/*`                 | owner/admin **or** cashier/manager **or** paired device | `sm_session` **or** `pos_device` (+`pos_operator`)   |

`/dashboard/pos/*` = the **admin management console** for POS (locations, staff,
settings, overview) — configured by owners in the dashboard. `/pos` = the
**register app** used by staff. Clear split: admins _configure_ POS in the
dashboard; staff _use_ it at `/pos`.

---

## 3. Auth & identity model (hybrid)

Three principal types coexist on the store host, distinguished by cookie:

1. **`sm_session`** (existing Firebase cookie) — owner/admins (dashboard + POS)
   and POS staff signing in with their password. Role rides in claims
   (`cashier`/`manager` ⇒ the proxy bounces them out of `/dashboard`).
2. **`pos_device`** (new, HMAC-signed via `POS_SESSION_SECRET`) — an
   **authorized device**. Long-lived, carries `{deviceId, storeId, locationId}`.
   It is not an identity: it authorises the BROWSER, not a person.
3. **`pos_operator`** (new, HMAC-signed, short-lived) — the **active staff**
   after a PIN login. Carries `{staffId, storeId, locationId, deviceId, role}`
   — bound to the device it was created on, so revoking the device kills it.

### 3.1 Staff onboarding (invite → self-registration)

Staff are real accounts; the admin never sets a credential.

1. **Admin invites** (dashboard → POS → Staff): **name, email, role, locations**
   → a `pos_staff` row with `status='invited'` + a single-use `invite_token`
   (7-day TTL), and an emailed link to `/pos/register?token=…` (Resend; the
   `inviteUser` pattern).
2. **Staff self-registers** at that link: **password** (typed twice, must match)
   → **phone OTP** (Firebase Phone auth, invisible reCAPTCHA — the signup
   wizard's pattern) → **their own 8-digit PIN** (typed twice).
   `completeStaffRegistration` then verifies the session's email matches the
   invite, stores the scrypt PIN hash, links `user_id` (Firebase uid), flips
   `status='active'`, consumes the token, and sets the **role claim**.
   Technical ordering note: the password account must exist before a phone can
   be linked to it, so the wizard is password → phone → PIN.

### 3.2 Login (`/pos`) — email + PIN or email + password

One screen, two modes:

- **PIN (fast):** email + 8-digit pad → `posLoginWithPin` verifies scrypt
  **server-side**, scoped to the device's location → signed `pos_operator`
  cookie. One round trip.
- **Password:** email + password → Firebase `signInWithEmailAndPassword` +
  `establishSession` (the normal `sm_session`).

### 3.3 Device restriction (why a cashier can't sell from their phone)

A browser may run POS only once the **owner authorizes it** — either by tapping
"Authorize this device" while signed in on that device (`authorizeThisDevice`),
or by entering an authorization code generated in the dashboard
(`createPairingCode` → `pairDevice`; single-use, 10-min TTL). It then holds the
long-lived signed `pos_device` cookie.

`resolvePosOperator` requires an authorized, non-revoked device for **both**
staff paths (PIN and password), so correct credentials on an unauthorized device
(the cashier's personal phone) simply do not sign them in. **Owners are exempt**
— they must be able to authorize the first device. Revocation is immediate
(checked against `pos_devices` on every resolve).

**Honest limits:** this is per-browser-profile, not per-hardware. Clearing site
data de-authorizes the device (the owner re-authorizes in seconds), and someone
with the unlocked, already-trusted device plus devtools could copy the cookie —
a different threat from "staff logs in from home". Optional hardening later:
device fingerprinting, periodic owner re-approval, shop-IP allowlisting.

**Security invariant:** the operator is ALWAYS resolved server-side (PIN verify
or Firebase uid → `pos_staff`); the client never asserts who it is. PINs are
scrypt-hashed and rate-limited per device (`lib/rate-limit`).

### 3.4 proxy.ts changes

```
// on store hosts, extend the gate to /pos:
if (pathname.startsWith("/dashboard")) {
   if (!user) redirect /auth/login
   if (user.claims.role === "cashier" || user.claims.role === "manager")
      redirect /pos                       // POS staff never see the dashboard
   ...existing forcePasswordReset + superadmin gates...
}
if (pathname.startsWith("/pos")) {
   const device = verifyPosDevice(cookie)  // HMAC, no DB
   if (!user && !device) redirect /pos/login
   // fine-grained (enabled? pro? operator?) handled in the /pos layout
}
```

`pos.enabled` + pro-plan + operator resolution are checked in the **`/pos`
layout** (a server component), not the proxy, to keep the edge check cheap and
DB-free. A store that isn't pro / hasn't enabled POS renders a "POS isn't
available" screen.

### 3.5 Roles & capabilities (`lib/pos/permissions.ts`, pure)

POS roles live in `pos_staff.role` (`'cashier' | 'manager'`), **separate** from
dashboard `roles` slugs. Owners/admins operating `/pos` are implicitly `manager`+
(all capabilities, all locations).

| Capability                                            | Cashier                                      | Manager        | Owner/Admin    |
| ----------------------------------------------------- | -------------------------------------------- | -------------- | -------------- |
| Ring sale, take tender, print receipt                 | ✅                                           | ✅             | ✅             |
| Read-only cross-location stock lookup                 | ✅                                           | ✅             | ✅             |
| Discount above `pos.maxDiscountPercentWithoutManager` | manager PIN                                  | ✅             | ✅             |
| Price override                                        | per `pos.allowPriceOverride` (+ manager PIN) | ✅             | ✅             |
| Refund / return                                       | manager PIN                                  | ✅             | ✅             |
| Open/close shift, cash drop                           | ❌                                           | ✅             | ✅             |
| Adjust inventory (assigned location only)             | ❌                                           | ✅ (their loc) | ✅ (all)       |
| Manage staff / authorize devices                      | ❌                                           | ❌             | ✅ (dashboard) |

Every capability is enforced **server-side** in the POS action from the resolved
operator, never from a client flag. Manager location-scoping is enforced against
`pos_staff_locations`.

---

## 4. Data model

All tables are `store_id`-scoped, RLS via `is_store_admin(store_id)` for reads,
**writes via `SECURITY DEFINER` RPCs** (mirroring `inventory_rpc.sql`). SQL in
`supabase/pos_*.sql` with rollbacks; Drizzle tables in `drizzle/schema.ts`.

```sql
-- Phase 0 ---------------------------------------------------------------
store_locations(
  id uuid pk, store_id uuid, name text, type text check in ('shop','warehouse'),
  address jsonb, gstin text, state_code text,          -- state-wise GST reg.
  receipt_prefix text,                                  -- 'DEL', 'MUM' …
  is_default bool default false, active bool default true, sort_order int,
  created_at, updated_at)                               -- RLS: is_store_admin

inventory_levels(
  id uuid pk, store_id uuid, location_id uuid, product_id uuid,
  variant_id uuid null,
  on_hand int not null default 0, reserved int not null default 0)
  -- unique index (location_id, product_id, coalesce(variant_id, ZERO_UUID))
  -- read RLS is_store_admin; writes via RPC only

-- Phase 1 ---------------------------------------------------------------
pos_registers(id, store_id, location_id, name, active, created_at)

pos_staff(
  id uuid pk, store_id uuid, user_id text null,          -- Firebase uid (set at registration)
  name text, email text,                                  -- unique per store; login is by email
  role text check in ('cashier','manager'),
  pin_hash text null,                                     -- scrypt, 8 digits, set BY THE STAFF
  status text check in ('invited','active','disabled'),
  invite_token text null, invite_expires_at timestamptz,  -- single-use, 7-day TTL
  active bool default true, created_at, updated_at)

pos_staff_locations(staff_id uuid, location_id uuid, is_primary bool)  -- pk(staff_id,location_id)

pos_devices(id, store_id, location_id, label,            -- an AUTHORIZED browser
  revoked_at, last_seen_at, created_at)
pos_pairing_codes(code text pk, store_id, location_id, register_id,
  expires_at, used_at)                                   -- short-lived, single-use

-- Phase 2 ---------------------------------------------------------------
order_payments(id, order_id, store_id,
  method text check in ('cash','card','upi','gift_card','store_credit','razorpay'),
  amount numeric(12,2), tendered numeric(12,2), change_due numeric(12,2),
  reference text, captured_at timestamptz)               -- writes via placePosSale/RPC

-- Phase 3 ---------------------------------------------------------------
pos_shifts(id, store_id, register_id, opened_by, opened_at, opening_float,
  closed_by, closed_at, counted_cash, expected_cash, variance,
  status text check in ('open','closed'))
pos_cash_movements(id, shift_id, store_id, type text check in
  ('drop','payout','paid_in'), amount, reason, actor, at)

-- Phase 5 ---------------------------------------------------------------
order_returns(id, store_id, order_id, location_id, processed_by,
  refund_total, reason, created_at)
order_return_items(id, return_id, order_item_id, quantity, restock bool, refund_amount)
gift_cards(id, store_id, code, initial_balance, balance, status)
store_credit_accounts(store_id, customer_id, balance)     -- pk(store_id,customer_id)
store_credit_ledger(id, store_id, customer_id, delta, reason, ref, at)
```

**Column adds:**

- `orders`: `sales_channel text not null default 'online'` (`'online'|'pos'`),
  `location_id`, `register_id`, `shift_id`, `cashier_id text`,
  `place_of_supply_state text`, `customer_gstin text`, `receipt_no text`;
  **`customer_id` → nullable**, **`shipping_address` → nullable**. Add `'completed'`
  to the status allowlist for POS sales.
- `order_items`: `tax_cgst`, `tax_sgst`, `tax_igst numeric(12,2) default 0`,
  `hsn_code text`.
- `stock_movements`: `location_id uuid null` (NULL for pre-migration rows).
- `products` / `product_variants`: `barcode text null` (partial UNIQUE per store
  where not null), `hsn_code text null` (optional GST).
- `store_billing_settings`: `gst_enabled bool`, `business_state_code`,
  `legal_name`, `pan`.

⚠ The customer-SELECT RLS policy is `customer_id = auth.uid()`; a NULL never
equals a uid, so POS orders (no customer) stay invisible to shoppers — **add an
explicit test** ("POS order invisible to shoppers, visible to admins").

---

## 5. Inventory: locations & the aggregate cache

- Every store auto-gets one `is_default` location "Main" (Phase 0 backfill);
  existing `stock` migrates into an `inventory_levels` row at that location.
- **`inventory_levels` is the source of truth.** `products.stock` /
  `product_variants.stock` become a **trigger-maintained aggregate**
  = `SUM(on_hand)` across locations. The storefront, `lib/inventory/status.ts`,
  shop pages, cart clamp, and the current inventory dashboard keep working with
  **zero changes** — they read the aggregate.
- RPCs gain a location arg with a backward-compat wrapper:
  - `reserve_stock_at(p_store,p_location,p_product,p_variant,p_qty,p_order)`
  - `release_stock_at(…)`, `adjust_stock_at(…)`, and (Phase 4)
    `transfer_stock(p_store,p_from,p_to,p_product,p_variant,p_qty,p_actor)`
  - old `reserve_stock(...)`/etc. become wrappers → the store's default location
    (online checkout keeps calling the old signature until Phase 8 makes the
    online-fulfilment location configurable).
- A **drift test** asserts `products.stock == SUM(inventory_levels.on_hand)` after
  every RPC path — the aggregate cache is the one thing that can silently rot.
- Managers adjust stock only at their assigned location(s); `adjust_stock_at`'s
  action wrapper checks `pos_staff_locations` server-side.

---

## 6. GST place-of-supply engine

Full India GST, additive to the existing tax-class model (rates stay in
`tax_classes`; this is a split + place-of-supply layer). Pure module
`lib/billing/gst.ts`, tested.

- **Supplier state** = the selling location's `state_code` (each location has its
  own state-wise GSTIN).
- **Place of supply**:
  - In-store walk-in / pickup → the **location's** state → **intra-state**.
  - Delivery / ship-from-store → the **customer's** state.
- **Split** (per line, on the discounted taxable amount; `tax` computed exactly
  as `computeTax` does so totals reconcile):
  - intra-state (supplier == place-of-supply): `cgst = sgst = tax/2`, `igst = 0`.
  - inter-state: `igst = tax`, `cgst = sgst = 0`.
- Snapshot per `order_items` row: `tax_cgst`/`tax_sgst`/`tax_igst` + `hsn_code`;
  `orders.place_of_supply_state` + `orders.customer_gstin` (B2B input credit,
  optional). Historical invoices/receipts read the snapshot, never live settings.
- `store_billing_settings.gst_enabled` turns the whole engine on; when off, the
  current single-tax behaviour is unchanged.

```ts
// lib/billing/gst.ts
splitGst({ supplierState, placeOfSupplyState, rate, taxableAmount }):
  { cgst, sgst, igst }
```

HSN/SAC per product is **optional** but recommended for compliant invoices
(surface on receipt/invoice; not blocking).

---

## 7. The sell path (`placePosSale`) + tenders

`app/actions/pos-sale-actions.ts` — mirrors `placeOrder`'s trust boundary
exactly:

1. Resolve **operator** server-side (`pos_operator` cookie or Firebase staff/
   admin) → `{store_id, location_id, register_id, cashier_id, role}`. Reject if
   POS not enabled / not pro / operator lacks `sell`.
2. Rate-limit per operator. Validate cart shape (bounds like `placeOrder`).
3. **Re-price from DB, store-scoped** (never trust client prices).
4. Apply **line + order discounts** with reason codes; enforce
   `pos.maxDiscountPercentWithoutManager` — above cap requires a **manager
   approval token** (from a manager PIN verify).
5. **GST place-of-supply** split (§6) per line.
6. **Reserve stock at the register's location** via `reserve_stock_at`.
7. Insert `orders` (`sales_channel:'pos'`, location/register/shift/cashier,
   `customer_id` nullable, `shipping_address` nullable, `receipt_no` = per-location
   sequence, `place_of_supply_state`), `order_items` (with GST snapshot),
   `order_payments` (the tenders). Full reverse rollback on any failure (no
   cross-statement txn over the pool — same discipline as `placeOrder`).
8. Compute `payment_status`: `paid` when `SUM(order_payments.amount) >= total`
   (POS sales are normally born **paid**; status `completed`).

**Tenders (split allowed):**

- **Cash** — record `tendered` + `change_due`.
- **Card / UPI (external terminal)** — the store swipes on **their own** terminal;
  cashier records amount + reference. **0% surcharge** (the pitch) — StoreMink
  never touches the money.
- **Razorpay (optional online)** — a QR/link via the store's BYO gateway
  (`getStoreGateway`) for pay-at-counter online; verified like checkout.
- **Gift card / store credit** — Phase 5.

Per-location POS **receipt number** (`receipt_no`, e.g. `DEL-000123`) via a
per-location sequence, alongside the global `order_ref`.

---

## 8. Thermal receipt

- `lib/pos/receipt.ts` `buildReceiptModel(order, location, store, payments)` → a
  pure view model, so the SAME model feeds HTML-print now and ESC/POS later.
- `components/pos/ThermalReceipt.tsx` + `thermal-receipt.css` — **80mm** layout
  (`@page { size: 80mm auto }`, monospace, high-contrast), optional 58mm.
  Printed via the OS printer driver / `window.print()` (works with any
  driver-backed thermal printer, zero integration). A `PrintReceiptButton`
  auto-triggers print on sale completion.
- Contents: store legal name + location address + **location GSTIN**, receipt no
  - date/time + cashier, line items, discounts, **taxable value + CGST/SGST/IGST
    breakdown by rate**, total, tender lines + change, footer (thank-you, return
    policy, GST note), optional QR (order lookup / future WhatsApp reorder).
- Follow-up (Phase 10): raw ESC/POS via WebUSB or a local print agent for
  one-tap, dialog-free printing.

---

## 9. Settings, roles, plan gating & the sidebar enable flow

### 9.1 `pos.*` settings (registry, section `pos`, page `/dashboard/pos/settings`)

`pos.enabled` (bool, `minPlan: 'pro'`), `pos.allowStorePickup`,
`pos.allowReturnsInStore`, `pos.allowShipFromStore`, `pos.allowPriceOverride`,
`pos.requireManagerForDiscount`, `pos.maxDiscountPercentWithoutManager` (number),
`pos.requireCustomerForSale`, `pos.receiptChannel` (print|whatsapp|sms|email —
needs a small `type: "enum"` addition to `SettingDef`), `pos.receiptWidth`
(80|58), `pos.cashDrawerMaxBeforeDrop`, `pos.trackSerialNumbers`,
`pos.safetyStockBuffer`. All enforced **server-side** in the POS actions.

### 9.2 Plan gating (`lib/plans.ts`)

- `PLAN_LIMITS.posEnabled`: free/basic `false`, pro `true`.
- `PLAN_LIMITS.posLocationsIncluded`: pro `2` (others `0`).
- `pos.enabled` is `minPlan: 'pro'` → `resolveStoreSettings` forces it to `false`
  on free/basic even if the row says otherwise (expiry-aware via `effectivePlan`).
- Adding a location beyond `posLocationsIncluded` is **blocked** in
  `pos-location-actions.ts` with an upgrade/contact message until Phase 7 wires
  the ₹1,000/mo charge.

### 9.3 Sidebar "POS" section (`/dashboard/pos`)

A new `pos` entry in `SECTIONS` (group `Workspace`) with **plan-aware rendering**
in the sidebar link component:

- **free / basic** → "POS · Included in Pro" → links to `/dashboard/plans`
  (upgrade).
- **pro, not enabled** → "Enable POS" → `enablePos()` (superadmin, pro-gated:
  sets `pos.enabled`, auto-creates the default location, revalidates
  `STORE_TAG`).
- **pro, enabled** → normal children: Overview, Locations, Staff & Devices,
  Settings, + an **"Open Register"** button that opens `/pos` in a new tab.

`enablePos` and every `/dashboard/pos/*` action are gated on the `pos` section
(`getManagerIdentity("pos")`) and re-check pro server-side.

---

## 10. Performance — "least checkout time / fastest login"

Concrete techniques baked into the design (not aspirational):

- **Catalog preloaded to the client** (IndexedDB) when the register opens: local
  full-text + a **barcode→SKU index (Map)**, so search and scan resolve in
  <50 ms with **zero network**. Background revalidation keeps it fresh; this also
  seeds the Phase 9 offline outbox.
- **Barcode via HID keyboard-wedge** (the default for USB/BT scanners): a focused
  hidden input captures the scan, `Enter` triggers the local lookup → add to cart
  instantly, no camera permission, no network. Camera scan is a later add.
- **One network call per sale** (`placePosSale`); everything else is local +
  optimistic. Tax/gateway/config fetched **once** at register open.
- **Fastest login** = paired device + numeric PIN (one round-trip verify),
  operator token cached; account login is the portable fallback.
- **SPA within `/pos`** — no full page reloads; large touch targets, keyboard-
  first, sale reset in <1 frame.

---

## 11. Phased execution (v1 = Phases 0–2)

### Phase 0 — Foundations: plan gate, locations, per-location inventory, enable flow

SQL: `pos_00_locations.sql`, `pos_01_inventory_levels.sql` (+ backfill + aggregate
trigger), `pos_02_rpc_location.sql`, `stock_movements.location_id`, GSTIN cols.
Code: Drizzle tables; `lib/pos/locations.ts`; `pos` section + plan-aware sidebar
rendering; `pos.*` settings (incl. the `enum` `SettingDef` type); `PLAN_LIMITS`
adds; `app/actions/pos-location-actions.ts` (CRUD, gated, location-capped);
`enablePos`; Locations manager + per-location inventory in
`/dashboard/inventory`. Tests: aggregate-drift, backfill idempotency, RPC
location scoping, compat-wrapper equivalence, location cap.
**Ships:** multi-location inventory in the dashboard; storefront unchanged.

### Phase 1 — POS app shell + hybrid auth + staff/roles/PIN + device pairing

`app/pos/*` route group + layout (pro + `pos.enabled` gate + operator resolve);
proxy `/pos` gate + dashboard-block for cashier/manager; `lib/pos/session.ts`
(sign/verify `pos_device` + `pos_operator`); `lib/pos/permissions.ts`;
`pos_staff` + `pos_staff_locations` + `pos_devices` + pairing; Firebase
role-claim sync for POS staff; `app/actions/pos-staff-actions.ts` (admin creates
staff, assigns locations, sets PIN) + `pos-auth-actions.ts` (`pairDevice`,
`posUnlock`, `posLock`); Staff & Devices UI in `/dashboard/pos`; `/pos/login`
(PIN pad + account sign-in + pair). Manager auto-location on resolve.
**Ships:** staff log in (account or PIN); managers land on their location; nobody
but admins can reach `/dashboard`.

### Phase 2 — The Register (sell) + GST + thermal receipt — **v1**

`app/actions/pos-sale-actions.ts` (`getRegisterConfig`, `lookupProduct` with
variant disambiguation, `placePosSale`, `verifyManagerPin`); `lib/billing/gst.ts`;
`lib/pos/receipt.ts` + `components/pos/ThermalReceipt.tsx`; the register UI
(product grid + search + barcode, cart, line/order discounts + reason codes,
customer attach optional, tender modal with split + cash change + external-card +
optional Razorpay QR, receipt print). Catalog IndexedDB preload — **DONE**
(`lib/pos/catalog-index.ts` + `catalog-store.ts` + `use-catalog.ts`, fed by
`getCatalogSnapshot`; measured ~0.001 ms per scan and 1.4–5.3 ms per keystroke
at 1k–20k SKUs, so §10's <50 ms target is met with room to spare).
Tests: `pos-sale-actions.test.ts` at `checkout-actions.test.ts` rigor —
price tampering, discount-cap + manager approval, GST split reconciliation,
reserve-at-location, split-tender totalling, rollback paths, POS-order RLS
invisibility.
**Ships:** a real in-store sale end to end; appears in `/dashboard/orders` +
analytics alongside online orders.

### Phase 3 — Shifts & cash reconciliation — **DONE**

`pos_shifts` + `pos_cash_movements` (supabase/pos_10_shifts.sql) +
`orders.shift_id`; open/close (float → expected vs counted → variance), cash
drop/payout/paid-in, live X-report and the closed Z-report at `/pos/shift`.
`pos-shift-actions.ts`, gated on `open_close_shift` / `cash_drop`. Pure math in
`lib/pos/shifts.ts`. One open shift per LOCATION, enforced by a partial unique
index. Settings: `pos.requireOpenShift`, `pos.cashVarianceTolerance`.

### Phase 4 — POS-native inventory management (manager, location-scoped) + transfers

Inventory screens **inside `/pos`** scoped to the operator's assigned location(s):
counts, adjust (`adjust_stock_at`), receive stock, low-stock, `transfer_stock`
between locations. Location-scope enforced server-side.

### Phase 5 — Returns/BORIS + store credit + gift cards

`processReturn` (full/partial, restock via `release_stock_at` + negative
movements, refund tender, tiered-discount recalculation on partial returns),
store-credit accounts + ledger, gift-card issue/redeem tender.

### Phase 6 — Twilio WhatsApp/SMS receipts (channel/provider abstraction)

`lib/pos/receipt-delivery.ts` (channel `print|whatsapp|sms|email`, provider
`twilio|meta`), Twilio integration + templates, `pos.receiptChannel` wiring.
Meta slots in later behind the same interface.

### Phase 7 — Metered extra-location billing (₹1,000/mo)

Charge additional locations on the existing Pro Razorpay subscription (add-ons /
quantity + webhook reconciliation); lift the Phase 0 hard cap into a paid path.

### Phase 8 — Omnichannel (BOPIS, ship-from-store, routing, inter-state IGST)

Pickup queue + unclaimed-expiry sweep, ship-from-store, cross-location lookup,
`safetyStockBuffer`, low-stock routing; make the online-checkout fulfilment
location configurable (retire the default-location wrapper); IGST for inter-state
shipments (the customer-state place-of-supply path from §6).

### Phase 9 — Offline outbox

IndexedDB queue + Web-Worker replay through `placePosSale` + conflict surfacing.
Server authoritative; no CRDT.

### Phase 10 — Differentiators

AI Cashier Copilot (`lib/ai/gemini.ts` + brand voice + `consumeAiQuota`), camera
barcode scan, serial/lot tracking, composite bundles, WhatsApp reorder portal,
raw ESC/POS printing, bulk barcode CSV import.

---

## 12. Testing & risks

Co-located `*.test.ts` for every action; money/stock paths at
`checkout-actions.test.ts` rigor. **Top risks:** (1) `inventory_levels` backfill +
aggregate-cache drift → drift test + trigger; (2) nullable `orders` columns vs.
the customer-SELECT RLS policy → explicit visibility test; (3) PIN/operator-token
security → server-side verify, hashing, rate-limit, short TTL, never trust the
client; (4) GST split rounding vs. `computeTax` total → reconciliation test;
(5) split-tender rounding → reuse whole-rupee rounding from `placeOrder`.

## 13. Conventions checklist (per commit)

`store_id` + RLS on every table · RPC-only writes for stock/tender/returns ·
`withUser` carries uid **and** email · settings enforced server-side · plan limits
enforced in the owning action · POS staff blocked from `/dashboard` · update
`CODEBASE.md` in the same commit when routes/actions/lib/SQL are added.

## 14. Remaining owner inputs (non-blocking; sensible defaults assumed)

1. **Cashier/manager capability matrix** — proceeding with §3.3 unless changed.
2. **Manager multi-location** — assumed allowed (primary + others); single is the
   default.
3. **Barcode collisions** (same supplier barcode on two variants) → disambiguation
   prompt; **bulk CSV import** is Phase 10.
4. **HSN/SAC codes** — added as optional now; confirm if they must be mandatory on
   GST invoices for your merchants.
5. **B2B GSTIN capture** at POS (customer GSTIN for input credit) — field included,
   optional.
6. **Device pairing** — assumed owner/admin-generated codes from `/dashboard/pos`;
   confirm whether managers may also pair devices.
