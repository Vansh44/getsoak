# Inventory System — Technical Design Document

> Status: **Proposed** · Owner: StoreMink · Scope: per-store stock tracking for the
> storefront catalog, integrated with the checkout/order system.
>
> This document is the implementation contract. It states the architecture,
> the exact schema/RPC changes, the server actions, the file-by-file code
> changes, and the phased rollout. Keep `CODEBASE.md` updated as phases land.

---

## 1. Goals & non‑goals

**Goals**

- **Quick & responsive** — O(1) stock reads, optimistic dashboard edits, cached
  catalog with an atomic guard so speed never costs correctness.
- **Very secured** — every stock write goes through store‑scoped, permission‑gated,
  atomic server operations; the storefront never writes stock; overselling is
  impossible even under simultaneous checkouts.
- **Very easy to use** — one Inventory dashboard: search, filter (low/out),
  inline edit, +/− adjust, bulk update, movement history, low‑stock alerts. No SQL.
- **Most optimised** — denormalized balance column (not ledger‑summed), single‑
  statement atomic ops, batched bulk updates, targeted indexes.

**Non‑goals (this phase)**

- Multi‑warehouse / multi‑location stock.
- Reserved/available holds with expiry (designed for, not built — see §4.3).
- Purchase orders / supplier management.
- Online‑payment reservation windows (checkout is COD today).

**Accepted decisions** (from planning):

1. Availability model = **decrement‑at‑order** (`available = stock`); restock on
   cancel. Reserved/available split is a later additive step.
2. Storefront stock visibility = **merchant‑configurable**; default shows an
   exact "Only X left" only when at/under the low‑stock threshold, otherwise a
   boolean in‑stock.
3. **Extend the settings framework to support numeric settings** (for thresholds).
4. **Backorder is supported but OFF by default** (per‑product opt‑in).

---

## 2. Current state (what exists today)

- `product_variants` already has `stock integer NOT NULL DEFAULT 0` and `sku`
  (`supabase/products_categories.sql`). The storefront already respects it:
  `product-detail-client.tsx` derives `outOfStock` and caps quantity from
  `selectedVariant.stock`.
- **Simple (variant‑less) products have NO stock field** — `products` has none,
  so such products are effectively always in stock.
- An **`inventory` permission section already exists** (`app/dashboard/lib/permissions.ts`:
  `key:"inventory"`, `href:"/dashboard/inventory"`, actions `view`/`manage`,
  group Workspace). The nav slot + role gating are ready; the page does not exist.
- **`placeOrder` does not touch stock** (`app/actions/checkout-actions.ts`).
- Orders already have a `cancelled` status; `order_items.variant_id` references
  `product_variants(id) ON DELETE RESTRICT` (`supabase/orders_table.sql`).
- **Blocker:** `replaceVariants` in `app/actions/product-actions.ts` **deletes all
  variants and re‑inserts** on every product save. Its comment ("Variants aren't
  referenced by orders yet, so this is safe") is now false — orders reference
  variants, and this would churn variant ids and overwrite stock. Must be fixed
  before inventory can be trusted (Phase 0).
- Proven precedent to reuse: the atomic coupon counter
  (`supabase/coupon_usage_rpc.sql` — `increment_coupon_usage` /
  `decrement_coupon_usage`) and the reserve→confirm→release flow already wired
  into `placeOrder`.

---

## 3. Architecture overview

```
                    ┌─────────────────────────────────────────┐
   Storefront  ───▶ │  reserve_stock() (atomic, conditional)   │ ─┐
   (checkout)       └─────────────────────────────────────────┘  │  writes
                                                                  ▼
   Dashboard   ───▶  adjust_stock() / bulk ──▶  ┌───────────────────────────┐
   (inventory)                                  │ products.stock /          │
                                                │ product_variants.stock    │  ← authoritative balance (fast reads)
   Order        ──▶  release_stock() (cancel)   │ + stock_movements ledger  │  ← append-only audit / history
   lifecycle                                    └───────────────────────────┘
```

- **Balance column** (`stock`) = single source of truth for reads.
- **`stock_movements`** = append‑only ledger; every change writes a balance +
  a ledger row atomically inside an RPC.
- **All writes via `SECURITY DEFINER` RPCs**, called from server actions through
  the **service‑role client** after app‑layer auth/permission checks.
- **Sellable unit (SKU)** = the variant when `variant_id` is set, else the product.

---

## 4. Data model

### 4.1 Stock fields on products & variants — `supabase/inventory.sql` (new, idempotent)

```sql
-- products = the simple‑product / default SKU
ALTER TABLE products ADD COLUMN IF NOT EXISTS track_inventory     bool    NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock               integer NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold integer;            -- null → store default
ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_backorder     bool    NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku                 text;

-- variants already have stock + sku; add the policy fields
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS track_inventory     bool    NOT NULL DEFAULT true;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS low_stock_threshold integer;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS allow_backorder     bool    NOT NULL DEFAULT false;

-- low/out‑of‑stock filtering per store
CREATE INDEX IF NOT EXISTS idx_products_low_stock ON products (store_id, stock) WHERE track_inventory;
CREATE INDEX IF NOT EXISTS idx_variants_stock     ON product_variants (store_id, stock);
```

**Semantics**

- `track_inventory = false` ⇒ infinite stock (never blocks) — existing simple
  products stay this way until the merchant opts in (safe backward compat).
- A line item's SKU = variant (if `variant_id`) else product.
- `low_stock_threshold` null ⇒ fall back to the store default (§7).

### 4.2 Ledger — `stock_movements` (in `supabase/inventory.sql`)

```sql
CREATE TABLE IF NOT EXISTS stock_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id    uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  delta         integer NOT NULL,          -- +restock / −sale
  reason        text NOT NULL,             -- see reason set below
  balance_after integer NOT NULL,          -- running balance snapshot (audit)
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
  note          text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- null = system/checkout
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_sku
  ON stock_movements (product_id, variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_store
  ON stock_movements (store_id, created_at DESC);
```

`reason ∈ { 'sale', 'restock', 'adjustment', 'return', 'cancellation', 'correction' }`.

**RLS** (own‑store): customers get no access; store admins/managers `SELECT` for
their store; **all writes go through the SECURITY DEFINER RPCs** (which run as
owner), so no direct `INSERT`/`UPDATE` grant to `authenticated` is required.
Add a `SELECT` policy scoped by `is_store_admin(store_id)` (mirror
`multitenant_03_rls.sql`).

### 4.3 Availability model & forward‑compat

- **Now:** `available = stock`. `reserve_stock` decrements at order placement;
  `release_stock` restocks on cancel/failure.
- **Later (additive):** add `reserved integer NOT NULL DEFAULT 0`, define
  `available = stock − reserved`, add `reserve_hold` / `release_hold` +
  an expiry cron. No breaking change to the RPC signatures below.

---

## 5. Atomic operations — `supabase/inventory_rpc.sql` (new)

All `SECURITY DEFINER`, `SET search_path = ''`, granted to `authenticated,
service_role`. Same shape/rationale as `coupon_usage_rpc.sql`.

```sql
-- Resolve which SKU column set to touch: variant when p_variant is not null,
-- else the product. Each function below applies this internally.

-- (1) Reserve for a sale — single conditional, row‑locked UPDATE. Succeeds only
--     when not tracked, backorder allowed, or enough stock. Writes a 'sale'
--     movement. Returns TRUE if reserved, FALSE if it would oversell.
CREATE OR REPLACE FUNCTION public.reserve_stock(
  p_store uuid, p_product uuid, p_variant uuid, p_qty int, p_order uuid
) RETURNS boolean ...;

-- (2) Release stock back (order failed to persist, or cancelled/returned).
--     Writes a movement with the given reason; balance floored at >= 0 only for
--     tracked SKUs. Idempotency is the caller's responsibility (see §6).
CREATE OR REPLACE FUNCTION public.release_stock(
  p_store uuid, p_product uuid, p_variant uuid, p_qty int, p_order uuid, p_reason text
) RETURNS void ...;

-- (3) Manual set/adjust from the dashboard. Applies delta atomically, writes an
--     'adjustment'/'correction' movement with balance_after and the actor.
--     Returns the new balance.
CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_store uuid, p_product uuid, p_variant uuid, p_delta int,
  p_reason text, p_note text, p_actor uuid
) RETURNS integer ...;
```

Reference implementation for (1) (the correctness core):

```sql
UPDATE <sku_table>
   SET stock = stock - p_qty
 WHERE id = <sku_id>
   AND store_id = p_store
   AND (NOT track_inventory OR allow_backorder OR stock >= p_qty)
RETURNING true INTO v_reserved;   -- COALESCE(v_reserved, false)
-- then INSERT INTO stock_movements(delta=-p_qty, reason='sale', balance_after=stock, order_id=p_order, ...)
```

Because the guard is inside the `WHERE` of a row‑locked `UPDATE`, two
simultaneous "last unit" checkouts cannot both match ⇒ **no overselling**, with
no app‑level locking. Identical guarantee to the coupon cap.

---

## 6. Checkout & order‑lifecycle integration

### 6.1 `placeOrder` (`app/actions/checkout-actions.ts`) — extend the existing reserve flow

The action already reserves the coupon before creating the order and releases it
on failure. Add stock to the **same** reserve → create → release structure:

1. After re‑pricing each line, call `reserve_stock(store, productId, variantId,
quantity, /*order*/ null)` **per line, before creating the order**.
   - Track successfully reserved lines.
   - If any returns `false` → **abort**: release every already‑reserved line +
     release the coupon, and return `{ error: "Sorry, {item} just sold out." }`.
2. Create the order + items (unchanged).
3. If the order or items insert fails → the existing rollback path additionally
   **releases all reserved stock** (extend `releaseCoupon()` → a combined
   `rollback()` that releases coupon **and** stock).
4. On success, re‑tag the movements with the new `order_id` (either pass the
   order id into `reserve_stock` in a second confirm step, or reserve with a
   client‑generated order id created before insert — see §6.3).

### 6.2 `updateOrderStatus` (`app/actions/order-actions.ts`) — restock on cancel

- Read the order's **current** status first (needed for idempotency).
- On transition **→ `cancelled`** from a non‑cancelled state: for each
  `order_items` row, `release_stock(..., reason='cancellation', order)`. Guard so
  re‑cancelling does nothing (only restock when `previous != 'cancelled'`).
- Later: `→ returned` ⇒ `release_stock(reason='return')`.

### 6.3 Idempotency & ordering

- Reserve happens exactly once per checkout (before the single order insert), so
  no double‑decrement on the happy path.
- Simplest robust approach: generate the order `id` in app code (`crypto.randomUUID()`)
  and pass it to both `reserve_stock` and the `orders` insert, so movements carry
  the real `order_id` from the start and rollback/restock can target it.
- Cancellation restock is guarded by the previous‑status check above.

---

## 7. Per‑store settings

Add to `lib/settings/registry.ts` (section `inventory`):

| key                               | type       | default | meaning                               |
| --------------------------------- | ---------- | ------- | ------------------------------------- |
| `inventory.trackByDefault`        | boolean    | `false` | new products track stock by default   |
| `inventory.allowBackorderDefault` | boolean    | `false` | default backorder for new SKUs        |
| `inventory.lowStockThreshold`     | **number** | `5`     | store default low‑stock threshold     |
| `inventory.hideOutOfStock`        | boolean    | `false` | hide sold‑out products from listings  |
| `inventory.showStockCounts`       | boolean    | `true`  | show "Only X left" at/under threshold |

**Framework change (numeric settings):** `SettingDef.type` is currently
`"boolean"` only. Extend:

- `lib/settings/registry.ts`: `type: "boolean" | "number"`; `defaultValue: boolean | number`;
  `StoreSettingValues` becomes `Record<SettingKey, boolean | number>`;
  `resolveStoreSettings` validates `typeof stored === def.type` (with a `number`
  branch).
- `app/actions/store-settings.ts`: `saveStoreSettings` accepts numbers, validates
  `Number.isFinite` + clamps to a sane range for numeric keys.
- `app/dashboard/components/feature-toggles.tsx`: render a small number `<input>`
  for `type:"number"` settings alongside the existing Switch.

Rendered on `/dashboard/inventory/settings` (gated by `can("inventory","manage")`).
Enforce every setting **server‑side** (in the read/reserve paths), never only in UI.

---

## 8. Server actions — `app/actions/inventory-actions.ts` (new) + co‑located test

```ts
// All gated by getManagerUserId("inventory"); store‑scoped; writes via service role.
getInventory({ page, pageSize, filter: 'all'|'low'|'out', q, categoryId })
   -> { rows: SkuRow[]; total: number; error? }   // product + variant SKUs, computed status
setStock(productId, variantId, quantity, note?)    // adjust_stock, reason 'correction'
adjustStock(productId, variantId, delta, reason, note?)   // restock / manual
bulkAdjust(items: { productId, variantId, delta|set }[])  // one round‑trip
getMovements(productId, variantId, page, locationId) // authorized, location-filtered drawer ledger
```

- `SkuRow`: id, product name, variant name, sku, stock, track_inventory,
  low_stock_threshold (resolved), allow_backorder, status (`in|low|out|untracked`),
  category, image.
- Pagination via `app/dashboard/lib/list-params.ts` (as orders/coupons pages do).
- Input validation: integer, bounded; reject non‑`inventory`‑managers.
- Reads may use the RLS user client; **writes call the RPCs via
  `createAdminClient()`** after the permission check.

---

## 9. Dashboard UX — `/dashboard/inventory`

New route `app/dashboard/inventory/page.tsx` + `inventory-management-view.tsx`
(client), permission `inventory`, group Workspace (nav slot already exists).

- **SKU table**: image, name (+ variant), SKU, stock, status pill
  (**In stock / Low / Out / Untracked**), reorder point.
- **Inline edit**: click stock → number input → **optimistic** update → server
  confirm → revert + toast on error (mirror the coupon Switch / order patterns).
- **Row actions**: −1 / +1, "Set…", "Restock…", "History".
- **Filters**: All / Low / Out, category, search by name or SKU; low rows
  highlighted; header count badge → feeds the sidebar `inventory` badge (replace
  today's hardcoded `"3"`).
- **Bulk**: multi‑select → "Add N" / "Set to N" → one `bulkAdjust` call.
- **History drawer**: per‑SKU ledger (who/when/why) via `getMovements`.
- Stock also editable inline on the product edit form for **simple products**
  (variants already have it); stock edits there route through inventory RPCs,
  **not** the product `replaceVariants` path.
- **Phase 4**: CSV import/export; low‑stock email alerts (reuse `lib/email/`).

---

## 10. Storefront UX

Sell against `available` (= `stock` now):

- **Out of stock** → disable add‑to‑cart, "Sold out" badge; optionally hide from
  listings when `inventory.hideOutOfStock`. Extend the current variant‑only
  handling to **simple products** (`shop-card.tsx`, `quick-add-button.tsx`,
  `product-detail-client.tsx`).
- **Low stock** → "Only X left!" when `stock ≤ threshold` and
  `inventory.showStockCounts`.
- **Quantity selector** capped at available (done for variants; extend to simple).
- **Checkout** re‑validates atomically via `reserve_stock`; on sold‑out mid‑
  checkout, show a friendly per‑item message (§6.1).
- **Privacy:** the cached catalog query exposes an `in_stock` boolean plus the
  exact count **only** when `stock ≤ threshold` (so competitors can't scrape exact
  inventory), gated by `showStockCounts`.
- **Optional realtime**: subscribe to `stock` on the PDP (Supabase Realtime,
  already used for blogs) for live counts on hot items.

---

## 11. Performance & caching

- **Balance‑as‑column** ⇒ no ledger aggregation on reads.
- **Cached catalog** (`unstable_cache` + `TAGS.products`) stays fast; displayed
  stock may be seconds‑stale, but the **atomic `reserve_stock` at checkout is the
  real guard**, so staleness never oversells. **Do not `revalidateTag` on every
  sale** (cache thrash) — only on manual dashboard edits / publish. A short
  `revalidate` TTL bounds staleness.
- **Bulk ops** in a single RPC/round‑trip.
- **Indexes** in §4.1 for low/out filters.
- **Optimistic UI** for all dashboard stock edits.

---

## 12. Security model

- Storefront **never** writes stock. Only: `placeOrder` (service role, after
  price + auth checks) and dashboard inventory actions (after
  `getManagerUserId("inventory")`).
- All mutations run through **atomic SECURITY DEFINER RPCs** matched by
  `(store_id, sku_id)` ⇒ tenant isolation + no oversell.
- `stock_movements` writes only via RPC (owner privilege); reads RLS‑scoped to
  store admins.
- Numeric/setting inputs validated + clamped server‑side.
- Backorder is per‑SKU opt‑in; default off ⇒ safe by default.
- Reuse the concurrency test approach proven on the coupon cap.

---

## 13. The variant replace‑strategy fix (Phase 0 — blocker)

`app/actions/product-actions.ts::replaceVariants` currently `DELETE`s all
variants then `INSERT`s the form set. This must change to a **stable reconcile by
id**:

- `UPDATE` existing variants (matched by id), **preserving `stock`** (never let
  the product form overwrite stock — stock flows only through inventory RPCs).
- `INSERT` new variants (no id).
- `DELETE` only variants removed in the editor — and handle the
  `order_items.variant_id … ON DELETE RESTRICT` constraint: block deletion of a
  variant that has orders (surface a friendly "can't delete a variant with
  orders; disable it instead"), or soft‑delete.
- Update `VariantFormData` to carry the variant `id` through the editor so the
  reconcile can match rows.

This is prerequisite work: without it, editing a product churns variant ids
(breaking order history + the stock ledger) and resets stock.

---

## 14. Testing

Follow the repo's `app/actions/_test-helpers.ts` mock style. Cover:

- **RPC concurrency**: two simultaneous `reserve_stock` on the last unit → exactly
  one `true` (the coupon‑cap test applied to stock).
- **inventory‑actions**: auth/permission gate, store scoping, set/adjust/bulk,
  insufficient stock, backorder allowed, untracked = always sellable.
- **checkout**: reserve on order; refuse + release on sold‑out; rollback releases
  stock on insert failure; success path.
- **order lifecycle**: restock on cancel; **no double‑restock** on re‑cancel.
- **settings**: numeric setting resolves/saves/validates.
- **UI**: optimistic edit + revert on error.

CI gates unchanged: `lint`, `typecheck`, `test`, `prettier`, `build`.

---

## 15. Phased rollout & file checklist

### Phase 0 — Unblock (variant reconcile)

- **Modify** `app/actions/product-actions.ts` (`replaceVariants` → reconcile by id;
  preserve stock), `VariantFormData` (carry `id`), variant editor UI.
- **Modify** `app/actions/product-actions.test.ts`.

### Phase 1 — Backend correctness

- **New** `supabase/inventory.sql` (columns + `stock_movements` + RLS + indexes).
- **New** `supabase/inventory_rpc.sql` (`reserve_stock`, `release_stock`, `adjust_stock`).
- **New** `app/actions/inventory-actions.ts` + `.test.ts`.
- **Modify** `app/actions/checkout-actions.ts` (reserve stock; combined rollback).
- **Modify** `app/actions/checkout-actions.test.ts`.
- **Modify** `app/actions/order-actions.ts` (restock on cancel) + `.test.ts`.
- **Modify** `lib/settings/registry.ts`, `app/actions/store-settings.ts`,
  `app/dashboard/components/feature-toggles.tsx` (numeric settings + inventory keys).

### Phase 2 — Dashboard

- **New** `app/dashboard/inventory/page.tsx`, `inventory-management-view.tsx`,
  history drawer, `settings/page.tsx`.
- **Modify** sidebar badge wiring (`permissions.ts` badge / a count source).
- Inline simple‑product stock on the product edit form.

### Phase 3 — Storefront

- **Modify** `lib/storefront/queries.ts` (expose `in_stock` + capped count),
  `shop-card.tsx`, `quick-add-button.tsx`, `product-detail-client.tsx`,
  shop listing (hide sold‑out per setting), cart/checkout sold‑out messaging.

### Phase 4 — Alerts & tooling

- Low‑stock **email alerts** (`lib/email/`), CSV import/export, optional PDP realtime.

**Docs:** update `CODEBASE.md` (new routes/actions/SQL, the inventory convention,
numeric‑settings note) in the same commits, per the AGENTS.md keep‑updated rule.

---

## 16. Open items to confirm before build

- Variant deletion with existing orders: **block + suggest disable**, or
  soft‑delete? (Default in this doc: block with a friendly message.)
- App‑generated order id (§6.3) vs a two‑step reserve‑then‑confirm — pick one
  when implementing Phase 1 (this doc assumes app‑generated id).
- Whether simple products should default `track_inventory` to the store setting
  at create time (recommended) vs always false.
