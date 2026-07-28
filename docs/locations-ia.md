# Locations & Fulfilment — Information Architecture

**Status:** proposal, for review before any code is written.
**Companion to:** `docs/pos-plan.md` (POS phases), `CODEBASE.md` §22.

---

## 1. The principle

Today the dashboard says:

> **Point of Sale** owns Locations.

The multi-location spec says the opposite:

> A **location** is any place inventory exists. **POS is one capability of a
> location** — a warehouse is a location with POS switched off.

Everything below follows from taking the second view. The practical
consequence: pickup, online fulfilment and returns are **storefront** features
that happen to depend on locations. If locations stay inside the POS section, a
merchant who wants click-and-collect has to go looking for it under the till.

### The rule that decides where a setting lives

| If it…                               | It goes…                                      |
| ------------------------------------ | --------------------------------------------- |
| differs per shop                     | on the **location** record                    |
| is an ordering _of_ locations        | on the **Locations** page                     |
| is store-wide till behaviour         | in **POS → Settings**                         |
| is store-wide customer-facing policy | with the feature the **customer** experiences |

"Allow store pickup" fails the first test as a global toggle: Delhi yes,
Warehouse no. It is a per-location capability, not a setting.

---

## 2. Route map

### Before

```
/dashboard/pos                     Overview
/dashboard/pos/locations           list + create           ← locations live here
/dashboard/pos/staff
/dashboard/pos/devices
/dashboard/pos/settings            7 pos.* settings
/dashboard/inventory               default location only
```

### After

```
/dashboard/locations               ★ NEW top-level section
/dashboard/locations/[id]          ★ location editor (capabilities live here)
/dashboard/locations/fulfilment    ★ online fulfilment order + rules

/dashboard/pos                     Overview  (till only)
/dashboard/pos/staff
/dashboard/pos/devices
/dashboard/pos/settings            till behaviour only — unchanged

/dashboard/inventory               + location selector
/dashboard/settings/checkout       + pickup policy (offer it, hold days)
```

`/dashboard/pos/locations` **301s to `/dashboard/locations`** — merchants have
the old URL bookmarked and in muscle memory.

---

## 3. The pages

### 3.1 `/dashboard/locations` — the list

One row per location. The columns are the questions a merchant actually asks:

```
Name            Type        Capabilities              Stock value   Status
─────────────────────────────────────────────────────────────────────────
Warehouse       Warehouse   Online · Receive          ₹4,20,000     Active
Delhi Store     Shop        POS · Online · Pickup     ₹1,10,000     Active
                            · Returns · Receive
Mumbai Store    Shop        POS · Pickup · Receive    ₹  86,000     Active
```

- **Add location** — name, type, address, state code (GST), receipt prefix
- Capability chips are read-only here; editing happens in the location
- A single-location store sees one row and never needs to think about any of it

### 3.2 `/dashboard/locations/[id]` — the editor

Three cards.

**Details** — name, type (Shop / Warehouse / Dark store), address, GSTIN, state
code, receipt prefix, active.

**Capabilities** — the heart of it:

```
☑  Sell here (POS)                Staff can ring sales at this location
☑  Fulfil online orders           Website orders can ship from here
☑  Customer pickup                Shoppers can collect orders here
☑  Accept returns                 Online returns can be handed back here
☑  Receive stock                  Deliveries can be booked in
☑  Stock transfers                Can send and receive transfers
```

Two rules the UI must enforce, with the reason shown inline rather than a bare
disabled checkbox:

- **Pickup and Returns require POS.** Someone has to hand the goods over.
  Unchecking POS unchecks both, and says so.
- **The last location with "Fulfil online orders" cannot be unchecked** while
  the store sells online — that would silently break checkout.

**Danger zone** — deactivate (hidden from fulfilment, stock preserved) and
delete (refused while stock or open orders exist).

### 3.3 `/dashboard/locations/fulfilment` — where online orders come from

Only meaningful with 2+ locations; collapses to an explainer with one.

```
Strategy:  ( • ) Priority order      ( ) Nearest to customer   [later]
                                     ( ) Most stock            [later]

Drag to reorder — the first location with stock wins:

  ⠿  1.  Warehouse          online ✅
  ⠿  2.  Delhi Store        online ✅
      —  Mumbai Store       online ❌  (not a fulfilment location)

☑  Skip locations that are closed or deactivated
☐  Split an order across locations           [later]
```

Mumbai appears greyed with the reason, rather than being absent — otherwise a
merchant wonders why their shop is missing.

### 3.4 `/dashboard/inventory` — gains a location selector

The outstanding half of the Phase 4 gap. Today this page shows the **total**
across locations but writes to the **default** one, which on a two-shop store
is quietly wrong.

```
Inventory        [ All locations ▾ ]        ← new
```

- **All locations** — read-only totals, with a per-location breakdown on expand
- **A specific location** — editable, writes to that location

Editing is disabled under "All locations" with the reason stated: you cannot
adjust a number that is a sum.

### 3.5 `/dashboard/pos/settings` — unchanged

All seven existing `pos.*` settings are genuinely about the till and stay put:
`enabled`, `idleLockMinutes`, `allowPriceOverride`,
`requireManagerForDiscount`, `maxDiscountPercent`, `requireOpenShift`,
`cashVarianceTolerance`.

Nothing moves out. Nothing pickup- or return-related moves in.

### 3.6 `/dashboard/settings/checkout` — pickup policy

Store-wide, customer-facing, so it belongs where the merchant thinks about
checkout — not under the till:

```
☑  Offer pickup at checkout
     Hold uncollected orders for  [ 5 ] days, then cancel and refund
☑  Offer returns to a store
     Accept returns for  [ 7 ] days after delivery
```

These are settings-registry entries (convention §9), gated on `minPlan` if
pickup ends up Pro-only — see §6.

---

## 4. Navigation

`app/dashboard/lib/permissions.ts`, group **Workspace**:

```
Home
Orders
Products
Categories
Colours
Inventory
Locations        ★ new — sits directly above Point of Sale
Point of Sale
  ├ Overview
  ├ Staff
  ├ Devices
  └ Settings
Users
Analytics
Enquiries
```

`Locations` above `Point of Sale` reads as "places, then what you do there",
and puts it next to Inventory, which is what it's really about.

**A store with one location should not see a new section it doesn't need.**
Show `Locations` when the store has 2+ locations, or POS is enabled, or the
merchant opens it from Inventory's selector. Same three-state treatment the POS
entry already uses.

---

## 5. The POS side

Capabilities change what a till offers, and two new screens appear. The POS
header is already carrying Stock, Cash drawer, Edit layout, Lock — it needs a
proper nav rather than more buttons.

```
/pos/sell         Register
/pos/pickups      ★ Orders to collect     (if pickup ✅ here)
/pos/returns      ★ Returns               (if returns ✅ here)
/pos/inventory    Stock
/pos/shift        Cash drawer
```

**`/pos/pickups`** — a queue, newest first. Search or scan the order code,
verify the customer, hand over, mark collected. Badge count in the nav so staff
see waiting orders without looking.

**`/pos/returns`** — scan the receipt or order reference, choose lines and
quantities (partial returns are the norm), pick the refund method, and decide
where the stock goes: **back to sellable** or **damaged**. That last choice is
the one the spec is right to insist on — returned goods must not silently
become sellable.

Both screens only appear where the location has the capability, checked
server-side, not merely hidden.

---

## 6. Open decisions — these need your call

1. **Does pickup require Pro?** Locations are Pro-gated today because POS is.
   If click-and-collect depends on locations, it inherits that gate. Reasonable
   either way: pickup is a strong Pro incentive, but it's also a storefront
   feature a Basic store might expect. **This decides whether Locations is
   Pro-gated or free.**

2. **Default capabilities for existing stores.** Every store has one auto-created
   "Main" location. Proposal: it gets **everything enabled** — that's exactly
   today's behaviour, so nothing changes for anyone until they add a second
   location.

3. **Does `Locations` show for a single-location store?** Proposal above says
   hide it until it's useful. The alternative — always show it — is more
   discoverable but adds a section most merchants never need.

4. **Type — free text or fixed list?** Fixed (Shop / Warehouse / Dark store)
   lets the UI pick sensible default capabilities per type. Free text is
   flexible and means nothing to the system. Proposal: fixed.

---

## 7. Build order

Nothing here is worth building until §6.1 and §6.2 are settled, since they
decide the gating and the migration.

1. `location_capabilities` columns + backfill everything-on for existing rows
2. `/dashboard/locations` + editor; redirect the old POS route
3. Inventory location selector (closes the Phase 4 gap)
4. Fulfilment priority + retire the default-location `reserve_stock` wrapper
   — this is what fixes "website advertises the total, sells only from default"
5. Real reservations (`inventory_levels.reserved`, currently unused)
6. Pickup: checkout option → `/pos/pickups` → hold-expiry sweep
7. Returns (POS Phase 5) → returns-in-store → damaged bucket

Steps 1–4 are the ones that pay for themselves immediately. 5 onward depends on
how quickly you want click-and-collect.
