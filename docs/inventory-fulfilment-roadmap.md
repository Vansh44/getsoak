# Inventory & Fulfilment — Phased Roadmap

> **Ordering lives in `docs/roadmap.md`.** This document is the SPECIFICATION —
> the extension points, invariants and per-phase design. What ships next, and
> in what order, is decided in the roadmap, because these phases interleave
> with the POS ones (locations G and POS 5 are the same returns work).
> Acceptance tests: `docs/pos-acceptance.md`.

**Goal:** grow from one shop to hundreds of locations and many sales channels
**without rewriting the core**. Every behaviour that a merchant might want
different is a registered, configurable thing — not an `if` branch.

**Companion to:** `docs/locations-ia.md` (where it all lives in the UI),
`docs/pos-plan.md` (POS phases), `CODEBASE.md` §22.

---

## 1. What "nothing is fixed" actually means

Five extension points. Everything in this roadmap plugs into one of them, and
adding a capability, a strategy, a channel, a movement reason or a notification
must never mean editing a `switch` in twelve files.

### 1.1 Capabilities — a registry, not columns

Following `lib/settings/registry.ts`, which already works this way.

```ts
// lib/locations/capabilities.ts
export const LOCATION_CAPABILITIES = {
  pos: { label: "Sell here", default: { shop: true, warehouse: false } },
  online_fulfil: {
    label: "Fulfil online",
    default: { shop: false, warehouse: true },
  },
  pickup: {
    label: "Customer pickup",
    requires: ["pos"],
    default: false,
    minPlan: "pro",
  },
  returns: {
    label: "Accept returns",
    requires: ["pos"],
    default: false,
    minPlan: "pro",
  },
  receive_stock: { label: "Receive stock", default: true },
  transfer_stock: { label: "Stock transfers", default: true },
} as const;
```

Stored as `store_locations.capabilities jsonb`, **not** six boolean columns. A
seventh capability is then a registry entry — no migration, no schema drift, and
the `requires` / `minPlan` / per-type defaults are declared in one place instead
of scattered through the UI.

Read through one function, never inline:

```ts
locationCan(location, "pickup"); // registry default → store override → plan gate
```

### 1.2 Fulfilment strategy — a resolver interface

```ts
// lib/fulfilment/strategies/index.ts
export interface FulfilmentStrategy {
  id: string;
  label: string;
  minPlan?: PlanId;
  /** Ordered candidates; the caller takes the first that can serve the line. */
  rank(ctx: FulfilmentContext): Promise<LocationId[]>;
}
```

v1 registers exactly one (`priority`). `nearest`, `most_stock`,
`cheapest_shipping`, `manual` and `split` each become a file that registers
itself. **Checkout never learns their names** — it asks the registry for the
store's configured strategy and takes the ranking.

### 1.3 Movement reasons — a vocabulary, not an enum in SQL

`stock_movements.reason` is already free text with a ledger row per change.
Keep it text; declare the vocabulary in TS with labels, sign expectations and
whether the reason is sellable-affecting. A new reason is a registry entry.

### 1.4 Channels — a registry

`orders.sales_channel` is already text (`online` | `pos`). Instagram, WhatsApp,
Amazon and Flipkart become registry entries carrying their own stock policy, not
new columns and not new branches in the reserve path.

### 1.5 Notifications — already a registry, needs a location axis

`lib/notifications/` is the one piece of this that is already built the right
way: events, audiences, channels, per-event variables and merchant templates
are all registry entries, and `coverage.test.ts` fails CI if a declared event
has no emitter.

Two additions, no rewrite:

**Routing gains a scope, not a fourth mode.** `RoutingRule` is today
`mode: permission | roles | admins`. Location is not another mode — it is a
filter that COMPOSES with all three. "People with the orders permission, at this
order's location."

```ts
export interface RoutingRule {
  mode: "permission" | "roles" | "admins";
  scope: "store" | "event_location"; // ← new; "store" is today's behaviour
  roles: string[];
  admins: string[];
}
```

**Content varies by context, not by event id.** A pickup confirmation needs the
shop's address where a delivery shows a shipping address. That is ONE
`order.placed` event with a richer payload — not `order.placed.pickup`.
Splitting events multiplies the registry combinatorially against channels,
audiences and fulfilment methods. Instead: the payload carries the fulfilment
method, `variables.ts` gains `{{fulfilment.type}}`, `{{pickup.location}}`,
`{{pickup.address}}`, `{{pickup.hours}}`, and `render.ts` — already
audience-aware — becomes audience- AND context-aware. A merchant wanting
entirely different wording writes it with those tokens.

**Events each later phase must register** (the coverage guard means they cannot
be declared and forgotten): `order.ready_for_pickup`, `order.collected`,
`order.pickup_expiring`, `order.pickup_expired` (F); `return.requested`,
`return.received` (G); `transfer.dispatched`, `transfer.received` (I).

---

## 2. The invariants

These hold in every phase below. If a phase would break one, the phase is wrong.

1. **Every stock change goes through an atomic RPC and writes a ledger row.**
   No `UPDATE inventory_levels` from application code, ever.
2. **`on_hand` stays materialised.** The ledger is the audit trail, not the
   source of reads — never recompute a balance by replaying movements.
3. **Reserve before confirm.** Nothing is sellable twice.
4. **A capability check is server-side.** Hiding a button is not a permission.
5. **Backfills preserve current behaviour.** A migration may not change what a
   live store does.
6. **A single-location store never pays a complexity tax** for any of this.
7. **Scope is derived from the viewer, never accepted from the client.** The
   same rule `store_id` already follows — a location filter that can be passed
   in is not a permission boundary.

---

## 3. Phases

Each phase is independently shippable and leaves the system working.

---

### Phase A — Capabilities foundation

**Ships:** `store_locations.capabilities jsonb`, the registry, `locationCan()`,
and the backfill from `locations-ia.md` §6.2 — existing behaviour ON,
pickup/returns OFF.

**Makes possible:** everything below. Nothing user-visible changes yet.

**Extension point:** §1.1.

---

### Phase B — Locations section

**Ships:** `/dashboard/locations`, the location editor with capability
checkboxes, fixed type list, 301 from `/dashboard/pos/locations`. Hidden for
single-location stores.

**Rules enforced:** `requires` (pickup ⇒ pos), and the last online-fulfilment
location cannot be switched off.

---

### Phase B2 — Location scope ★ a second tenancy dimension

**The gap:** there is no location dimension in the dashboard identity model at
all. `pos_staff` is location-bound through `pos_staff_locations`; `admins` is
bound to a store and nothing else. `getOrders` has no location filter, so every
dashboard admin sees every order regardless of where they work.

**Decision:** staff see only their location(s). Owners and superadmins see
everything.

**Ships:**

- `admin_locations` (admin_id, location_id, store_id) — mirrors
  `pos_staff_locations`
- `getViewerLocations()` — the location counterpart to `getCurrentStoreId()`.
  Returns **`null` for unrestricted** (owner, superadmin, platform operator) and
  an array for bound staff. `null` = all, the same convention `PLAN_LIMITS`
  already uses.
- Location filters on **orders, inventory, analytics and the dashboard totals**,
  every one derived from the viewer — never from a query parameter (invariant 7)
- Location assignment in the admin editor
- `RoutingRule.scope` (§1.5), defaulting to `store` so nothing changes yet

**Why here and not later:** location is cross-cutting in exactly the way
`store_id` is, and retrofitting a tenancy dimension across every list query is
the expensive kind of late change. It also has to land before Phase D — the
moment orders originate from several locations, an orders list that shows
everything to everyone stops being incomplete and becomes wrong.

**A single-location store sees no change**: one location, every viewer
unrestricted, every filter a no-op.

**Left open:** `admins` and `pos_staff` remain two staff models with two
location bindings. Unifying them is a bigger call than this phase, and the
mirror keeps them consistent until someone makes it.

---

### Phase C — Inventory location selector

**Ships:** the location dropdown on `/dashboard/inventory`. "All locations" is
read-only totals; a specific location is editable and writes there.

**Closes:** the outstanding half of the POS Phase 4 gap — the desk view
currently shows the sum but writes to the default location.

---

### Phase D — Fulfilment routing ★ the big one

**Ships:** `store_fulfilment_rules` (strategy id + ordered location list), the
strategy registry with `priority` registered, `/dashboard/locations/fulfilment`,
and **`reserve_stock` retired** — online checkout resolves a location through
the strategy instead of always using the default.

**Fixes:** the website advertises the total across shops but can only sell from
the default one. Today Delhi 0 / Mumbai 10 shows "10 in stock" and then fails
the order.

**Also:** the storefront stops reading the raw aggregate and starts reading
_sellable_ stock — the sum across locations that can actually fulfil.

**Extension point:** §1.2. Adding `nearest` later touches no checkout code.

---

### Phase E — Real reservations — **DONE**

**Ships:** `inventory_levels.reserved` finally used, a `reservations` table with
an owner (order / pickup hold / channel) and a TTL, `reserve → confirm →
release` RPCs, and a sweeper for expired holds.

**Why it can't come earlier:** today `reserve_stock_at` decrements `on_hand`
directly. That is correct and unoversellable for COD, but it cannot express
"held for an unpaid order" or "held for a pickup nobody has collected".

**Unblocks:** pickup holds, online payment-pending, marketplace sync.

**Shipped ADDITIVE.** `reserve_stock_at` still decrements `on_hand` outright,
so COD checkout, the POS register and cancellation restock are untouched
(invariant 5). What changed for existing flows is only that both stock guards
now subtract `reserved` — a hold genuinely protects units instead of being
decorative — and `online_stock` became `on_hand - reserved` at fulfilling
locations, so the storefront never promises held units. `products.stock` stays
the physical count, which is what the dashboard and POS want.

---

### Phase F — Pickup (click & collect) — **DONE**

**Shipped:** `supabase/locations_05_pickup.sql` (fulfilment_type /
pickup_location_id / pickup_status / pickup_expires_at / collected_at /
collected_by on `orders`, three CHECKs, the queue index);
`lib/fulfilment/pickup.ts` (`pickupLocationsFor` — capability + plan + stock,
`sweepExpiredPickups`); `getPickupOptions` + a pickup step at checkout;
`placeOrder` **holds** instead of reserving; `/pos/pickups` (queue, mark ready,
hand over) + a Collections tile on the POS home; four notification events; the
sweep folded into `/api/cron/expire-pending-payments`.

**Rule from the spec, kept:** a customer-chosen pickup location **overrides**
the fulfilment strategy entirely.

**Config, not code:** `fulfilment.offerPickup` + `fulfilment.pickupHoldDays`
(registry, section `locations`, rendered on Locations → Online fulfilment).

**Three things that had to move together**, or the feature would lie:

1. **A pickup HOLDS, it does not sell.** The goods are on that shop's shelf
   until someone hands them over. `reserve_stock_at` would empty the shelf on
   screen while the box is still physically on it, and the shop would reorder
   stock it already has.
2. **Therefore the order carries `stock_status: 'none'`.** The cancel path's
   reserved→released claim restocks — running it on a pickup would ADD units
   that never left. Cancelling a pickup releases its holds instead
   (`order-actions.ts`), which is idempotent, so a second cancel is a no-op.
3. **Availability is `on_hand − reserved`.** Offering a shop whose only unit is
   already held for somebody else's collection is how two people are promised
   the same box.

**The pre-expiry nudge** (`order.pickup_expiring`, `sweepPickupReminders`)
fires once per order, 48 hours out, and the exactly-once property is a CLAIM on
`orders.pickup_warned_at` (`locations_06_pickup_reminder.sql`) — not a
schedule. The cron is a heartbeat, and `notifications`' UNIQUE on
(event, recipient) can't dedupe it because each emit creates a NEW event row;
without the claim a daily run would mail the same customer about the same box
every day, which is how people learn to ignore a merchant's email.
`PICKUP_WARN_HOURS` must stay ≥ TWICE the cron interval. Window and schedule
are not in phase, so the notice an order gets is (W − I, W]: at W = I nothing
slips through unwarned, but an order expiring just after a run is warned just
before it lapses — and it spends the one email the claim allows. Reminders run
AFTER the
expiry sweep: telling someone to hurry and collect an order we just cancelled
is worse than saying nothing.

**Phase F.1 — postcode serviceability (BUILT, THEN REMOVED).** ⚠ The column,
the module and the checkout behaviour are all GONE — `locations_08` drops
`store_locations.pickup_pincodes` and `lib/locations/pincodes.ts` is deleted.
Nothing below is live; it is kept only so the idea isn't re-proposed as new.

The idea was that a merchant lists the postcodes each shop collects to (exact
`400001`, prefix `400*`, range `400001-400104`) and the checkout hides pickup
from anyone outside them.

**Why it was reverted:** the design argued against itself. It needed a
"Collecting somewhere else?" escape hatch precisely BECAUSE hand-typed lists
have gaps — and a shopper's DELIVERY postcode is a guess at where they are, not
a fact about where they will drive. People collect near work, near family, on a
route home. Asking the merchant to predict that is asking the wrong person.

**What replaced it** (the ALDO/Shopify/IKEA model): offer pickup to everyone,
list every shop that has the goods, and let the SHOPPER search the list by
postcode, city or shop name. They know where they'll be. Excluding a specific
shop was always possible without any of this — turn off its `pickup`
capability. Nothing was lost in the drop: the column only ever decided what was
OFFERED, never what was permitted, so no order state depended on it.

One consequence outlived it: the chooser no longer has to sit below the address
step, since which shops can collect no longer depends on a postcode.

**Deliberately not built:** radius from lat/lng. It is the more correct answer
and it puts a geocoding call on the checkout render path — cost, latency, and a
failure mode on the one page that must never break. Revisit alongside the
`nearest` routing strategy, which needs the same geocoding (Step 8).

**Deliberately not built:** automatic refunds on expiry. The order is cancelled
and the stock comes back; moving money on a schedule waits for the returns
machinery that records it (Phase G).

---

### Phase G — Returns

Already POS Phase 5. **Ships:** `processReturn` (full and partial), refund to
the original tender, restock decision **per line** — sellable or damaged — and
`/pos/returns`.

**Then:** return-in-store for online orders, at locations with the `returns`
capability. Where the stock lands (this location / transfer back / inspection)
is merchant config, per the spec.

**Introduces:** the first extra inventory bucket, `damaged`. Added here because
this is the first workflow that moves stock into it — not before.

---

### Phase H — Stock policy per channel

**Ships:** a rules table expressing all of the spec's reservation ideas through
one mechanism instead of three special cases:

```
location × channel → { reserve_units, buffer_units, max_sellable }
```

- "20 units at the warehouse reserved for online" → `reserve_units` on the POS channel
- "15 units at Delhi reserved for walk-ins" → `reserve_units` on the online channel
- "sell only 18 of 20" → `buffer_units`

**Extension point:** §1.4 — a new channel inherits the mechanism for free.

---

### Phase I — Transfer lifecycle

**Ships:** `stock_transfers` with `created → approved → dispatched → in_transit
→ received`, the `in_transit` bucket, and partial receipt (10 sent, 9 arrived,
1 investigated).

**Kept alongside, not replaced:** the existing instant `transfer_stock`. Two
different real operations — carrying six loaves next door is not a lorry
crossing the country, and forcing the five-step lifecycle on the first would
make the POS Stock screen useless.

---

### Phase J — More strategies

`nearest` (needs geocoding), `most_stock`, `cheapest_shipping`, `manual`
assignment, `split` shipments. Each is one file registering itself. Ships when a
merchant asks.

---

### Phase K — Multi-channel

Instagram, WhatsApp, Amazon, Flipkart. All reserve from the same
`inventory_levels` through the same RPCs, with per-channel policy from Phase H.
The integration work is the connector; the inventory model needs nothing new —
which is the test of whether Phases A–H were designed right.

---

## 4. Every function in the spec, placed

| Spec function                      | Phase     | How it stays unfixed                  |
| ---------------------------------- | --------- | ------------------------------------- |
| Locations own inventory            | ✅ done   | —                                     |
| Inventory ledger                   | ✅ done   | reason vocabulary (§1.3)              |
| POS sells from its location        | ✅ done   | —                                     |
| Instant transfers                  | ✅ done   | —                                     |
| Location capabilities              | **A, B**  | registry (§1.1)                       |
| Warehouse / dark store             | **A, B**  | type → default capabilities           |
| Staff see only their location      | **B2**    | viewer-derived scope                  |
| Per-location inventory editing     | **C**     | —                                     |
| Choose online fulfilment locations | **D**     | capability                            |
| Fulfilment priority                | **D**     | strategy registry (§1.2)              |
| Store closed → skip                | **D**     | a rule inside the strategy            |
| Availability by location           | **D**     | sellable-stock resolver               |
| Reserve → sold                     | **E**     | reservation owner types               |
| Pickup in store                    | **F**     | capability + config                   |
| Pickup expiry                      | **F**     | setting                               |
| Returns, partial, exchange         | **G**     | —                                     |
| Return in store                    | **G**     | capability                            |
| Damaged / inspection               | **G**     | bucket added with its workflow        |
| Online-only stock                  | **H**     | channel policy (§1.4)                 |
| Store-only stock                   | **H**     | channel policy                        |
| Overselling buffer                 | **H**     | channel policy                        |
| In-transit stock                   | **I**     | bucket + lifecycle                    |
| Transfer approval                  | **I**     | lifecycle states                      |
| Nearest / cheapest / split         | **J**     | strategy registry                     |
| Location-aware notifications       | **B2**    | `RoutingRule.scope` (§1.5)            |
| Pickup address in the confirmation | **F**     | context variables, one event (§1.5)   |
| Marketplaces                       | **K**     | channel registry                      |
| Warehouse / regional manager       | **later** | needs a role model that doesn't exist |

---

## 5. Deliberately NOT doing

**Event-sourced inventory.** The spec suggests computing current stock from all
movements. Don't — every product page would replay a year of history. Keep the
materialised `on_hand` plus the ledger, with the drift guard that already exists.

**All nine inventory states up front.** `Sold` is not a state stock sits in;
`Adjustment` is a reason, not a bucket. Add a bucket when a workflow moves stock
into _and_ out of it: `reserved` (E), `damaged` (G), `in_transit` (I). The rest
stay ledger reasons.

**Per-location pricing.** Not in the spec, frequently assumed. Out of scope
until asked for — it touches every price read in the system.

**Six boolean capability columns.** See §1.1: each new capability would be a
migration plus a UI change plus a check in every consumer.

---

## 6. Sequencing

**A → B → B2 → C → D** is the spine, and D is where the system stops lying to
customers about availability. B2 sits before D deliberately: multi-location
orders and a store-wide orders list are incompatible. Everything after D is optional and demand-driven.

**E** before **F**, always — pickup without real reservations oversells.

**G**, **H**, **I**, **J**, **K** are independent of each other and can be
ordered by whoever is shouting loudest.
