# Locations & Fulfilment — Information Architecture

**Status:** decisions settled (§6); building in the order at §7.
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

The Locations left panel keeps this store-wide workflow next to **All
locations**, so it remains discoverable for a single-location shop that wants
pickup as well as for a multi-location routing setup.

```
Website order routing
┌ Routing method ──────────┬ Location priority ─────────────────┐
│ ✓ Priority order         │  1  Warehouse                 ↑  ↓ │
│   First location with    │  2  Delhi Store               ↑  ↓ │
│   enough stock wins.     │                                     │
│                          │ Not fulfilling online orders        │
│ More methods later.      │ Mumbai Store   [Enable in location] │
├──────────────────────────┴─────────────────────────────────────┤
│ ☑ Skip deactivated locations                    [Save routing] │
└────────────────────────────────────────────────────────────────┘

Checkout
┌ Pickup availability, hold window and payment policy ──────────┐
└────────────────────────────────────────────────────────────────┘
```

Mumbai appears greyed with the reason, rather than being absent — otherwise a
merchant wonders why their shop is missing. Routing and Checkout share one
responsive width; the two routing columns stack on a narrow screen.

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

All existing `pos.*` settings are genuinely about the till and stay put:
`enabled`, `idleLockMinutes`, `allowPriceOverride`, `ownerOnlyDiscounts`,
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

`app/dashboard/lib/permissions.ts`, group **Sell in person**:

```
Locations        ★ opens its own panel
  ├ All locations
  └ Online fulfilment & pickup
Point of Sale
  ├ Overview
  ├ Staff
  ├ Devices
  └ Settings
```

`Locations` above `Point of Sale` reads as "places, then what you do there",
while its child panel keeps location-wide routing next to the place records it
orders.

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

**`/pos/pickups`** — a queue, newest first (merged with returns; see CODEBASE.md §22 "the shell"). Search or scan the order code,
verify the customer, hand over, mark collected. Badge count in the nav so staff
see waiting orders without looking.

**`/pos/pickups`** (detail at `/pos/returns/[orderId]`) — scan the receipt or order reference, choose lines and
quantities (partial returns are the norm), pick the refund method, and decide
where the stock goes: **back to sellable** or **damaged**. That last choice is
the one the spec is right to insist on — returned goods must not silently
become sellable.

Both screens only appear where the location has the capability, checked
server-side, not merely hidden.

---

## 6. Decisions — SETTLED

1. **Pickup requires Pro.** It inherits the gate from Locations, which inherits
   it from POS. Consequence: a Basic store never sees the Locations section, has
   exactly one location, and gets neither click-and-collect nor returns-in-store.
   Consistent, since a Basic store cannot have a second location anyway.

2. **Capabilities are OFF by default — with one exception that must not be got
   wrong.** There are two different questions here and conflating them breaks
   live stores:

   **New locations** — only the basics are on. Nothing customer-facing is
   assumed:

   | Capability           | Shop | Warehouse | Dark store |
   | -------------------- | :--: | :-------: | :--------: |
   | Sell here (POS)      |  ✅  |    ❌     |     ❌     |
   | Fulfil online orders |  ❌  |    ✅     |     ✅     |
   | Customer pickup      |  ❌  |    ❌     |     ❌     |
   | Accept returns       |  ❌  |    ❌     |     ❌     |
   | Receive stock        |  ✅  |    ✅     |     ✅     |
   | Stock transfers      |  ✅  |    ✅     |     ✅     |

   A merchant adding a second shop must deliberately turn on online fulfilment
   and pickup. Neither should start happening because they created a location.

   **The EXISTING "Main" location is a backfill, not a default.** Its
   capabilities must describe what that store already does today, or the
   migration silently breaks it:

   | Capability           |    Backfill     | Why                                                                          |
   | -------------------- | :-------------: | ---------------------------------------------------------------------------- |
   | Sell here (POS)      | = `pos.enabled` | Match reality                                                                |
   | Fulfil online orders |     **✅**      | It is where online orders already fulfil from. OFF here stops checkout dead. |
   | Customer pickup      |       ❌        | New feature, opt in                                                          |
   | Accept returns       |       ❌        | New feature, opt in                                                          |
   | Receive stock        |       ✅        | `/dashboard/inventory` already writes here                                   |
   | Stock transfers      |       ✅        | Already permitted                                                            |

   The rule: **a capability that describes existing behaviour is backfilled ON;
   a capability that introduces new behaviour is backfilled OFF.** Only pickup
   and returns are genuinely new.

3. **A single-location store does not see the Locations section.** It appears
   when the store has 2+ locations, or POS is enabled. Reachable from the
   Inventory location selector regardless, so it is never a dead end.

4. **Location type is a fixed list:** `shop` | `warehouse` | `dark_store`.
   Fixed lets the editor propose the defaults in the table above when a type is
   chosen, which free text cannot.

## 7. Build order

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
