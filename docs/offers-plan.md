# Offers — the design

**Status:** ⏳ **nothing built — every decision settled** (owner, 2026-09-02).
The six open questions are answered in §18; §10 (best offer wins) is the one
that shapes the engine, and §16 Phase A is what it makes non-negotiable.
**Slots into:** `docs/roadmap.md` Step 22.
**Depends on:** `CODEBASE.md` §12 (checkout), §13 (inventory), §17 (tax/invoices),
§22 (POS), §23 (locations/pickup), §24 (notifications), §28 (returns), §29 (store
credit), §31 (import/export), §35 (shipping).

Merchants can currently give money away in exactly two shapes: a coupon code
that takes a percentage or a rupee amount off the whole cart, and a cashier
typing a number at the till. Everything else people expect from a commerce
platform — 20% off one category, buy one get one, free delivery above ₹999, ₹50
off on prepaid — has no representation at all.

This doc answers four questions: **what an offer is** (§3), **which offers**
(§4–§7), **the six decisions that are expensive to change later** (§8–§14), and
**what to build in what order** (§16).

> **★ marks a non-obvious invariant** — something that looks right by accident
> and breaks silently. Those are the lines worth re-reading during review.

---

## 1. What exists today (do not rebuild it)

| Piece                                                      | State                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coupons` table + RLS                                      | ✅ code, `percentage`/`fixed`, `min_order_amount`, `max_uses`, `used_count`, `valid_from`/`valid_until`, `status`, `show_on_storefront`, UNIQUE `(code, store_id)` |
| `coupon_user_groups` + `user_groups`                       | ✅ restrict a coupon to customer groups                                                                                                                            |
| `increment_coupon_usage` / `decrement_coupon_usage`        | ✅ atomic reserve/release, single conditional UPDATE (`supabase/coupon_usage_rpc.sql`)                                                                             |
| `validateCoupon` + `/dashboard/marketing/coupons`          | ✅ full CRUD, storefront `CouponField`, coupon email campaigns                                                                                                     |
| `PLAN_LIMITS.maxActiveCoupons` + `assertCanActivateCoupon` | ✅ free 3, basic/pro unlimited, under a per-store advisory lock                                                                                                    |
| `lib/billing/tax.ts` — `computeTax`                        | ✅ pure, allocates the order discount across lines **proportionally**, then taxes the net                                                                          |
| `lib/pos/totals.ts` — `posTotals`                          | ✅ pure, shared by the till screen AND `placePosSale`                                                                                                              |
| `lib/pos/returns.ts` — `refundBreakdown`                   | ✅ pure, re-allocates the order discount proportionally on return                                                                                                  |
| `order_items.line_discount`                                | ✅ per-line markdown; `total` is net of it, GROSS of the order discount                                                                                            |
| `product_variants.special_price`                           | ✅ the existing per-variant sale price                                                                                                                             |
| `lib/pos/audit.ts` — `sale_discount`, `price_override`     | ✅ who discounted, how much, which approver                                                                                                                        |
| **Any automatic (codeless) discount**                      | ❌ nothing                                                                                                                                                         |
| **Any product / category-scoped discount**                 | ❌ nothing                                                                                                                                                         |
| **Buy X get Y, tiers, volume breaks, bundles**             | ❌ the words do not appear in the repo                                                                                                                             |
| **A coupon applied at the till**                           | ❌ POS has manual discounts only                                                                                                                                   |
| **Per-customer usage limits**                              | ❌ `used_count` is one global counter                                                                                                                              |
| **A discount budget cap**                                  | ❌ nothing                                                                                                                                                         |
| **`/dashboard/promotions`**                                | ❌ **dead link** — see §2                                                                                                                                          |

### Four defects in the existing code this work must close

- **★ `/dashboard/promotions` is registered and has no route.**
  `app/dashboard/lib/permissions.ts` declares the `promotions` section with
  `href: "/dashboard/promotions"` and `parent: "marketing"`, and no such
  directory exists. Every merchant whose role grants it sees a sidebar entry
  that 404s. This work either fills it or removes it; leaving it is not an
  option.
- **★ A product-scoped discount CANNOT be stored in `orders.discount`.** See
  §8 — this is the single most expensive thing to get wrong, and both the tax
  path and the refund path would silently corrupt it.
- **Coupon group targeting is a known release blocker** (`CODEBASE.md` §21):
  some dashboard group selectors are not store-filtered, and `syncCouponGroups`
  clears existing links before a best-effort insert, so a failed link leaves
  the coupon public. Offers inherit group targeting, so they inherit the bug —
  fix it in the offer path rather than porting it.
- **`maxActiveCoupons` counts coupons, not offers.** A free store capped at 3
  coupons could otherwise run 40 automatic offers. §15 adds the analogue.

---

## 2. Naming — `Offers`, and a coupon becomes a delivery method

The section is **Offers**. `Promotions` goes away as a label.

**The important structural decision: a code is not a kind of offer, it is how an
offer reaches a customer.** "10% off over ₹1,000" is the same rule whether the
customer types `SAVE10` or it applies by itself. Modelling "coupons" and
"offers" as two systems means two engines, two admin screens, two sets of
stacking rules, and a merchant who cannot convert one into the other. So:

- one `offers` table, with `delivery` ∈ `automatic | code | link`
- `/dashboard/offers` is the list; **`/dashboard/marketing/coupons` 307s there**
  (307 and not 308 — an internal admin path behind a login has no SEO signals to
  consolidate, and a 308 is cached by browsers indefinitely; the same reasoning
  `/dashboard/activity` → `/dashboard/logs` used in §33)
- coupon rows migrate in place (§16 Phase A)

**★ KEEP THE `promotions` PERMISSION KEY.** Roles store the key, so renaming it
to `offers` silently revokes every grant already saved — the precedent is
`navigation`, which kept its key when it folded into the builder and survives
via `hiddenInNav`. Change the LABEL and the HREF; leave the key alone, and put a
comment on it saying why, or the next person will tidy it.

---

## 3. The model — trigger × reward × scope

**Do not model offers as a list of types.** "Buy 1 get 1", "Buy 2 get 1" and
"Buy 1 get 1 at 50% off" are one rule with different numbers; built as three
features they become three code paths that disagree about tax and returns. Every
offer is three orthogonal parts:

```
TRIGGER  what qualifies      cart total ≥ ₹1,000 / 2 units of category "Shakes" / paid online
REWARD   what they get       20% off / ₹200 off / fixed ₹499 / free item / free shipping
SCOPE    where and for whom  storefront | pos | both · which locations · which customer groups
```

The merchant never sees those words. They pick a **preset** (§7), which
pre-fills a trigger/reward pair and hides the parts that don't apply.

### The offer row, conceptually

| Field group | Holds                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| identity    | name (internal), status, priority, `delivery`, code                                       |
| when        | `valid_from`, `valid_until`, optional day-of-week + time-of-day mask                      |
| where       | channels, location ids, customer group ids                                                |
| trigger     | type + a JSON condition (`{ minSubtotal: 1000 }`, `{ categoryId, minQty: 2 }`)            |
| reward      | type + a JSON value (`{ percent: 20 }`, `{ amount: 200 }`, `{ getQty: 1, percent: 100 }`) |
| limits      | per-customer cap, total cap, **budget cap**, `combines_with`                              |

**★ Trigger and reward conditions are JSON, but the TYPE is a column.** The type
is what every query filters on and what validation switches on; burying it in
JSON means no index and no constraint. This is the `lib/settings/registry.ts`
trade in reverse: the registry stores values in jsonb because the _catalog_ is
in code, and here the catalog of types is in code too — `OFFER_TRIGGERS` and
`OFFER_REWARDS`, pure, exhaustive, and the validation for their payloads.

---

## 4. Reward types — what the customer gets

| Reward              | Example                              | Phase | Notes                                            |
| ------------------- | ------------------------------------ | ----- | ------------------------------------------------ |
| `percent_off`       | 10% off                              | A     | exists as a coupon                               |
| `amount_off`        | ₹200 off                             | A     | exists as a coupon                               |
| `fixed_price`       | any tee ₹499                         | B     | needs line scoping                               |
| `percent_off_items` | 20% off Shakes                       | B     | the biggest gap today                            |
| `buy_x_get_y`       | B1G1, B2G1, B1G2, B1G1-at-50%        | C     | one rule, four presets                           |
| `nth_free`          | 3 for the price of 2 / cheapest free | C     | falls out of `buy_x_get_y`                       |
| `volume_break`      | 3+ units @ 10% off                   | D     | grocery and POS staple                           |
| `tiered`            | ₹1,000 → 10%, ₹2,000 → 15%           | D     | an ordered list of thresholds, ONE offer         |
| `free_shipping`     | free above ₹999                      | F     | ⚠ collides with existing shipping settings (§14) |
| `free_item`         | free tumbler over ₹2,000             | G     | needs stock reservation (§12)                    |
| `bundle_price`      | these 3 for ₹999                     | H     | needs a combo definition                         |
| `credit_back`       | ₹100 store credit                    | H     | ⚠ a liability, not a discount (§14)              |
| `points_multiplier` | 2× points                            | —     | **not planned**: no loyalty system exists        |

## 5. Trigger types — what qualifies

| Trigger                                  | Phase | Why it earns its place here                                                                                                                                                                                        |
| ---------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `min_subtotal`                           | A     | your existing `min_order_amount`                                                                                                                                                                                   |
| `always`                                 | A     | an unconditional sale — the simplest offer there is                                                                                                                                                                |
| `contains_product` / `contains_category` | B     | prerequisite for every scoped reward                                                                                                                                                                               |
| `min_qty_of`                             | C     | prerequisite for BXGY and volume breaks                                                                                                                                                                            |
| `payment_method`                         | E     | **highest value per line of code.** "₹50 off on prepaid" moves orders off COD, which cuts RTO losses. `placeOrder` already branches on method and `getCheckoutConfig` already tells the client which are available |
| `fulfilment_type`                        | E     | "5% off on store pickup" is the cheapest BOPIS lever available, and pickup is fully built (§23)                                                                                                                    |
| `customer_group`                         | E     | `user_groups` + the coupon restriction already exist; this is also how wholesale pricing eventually gets built                                                                                                     |
| `first_order`                            | E     | derivable from `orders`; no new column                                                                                                                                                                             |
| `time_window`                            | E     | happy hour, weekend offers — a POS/F&B driver, and free once the mask column exists                                                                                                                                |
| `order_count` / `lifetime_spend`         | —     | VIP tiers. Cheap to add once redemptions exist; not in the first pass                                                                                                                                              |
| `birthday`, `referral`, `winback`        | —     | **not planned**: no DOB collected, no referral system, no server-side carts                                                                                                                                        |
| `near_expiry_lot`                        | —     | **not planned**: needs serial/lot tracking (roadmap Step 21)                                                                                                                                                       |

**★ SCOPE IS NOT A TRIGGER, and conflating them breaks location gating.**
Channel, location and customer group answer "may this offer be considered at
all", and they are checked _before_ evaluation with the trusted server-side
values. A trigger answers "does this cart qualify". Modelling location as a
trigger invites reading it from the cart — which the client controls.

## 6. Scope and delivery

| Axis            | Values                          | Notes                                                                                                                                            |
| --------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| channel         | `storefront` \| `pos` \| `both` | the explicit product ask                                                                                                                         |
| locations       | all, or a subset                | multi-location is built, so this is nearly free — a `location_id` array checked against the register's own location, never a client-supplied one |
| customer groups | all, or a subset                | fix the store-filtering defect from §1 here                                                                                                      |
| delivery        | `automatic` \| `code` \| `link` | `link` is a code auto-applied from `?offer=SAVE10`, which is what campaign emails actually want                                                  |

**★ A POS offer must resolve its location from the operator, never the cart.**
`resolvePosOperator` already binds every till session to one location; that is
the value the engine gets. The same rule the analytics location scope follows.

---

## 7. The merchant-facing presets

What appears in "Create offer". Six, over one engine:

1. **Amount off order** — % or ₹, optional min spend. _(Phase A; your coupons)_
2. **Amount off products** — % / ₹ / fixed price, scoped to products or categories. _(B)_
3. **Buy X get Y** — B1G1, B1G2, B2G1, and the "at 50% off" variants. _(C)_
4. **Spend more, save more** — tiers and volume breaks. _(D)_
5. **Free shipping** — threshold-based. _(F)_
6. **Gift with purchase** — free item above a threshold. _(G)_

Each then independently chooses **automatic / code / link** and **storefront /
POS / both**. Payment-method, pickup, group, first-order and time-window
conditions are _extra conditions on any preset_ (E), not presets of their own —
"₹50 off on prepaid" is preset 1 with one more condition ticked.

---

## 8. Decision — the discount lands on LINES, not the order

**This is the decision the rest of the doc depends on, and the existing code is
one proportional-allocation assumption away from silently corrupting money.**

Today the chain is coherent because the only discount is order-level:

- `orders.discount` holds the order-level discount
- `computeTax({ lines, discount })` allocates it across lines **proportionally
  to each line's amount**, then taxes the net (`lib/billing/tax.ts`)
- `order_items.total` is net of that line's own `line_discount` but **gross** of
  the order discount; `order_items.tax_amount` **already has** the order
  discount allocated into it
- `refundBreakdown` recovers the order discount as
  `orders.discount − Σ order_items.line_discount` and re-allocates it
  **proportionally**, so a return hands back exactly what was paid
  (`lib/pos/returns.ts` — its header documents precisely this trap)

**★ A PRODUCT-SCOPED OR BXGY DISCOUNT IS NOT PROPORTIONAL, so storing it in
`orders.discount` is wrong in two places at once.** Concretely — a cart of one
₹1,000 shirt (18%) and one ₹1,000 book (5%), with "20% off shirts" giving ₹200:

- **Tax base.** The whole ₹200 belongs to the shirt. `computeTax` would split it
  ₹100/₹100, understating the shirt's 18% base and overstating the book's 5%
  one. The invoice is wrong, the GST filing is wrong, and nothing errors.
- **Refunds.** Return only the book. `refundBreakdown` re-allocates ₹100 of
  discount to it and refunds ₹900 + tax for an item the customer paid ₹1,000
  for. On a Buy-1-Get-1 it is worse: return the free shirt and the system
  refunds its full ₹1,000, so the customer keeps a free shirt _and_ takes ₹1,000
  — the failure mode the returns doc calls the order-discount re-allocation
  trap, arriving from the other direction.

### The rule

Every offer's reward is **allocated to specific order lines at sale creation and
snapshotted there.** `orders.discount` remains the sum, for display and for
existing readers.

- `order_items.line_discount` stays what it is — a **manual** markdown by a
  human — because `refundBreakdown` and the thermal receipt both already read it
  that way.
- **A new `order_items.offer_discount`** carries the offer-allocated share, plus
  **`order_item_offers`** (line, offer id, offer name, amount) so a receipt and
  a return can say _which_ offer made the line cheaper. A name snapshot, not
  just an id: an offer renamed or deleted next month must not change what
  last month's invoice says.
- `computeTax` gains a **per-line discount** input. It keeps the proportional
  `discount` parameter for the order-level case, so existing callers are
  unchanged; line-level offers are passed already allocated.
- `refundBreakdown` subtracts `offer_discount` per line **directly** and
  re-allocates only the genuinely order-level remainder — which is exactly
  `orders.discount − Σ line_discount − Σ offer_discount`.

**★ THE ENGINE ALLOCATES; NOTHING DOWNSTREAM RE-DERIVES.** The moment a second
place recomputes "which line did this discount belong to", the two answers
diverge on rounding and a full return comes back ₹0.01 short — the difference a
customer notices at a counter and nobody can explain. Allocate once, in paise,
in the engine, with the remainder deterministically on the last line.

---

## 9. Decision — one pure engine, called by every surface

`lib/offers/apply.ts` — **pure**: takes a cart, a resolved offer set, and the
store's tax config; returns per-line allocations, the order-level remainder, and
which offers applied and why. No DB, no request, no operator.

Called by:

| Caller                                 | Uses it for                                            |
| -------------------------------------- | ------------------------------------------------------ |
| `placeOrder`                           | the authoritative charge                               |
| `placePosSale`                         | the authoritative charge at the till                   |
| `posTotals`                            | what the cashier quotes                                |
| `useCartTax` / cart + checkout summary | what the shopper sees                                  |
| the offer editor                       | "this would have applied to N of your last 100 orders" |

**★ THIS IS NOT A STYLE PREFERENCE — IT IS THE `posTotals` INCIDENT.** Until
2026-07-27 the till screen quoted the pre-tax subtotal while the server charged
the tax-inclusive total: a ₹238 cart was rung at ₹249.90, ₹300 cash came back
₹50.10 instead of the promised ₹62, and tendering the quoted ₹238 was refused by
the same panel that said "Paid in full ₹238". `lib/pos/totals.ts` exists solely
so the screen and the sale cannot disagree. An offer engine reachable only from
`placeOrder` guarantees a second implementation appears for the till within a
week, and it will be the one nobody tests.

**★ SO PHASE A WIRES BOTH COUNTERS, even though POS presets ship later.** Wiring
checkout first and POS "next phase" is precisely how the second implementation
gets written.

The server still re-reads prices, stock and rates from the database and
re-resolves which offers are live — the engine is arithmetic, not authorisation.
Nothing the client sends about an offer is trusted beyond a code string.

---

## 10. Decision — best offer wins ✅ SETTLED (owner, 2026-09-02)

**The engine picks whichever combination saves the customer most.** The merchant
no longer decides which offer applies; `priority` survives only as a tie-break.

### What "best offer wins" means precisely

Still **exclusive** — one offer per line, one order-level offer, one shipping
offer — but the _selection_ is by value rather than by the merchant's ordering.
That is the standard retail reading, and it is what keeps the engine tractable:
"every offer combines" is a different (and much worse) decision.

**★ IT IS A BOUNDED SCENARIO COMPARISON, NOT A SEARCH.** Optimal assignment over
N overlapping offers is a knapsack problem, and a till cannot spend 200ms on it.
The engine instead evaluates a **fixed, small set of scenarios** and takes the
best-scoring one:

| Scenario | What it tries                                     | Why it exists                                                  |
| -------- | ------------------------------------------------- | -------------------------------------------------------------- |
| A        | best per-line/group offers **+** best order offer | the usual answer                                               |
| B        | best order offer **only**                         | "20% off everything" often beats 10% off one category          |
| C        | best per-line offers **only**                     | ★ the BASE CASE — the only scenario when no order offer exists |

Shipping offers are a separate axis and are chosen independently in every
scenario (§14). Within a scenario, each line takes the single candidate that
saves _that line_ most; an offer spanning lines (BXGY) is scored across the
lines it touches and competes with the per-line alternatives on total savings.

**★ CORRECTED WHILE BUILDING (2026-09-02).** C was first justified as "an order
offer's min-spend may only be met at the undiscounted subtotal". That reason is
wrong: thresholds are measured against the undiscounted subtotal in _every_
scenario (see the rules below), so such an offer qualifies in A too. C is in
fact **provably dominated** by A — the order offer contributes ≥ 0 to the same
line set — and is evaluated only because it is the base case when there are no
order-level candidates. Recorded rather than quietly reworded, so nobody
deletes it as dead code; `lib/offers/apply.ts` carries the same note.

**★ AND `order_only` IS THE ONE THAT EARNS THE COMPARISON.** It beats A only
because a line carries at most ONE offer, so a line claimed by a line-level
offer is removed from the order offer's base. Verified by a test: 5% off shakes
(a ₹100 line) plus 20% off order, on ₹100 shakes + ₹900 other, scores ₹185 for
A and ₹200 for B. If exclusivity ever changes so both may touch one line, this
comparison becomes redundant and should be deleted rather than left running.

Cost is `O(scenarios × lines × candidates)` with all three bounded — deterministic,
and testable by asserting the chosen scenario rather than just the final number.

### The four rules that make it deterministic

- **★ CANDIDATES ARE CAPPED.** At most `MAX_EVALUATED_OFFERS` (20) live offers
  enter evaluation, ordered by `priority` then age. A merchant with 200 active
  offers must not make the register slow; and an unbounded candidate set makes
  the engine's cost a function of merchant behaviour, which is untestable.
- **★ TIES BREAK DETERMINISTICALLY, never by query order:** equal savings →
  higher `priority` → older `created_at` → lower id. Without this, two identical
  carts get different receipts and the merchant cannot reproduce either.
- **★ THRESHOLDS TEST THE UNDISCOUNTED MERCHANDISE SUBTOTAL.** A `min_subtotal`
  of ₹1,000 is measured before any offer applies. Two reasons: it is what the
  shopper expects (their cart says ₹1,050, so they qualify), and testing it
  after would be circular — applying an offer could disqualify the very offer
  that made it applicable, and the answer would depend on evaluation order.
- **★ THE ENGINE REPORTS WHAT IT REJECTED.** Output carries the winning scenario
  _and_ the runners-up with their totals. That is what makes "why did this
  customer get X and not Y" answerable at a counter, and what makes the
  merchant-side preview honest.

### ⚠ What this decision costs, stated plainly

**The merchant loses control of which offer applies, so the guardrails in §11
stop being optional.** Under exclusive-with-priority a misconfigured offer sits
behind a better-ordered one; under best-offer-wins it wins the moment it is the
most generous thing on the shelf. Three consequences:

1. **The budget cap (§11) is now load-bearing**, not a nice-to-have.
2. **A per-order discount ceiling is required** — `offers.maxTotalDiscountPercent`
   (§15). Best-offer-wins across a line offer, an order offer and free shipping
   can compound past what any single offer suggests.
3. **The offer editor must show what an offer would have won.** "This would have
   applied to 34 of your last 100 orders, at an average of ₹212" is the only way
   a merchant can predict a system that no longer follows their ordering. It is
   the same pure engine run over historical orders (§9), so it is cheap — but it
   is now a requirement of Phase A rather than a later nicety.

## 11. Decision — limits: per customer, total, and money

Four separate ceilings, and they are not interchangeable.

| Limit                            | Answers                          | Storage                         |
| -------------------------------- | -------------------------------- | ------------------------------- |
| `max_redemptions`                | how many times, by anybody       | a counter, like `used_count`    |
| `max_per_customer`               | how many times, by _this_ person | **needs `offer_redemptions`**   |
| `budget_paise`                   | how much money, in total         | a counter of allocated discount |
| `offers.maxTotalDiscountPercent` | how deep any ONE order may go    | a store setting, §15            |

**★ THE LAST TWO ARE PROMOTED FROM PRUDENCE TO NECESSITY BY §10.** Under
exclusive-with-priority a misconfigured offer sits harmlessly behind a
better-ordered one. Under best-offer-wins the engine actively seeks out the most
generous applicable rule, so a mistake wins every order it touches. Both are
needed and neither substitutes for the other: a 60%-off order is a problem even
if one customer finds it, and ₹80,000 of individually-reasonable 15% orders is a
problem even though no single one looks wrong.

**★ `increment_coupon_usage` CANNOT ANSWER "ONCE PER CUSTOMER".** It is a single
conditional UPDATE on one global `used_count`, which is exactly right for a
global cap and structurally incapable of a per-person one: it knows how many
times a code was used, never by whom. So `offer_redemptions` (offer, customer,
order, when) is a table, not a column — and it doubles as the report of who
redeemed what, which merchants ask for immediately.

**★ THE BUDGET CAP IS THE ONE NOBODY ASKS FOR AND EVERYONE NEEDS.** A merchant
means "₹100 off" and types "₹1,000 off"; or sets 20% off without realising it
also applies to their ₹40,000 item. The offer goes live at 11pm, someone posts
it in a deals group, and by morning a month's margin is gone — with every
individual order perfectly valid, so nothing anywhere errors. "Stop once
₹50,000 of discount has been given" is a brake that needs no one watching.

**★ ALL THREE ARE CLAIMED ATOMICALLY, BEFORE THE ORDER EXISTS**, the way
`increment_coupon_usage` already is: a single conditional UPDATE whose guard is
in the `WHERE`, released if the order then fails to persist. A read-then-write
lets two simultaneous checkouts both pass the last redemption. The budget cap
needs the _allocated amount_, so its claim happens after the engine runs and
before the order is written — same position in `placeOrder` as the coupon
reservation today.

⚠ `max_per_customer` requires an identified customer. Website checkout always
has one (`placeOrder` rejects anonymous). POS now requires a customer before any
pricing write (§22), so both counters can enforce it — but a legacy anonymous
POS row cannot, and an offer with a per-customer cap must therefore refuse
rather than silently allow. Fail closed.

---

## 12. Decision — a free gift is stock leaving the shelf

A `free_item` reward adds a real line at ₹0, and it goes through **the same
reservation as any paid line** — `reserve_stock_at` online, the register's own
location at the till.

**★ WITHOUT THAT, THE OFFER OVERSELLS SILENTLY AND ADVERTISES ITSELF DOING IT.**
Ten tumblers, fifty qualifying orders, fifty confirmation emails promising a
tumbler, forty apologies — plus a stock count that is simply wrong, because
nothing told inventory those units were promised. The engine must also _stop
offering_ the gift when available stock (`on_hand − reserved`) hits zero, rather
than promising it and failing at reserve time.

**★ A ₹0 LINE IS NOT A ZERO-TAX LINE.** It carries the gift product's own tax
class. Under India's GST a free good given with a sale is not automatically
outside the tax base, and inventing ₹0 tax here is a filing decision disguised
as an implementation detail. Phase G does not ship until a professional has
confirmed the treatment — the §25/§28 posture: build the fields, get it checked
before anyone files against it.

---

## 13. Decision — every automatic discount is attributable

**★ WITHOUT ATTRIBUTION THE P&L HAS AN UNEXPLAINABLE HOLE.** Month end shows
₹80,000 of revenue missing; the manual discount log explains ₹12,000. The other
₹68,000 came from automatic offers, and with no per-offer record the merchant
cannot tell a working promotion from a misconfigured rule, cannot answer "why is
margin down", and cannot decide which offer to stop.

That is closed by **`order_item_offers` + `offer_redemptions`** (§15): every
line records which offer discounted it, by how much, under a snapshotted name,
and every redemption records who, when and against which order. Per-offer,
per-line, per-customer — strictly more than a log line carries.

Analytics gets it for free: gross margin already reads immutable
`order_items.unit_cost` (§20 Phase 10), so discount-per-offer against cost is a
join, not a new pipeline.

### ★★ REVISED WHILE BUILDING (2026-09-02): NO `offer_applied` EVENT, AND NO POS AUDIT ROW

This section originally called for a new `offer_applied` entry in
`lib/pos/audit.ts` and an activity event beside it. Both were dropped, because
each contradicts a rule this codebase already holds — and adding them would
have made two logs worse without making anything answerable.

- **The POS money audit exists to attribute a HUMAN CHOICE.** Its own
  precedent settles this: `CODEBASE.md` §22 records that a gateway tender is
  _deliberately not audited_ because "the cashier chose nothing and it is
  reconstructible from `order_payments` + `orders.cashier_id`; noise is what
  makes an audit stop being read." An automatically applied offer is exactly
  that case — nobody at the till chose it, and it is fully reconstructible from
  the two new tables. A row per offer per sale would bury `sale_discount` and
  `price_override`, which DO record a person's decision.
- **An activity event per applied offer would double every order's feed.**
  `order.placed` already fires for the same moment, and §24's rule is that
  per-row events "bury every other thing that happened that day". The offer
  detail belongs on the order, and it is on the order.
- **⚠ REVISIT IF THE TILL EVER TAKES A CODE.** Phase A's register applies
  automatic offers only — there is no code field on the sell screen. A cashier
  typing a code IS a choice, and one open to abuse (their own code, on a
  stranger's sale), so `offer_code_entered` would then earn a `pos_audit_log`
  row on the same grounds `sale_discount` does.

---

## 14. Decision — what offers deliberately do NOT touch

### The collection counter stays out

**★ DO NOT RE-PROPOSE DISCOUNTING AT PICKUP.** Roadmap Step 18 dropped it by
owner decision (2026-08-18) and the reasoning is unchanged: a collection is
already placed and invoiced, with GST computed against `orders.total` and an
`order_ref` issued. "Knock ₹50 off, it is damaged" is a partial refund or store
credit — both built (§26, §29), both leaving a proper record. **Offers apply at
sale creation; they never alter a sale already issued.** The till discounts a
sale it is _creating_, which is a different act.

### Sale prices stay where they are — but how they interact is the merchant's call ✅ SETTLED (owner, 2026-09-02)

`product_variants.special_price` is **not folded into offers.** It is a property
of the product — it shows in the catalogue, in search, on the card, and Mink
Phase 5F already reasons about it. An offer is a rule evaluated against a cart.
Merging them would put the offer engine on every catalogue read, which is the
change that makes the storefront slow.

What a line on a special price does when an offer also covers it is a **`select`
setting**, `offers.onSalePrice`:

| Value   | Behaviour                                                                                          | The merchant who wants this                                                                             |
| ------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `best`  | the line takes whichever is cheaper — special price OR the offer off the regular price, never both | most stores, most of the time: margin-safe and needs no thought                                         |
| `skip`  | a line on a special price is excluded from offers entirely                                         | "sale items are already discounted" — the clearest promise to a customer                                |
| `stack` | the offer applies on top of the special price                                                      | **"EXTRA 20% off sale items"** — impossible without it, and the reason `best` cannot be the only option |

**★ DEFAULT `best`, and the default is doing real work.** It is the only value
that cannot give away more than the merchant intended: `stack` compounds two
markdowns, and under §10's best-offer-wins the engine will _seek out_ that
compounding. A merchant who wants an extra-off-sale promotion ticks `stack`
deliberately; nobody arrives at it by accident.

**★ THIS IS A `select`, SO THE OPTION LIST IS THE VALIDATION** — `resolveStoreSettings`
refuses a stored value outside `options` and falls back to the default, and
`saveStoreSettings` re-checks it server-side. Use ids that read as data
(`best`, `skip`, `stack`), never prose, because they are what lands in the jsonb.

**★ BOTH CHANNELS MUST TELL THE ENGINE WHAT A LINE IS ON SALE FROM, and one
did not.** The engine's contract is that `unitPrice` is what will be charged
(already reflecting `special_price`) and `regularUnitPrice` is the non-sale
price, with **absent or equal meaning "not on sale"**. That default is
convenient and it fails silently: `placePosSale` passed the pair, `placeOrder`
passed only `unitPrice`, so online every sale line looked full-price and all
three modes collapsed to the same arithmetic — `skip` did not skip and `stack`
did not stack, with nothing raising an error. It was not a shortcut at the
time: `placeOrder` charged `selling_price` and never read `special_price`, so
there genuinely was no sale price for an offer to interact with. Both halves
are fixed together — `placeOrder` now charges the special price through
`lib/pricing.variantEffectiveSelling` and passes `regularUnitPrice`, so the
setting is live in both channels and a basket prices identically in either.
⚠ `regularUnitPrice` is the **selling price, never `base_price`**: MRP is a
struck-through list price, and treating it as a sale price would let `best`
discount from a much higher base.

**★ AND IT IS A PRICING RULE, SO THE ENGINE OWNS IT — not the UI.** The setting
is resolved server-side and passed into the pure engine as an input, the way the
tax config is. A storefront badge that reads it independently is a second
implementation of the rule, and the two will disagree on exactly the carts the
merchant is watching.

### Free shipping is an offer, and it may only ever make shipping cheaper ✅ SETTLED (owner, 2026-09-02)

Confirmed shape: **"free shipping above ₹500"** is a `free_shipping` reward with
a `min_subtotal` trigger — one offer row, no new machinery.

`store_shipping_settings` already carries a free-above-threshold (§35), so two
authorities now speak to one number. **The rule: the shipping setting is the
store's standing policy, an offer may only reduce the shipping charge, and the
quote takes the lower of the two.**

**★ THAT RULE IS WHAT MAKES "FREE ABOVE ₹500" WORK AT ALL.** A store whose
standing policy is free-above-₹999 and whose offer is free-above-₹500 has, in
effect, temporarily lowered its threshold to ₹500 — which is exactly the intent,
and it falls out of cheapest-wins with no special case. The alternative
(offer-overrides-setting) would make the offer _raise_ the charge for a ₹1,200
cart that the standing policy already ships free. Any rule other than
cheapest-wins produces a cart where adding items increases delivery cost.

**★ SHIPPING IS A SEPARATE AXIS IN §10's SCENARIOS**, chosen independently
rather than competing with merchandise offers. A shopper should not lose free
delivery because a category discount happened to score higher — they are
different pockets of the bill, and merchants universally expect both.

⚠ Shipping is quoted live from the carrier for Shiprocket stores (§35), so a
`free_shipping` offer sets the customer-facing charge to zero while the merchant
still pays the courier. The margin impact is real and invisible on the order —
the Help guide must say so, and the offer editor should show the average quoted
shipping cost for the period alongside the discount total.

### Cashback is not a discount

`credit_back` issues store credit through the existing ledger (§29). It does not
reduce `orders.total`, does not change the tax base, and appears on no invoice —
credit is a **payment** in this system, and the store-credit design is explicit
that netting it off would understate the sale and mis-compute GST. It is a
marketing reward with a liability attached, which is why it is Phase H and not
Phase A.

---

## 14b. Decision — the engine reports near misses ✅ SETTLED (owner, 2026-09-02)

"You're ₹200 away from free delivery" ships, and the engine reports it — the
storefront never computes it.

`applyOffers` returns `nearMiss[]` alongside the applied set: for each offer the
cart _almost_ qualifies for, the gap and the promise. Two gap shapes cover
everything planned:

| Trigger        | Gap          | Rendered as                        |
| -------------- | ------------ | ---------------------------------- |
| `min_subtotal` | rupees short | "Add ₹200 more for free delivery"  |
| `min_qty_of`   | units short  | "Add 1 more shake to get one free" |

**★ IT MUST COME FROM THE ENGINE, OR IT WILL LIE.** The nudge is a claim about
what happens if the shopper adds something, and only the engine knows the
answer — under §10's best-offer-wins, whether an offer would actually apply
depends on what it is competing with. A storefront that computes "₹1,000 −
subtotal" independently will promise an offer the engine then declines because
another one scored higher, on precisely the carts where a shopper is paying
attention.

**★ NEAR MISSES ARE FILTERED TO WHAT THIS VIEWER WOULD ACTUALLY GET.** A
group-restricted or code-delivery offer is **never** nudged. Nudging "you're
₹200 from 20% off with `WHOLESALE20`" leaks a targeted code to every visitor,
and the group restriction was the whole point of setting it. So: automatic and
`link` offers whose scope the viewer already satisfies, and nothing else.

**★ ONE NUDGE, THE CLOSEST ONE.** Three simultaneous "you could save more"
banners is noise that trains people to ignore the strip. Rank by gap, show the
nearest, and cap the gap at a fraction of the cart (nudging someone ₹4,000 short
of a threshold is not encouragement, it is a reminder that they cannot afford
it).

Rendered in the cart drawer, the cart page and the checkout summary — all three
already call the engine for tax display via `useCartTax` (§9), so the data
arrives with no extra round trip.

⚠ Cheap now, expensive later: it needs the engine to evaluate _unsatisfied_
triggers rather than short-circuiting on the first failure. That shapes the
evaluation loop, which is why it belongs in Phase A and not in a "polish" phase.

---

## 14c. Decision — Mink AI gets full offer authority, behind its own gate ✅ SETTLED (owner, 2026-09-02)

Mink can read, propose, create, update and activate offers — the whole surface —
following the Phase 4/5 pattern exactly: **a saved private proposal, an exact
short-lived human approval, tenant/permission/tool/version rechecks, idempotent
transactional execution, and an append-only outcome.** No model tool ever
executes; Gemini gets proposal tools only.

| Piece                                     | Follows                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `propose_offer` / `propose_offer_update`  | Phase 4C coupon create/update — same proposal + approval shape                             |
| `manage_offers` operator gate             | independent, **default off**, revocable per store, shuts with drafting or the beta         |
| `POST /api/mink/drafts/[id]/offer-action` | same-origin, no-store, strict-key, streamed-body-capped, separately rate-limited           |
| Approval hash                             | binds actor, draft, tool, exact fields **and** the offer's resource version                |
| Rollback                                  | delete an unactivated, never-redeemed offer; revert an update against its exact checkpoint |

### Three tightenings an offer needs that a coupon does not

**★ 1. A BUDGET CAP IS MANDATORY IN EVERY MINK PROPOSAL.** Refuse a proposal
without one. A coupon needs a customer to type it; an automatic offer applies
itself to every qualifying order from the instant it goes live, and under §10 it
wins whenever it is the most generous rule present. The cap is the difference
between a mistake that costs a bounded amount and one that costs whatever the
weekend's traffic was.

**★ 2. CREATED DISABLED, ALWAYS — activation is its own approval.** The 4C
precedent (coupons are created disabled and hidden) holds, and here it carries
more weight: a disabled offer costs exactly nothing, so the review can take as
long as it needs. Activation is a **separate** approval with its own preview
showing the budget cap, the per-order ceiling and the projected reach from the
editor's historical replay (§10). "Mink is capable of everything" and "one
approval does everything" are different claims; this is the first.

**★ 3. THE PROPOSAL IS CAPPED IN DEPTH, not just in total.** A proposed offer may
not exceed `offers.maxTotalDiscountPercent`, and the tool declaration says so, so
the model is not asked to guess a limit it cannot see. A budget cap bounds the
damage over time; a depth cap stops a single 80%-off order going out at all.

⚠ Not in Phase A. This lands after the engine, the limits and the audit trail
exist — proposing offers into a system that cannot yet cap or attribute them is
the wrong order, and the Mink phases have always followed the shipped feature
rather than led it.

---

## 15. Schema sketch

New, all store-scoped with RLS in the `coupons` shape (anon may read only what
the storefront must display; every write is admin or service-role):

| Table               | Holds                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `offers`            | the row from §3 — identity, window, scope, trigger type + JSON, reward type + JSON, limits, counters |
| `offer_products`    | product/variant/category scoping (a join table, not an array — it must be indexable and FK-checked)  |
| `offer_locations`   | location subset                                                                                      |
| `offer_user_groups` | group restriction (the `coupon_user_groups` shape, with the §1 defect fixed)                         |
| `offer_redemptions` | one row per redemption: offer, customer, order, amount, when                                         |
| `order_item_offers` | which offer discounted which line, by how much, with the offer NAME snapshotted                      |

Column additions:

| Column                              | Why                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `order_items.offer_discount`        | the per-line allocated share (§8)                                         |
| `orders.offer_ids` or a header join | which offers touched this order, for the drawer and the receipt           |
| `PLAN_LIMITS.maxActiveOffers`       | **free 3, basic `null`, pro `null`** — see the plan-gating decision below |

**★ `offers` DOES NOT REPLACE `coupons` BY DROPPING IT.** Phase A migrates rows
and repoints readers; the table stays until nothing references it, the way
`homepage_sections` and `store_subscriptions` were kept as their own audit
trail. `orders.applied_coupon_code` in particular is historical data on issued
invoices and is never rewritten.

### Plan gating ✅ SETTLED (owner, 2026-09-02)

**`maxActiveOffers`: free 3, Basic unlimited, Pro unlimited. Every offer type on
every plan.** A straight generalisation of `maxActiveCoupons`, which is already
free 3 / basic `null` / pro `null`.

- **★ IT HAD TO PRESERVE THE FREE ALLOWANCE.** Gating Offers behind Basic would
  remove capability free stores have today — three active coupons — which is
  invariant 1 in its plainest form. Any gating design that does not keep those
  three working is wrong before it is evaluated on business merit.
- **★ NO PER-REWARD-TYPE ENTITLEMENT, and that is a real simplification.** The
  engine never asks "may this plan use BXGY", so there is no per-type gate to
  enforce in the hot path, no soft-downgrade story per type, and no way for an
  entitlement check to disagree with what the offer editor offered.
- **Enforced by `assertCanActivateOffer`**, modelled on
  `assertCanActivateCoupon`: a per-store advisory transaction lock, then a count
  of active offers inside the same transaction, so two simultaneous activations
  cannot both pass the cap.
- **★ THE CAP COUNTS ACTIVE OFFERS, and coupons are offers now (§2).** After the
  Phase A migration there is one pool. Counting them separately would hand a
  free store 3 + 3, which is the bypass the row above exists to close.
- Soft downgrade follows the platform contract: an over-cap offer **pauses**,
  nothing is deleted, and the same stored offer becomes available again on
  re-upgrade.

⚠ The cost of this choice, accepted knowingly: BXGY and bundles stop being an
upgrade lever. If offers later need to sell a tier, the least disruptive knob is
the _cap_ (free 3 → Basic 25 → Pro unlimited), not per-type gating — a number is
a soft downgrade, whereas removing a type breaks live offers.

### Settings

Group **Offers**, section `promotions` — the existing permission key (§2).

| Key                              | Type    | Default | Notes                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offers.autoApply`               | boolean | `false` | ★ **backfills OFF.** Invariant 1: a migration may not change what a live store does, and a store that has only ever had codes must not wake up applying discounts by itself. New stores get it ON at signup — a creation default and a backfill are different questions |
| `offers.showBadges`              | boolean | `true`  | "20% off" flashes on product cards and the PDP                                                                                                                                                                                                                          |
| `offers.showNearMiss`            | boolean | `true`  | the "₹200 away from free delivery" nudge (§14b)                                                                                                                                                                                                                         |
| `offers.onSalePrice`             | select  | `best`  | `best` \| `skip` \| `stack` — how an offer treats a line already on `special_price` (§14). ★ The option list IS the validation                                                                                                                                          |
| `offers.maxTotalDiscountPercent` | number  | `50`    | 0–100. The per-order depth ceiling §10 requires. ★ A real `0` means "no offer may discount anything" and must survive the fallback — read it with `typeof === "number"`, never `Number(x) \|\| 50`, which is the `pos.maxDiscountPercent` trap                          |

---

## 16. Build order

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                                                              | Size  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| **A** | **The spine.** `offers` + `offer_redemptions` + `order_item_offers`, the pure engine with §10's scenario comparison, per-line allocation, `computeTax` per-line input, `refundBreakdown` offer-aware, all four limits, the audit event, **near-miss reporting**, **the historical-replay preview**, **both counters wired**, coupons migrated, `/dashboard/offers` with preset 1, the dead `promotions` link fixed | **L** |
| **B** | ✅ **DONE** — product/category scoping, `fixed_price`, `contains_*` conditions, badges on cards                                                                                                                                                                                                                                                                                                                    | **M** |
| **C** | Buy X get Y and `nth_free` — the four BXGY presets, and the first multi-line offer group in the engine                                                                                                                                                                                                                                                                                                             | **M** |
| **D** | Tiers and volume breaks                                                                                                                                                                                                                                                                                                                                                                                            | **M** |
| **E** | The extra conditions: payment method, fulfilment type, customer group, first order, time window, location subset                                                                                                                                                                                                                                                                                                   | **M** |
| **F** | Free shipping — the reward, the cheapest-wins reconciliation with `store_shipping_settings`, and the near-miss nudge's main use (§14, §14b)                                                                                                                                                                                                                                                                        | **M** |
| **G** | Gift with purchase — stock reservation, ₹0 line, **GST treatment confirmed first**                                                                                                                                                                                                                                                                                                                                 | **M** |
| **H** | Bundles and cashback-as-credit                                                                                                                                                                                                                                                                                                                                                                                     | **L** |
| **I** | Mink offer authority — proposals, the `manage_offers` gate, mandatory budget cap, separate activation approval (§14c)                                                                                                                                                                                                                                                                                              | **M** |

**★ WHY A IS ONE BIG PHASE AND NOT SIX SMALL ONES.** Every item in it is a thing
that cannot be added later without rewriting what shipped:

- **line-level allocation** changes the schema and both money paths (§8)
- **the shared engine** changes who calls what, and shipping it behind
  `placeOrder` alone guarantees a second implementation for the till (§9)
- **the scenario comparison** shapes the evaluation loop (§10)
- **near-miss reporting** requires evaluating _unsatisfied_ triggers rather than
  short-circuiting on the first failure — the same loop (§14b)
- **the four limits** change the reservation sequence in `placeOrder` (§11)
- **the historical-replay preview** is the only way a merchant can predict
  best-offer-wins, so it is a requirement of the decision, not a nicety (§10)

Shipping preset 1 without them buys a slightly better coupon system and a
migration.

**★ I IS LAST DESPITE MINK HAVING FULL AUTHORITY.** Proposing offers into a
system that cannot yet cap or attribute them is the wrong order; every Mink phase
so far has followed the shipped feature rather than led it.

★ Per `AGENTS.md`: each phase updates `CODEBASE.md`, adds its user stories to
`docs/pos-acceptance.md` where POS behaviour changes, and ships its Help Centre
guide as a forward-only migration in `drizzle/migrations/sql/`. Three things the
guides must state plainly rather than let merchants discover: how
`offers.onSalePrice` behaves in each of its three modes (§14), that a
`free_shipping` offer zeroes the customer's charge while the merchant still pays
the courier (§14), and that best-offer-wins means the engine — not the
merchant's ordering — chooses which offer applies (§10).

---

## 17. Considered and rejected

- **A separate `promotions` engine alongside coupons.** Two engines, two
  stacking policies, and no way to convert a code into an automatic offer. §2.
- **Storing the whole discount in `orders.discount` and scoping only in the
  UI.** The cheapest-looking option and the one that silently mis-files GST and
  over-refunds returns. §8.
- **Exclusive-by-default with merchant priority.** Was the recommendation;
  **overruled by the owner in favour of best offer wins** (2026-09-02). Recorded
  because the reasoning against it — that the merchant can no longer predict
  which offer applies — is what promoted the budget cap, the per-order ceiling
  and the historical-replay preview into Phase A requirements. §10, §11.
- **★ Optimal (knapsack) assignment of offers to lines.** This is what
  "best offer wins" must NOT be built as. Genuine optimisation over N
  overlapping offers is exponential, unbounded in cost as a function of how many
  offers a merchant creates, and impossible to explain at a counter. §10 ships a
  bounded three-scenario comparison instead: deterministic, testable by
  asserting the chosen scenario, and near-optimal for every realistic cart.
- **Every offer combines (true stacking).** The other reading of "best offer
  wins", and the one that gives away 45% when a merchant intended 20%. Exclusive
  selection _by value_ is what was chosen. §10.
- **Per-customer limits via a counter on the offer row.** Structurally cannot
  work; `used_count` knows how many, never by whom. §11.
- **Per-reward-type plan gating.** Considered for §15 and rejected with the
  gating decision: it puts an entitlement check in the engine's hot path, needs
  a soft-downgrade story per type, and can disagree with what the offer editor
  offered. If offers must sell a tier later, move the _cap_, not the types. §15.
- **Discounting at the collection counter.** Already decided against, twice.
  §14.
- **Folding `special_price` into the offer engine.** Puts the engine on every
  catalogue read. The interaction is a setting instead. §14.
- **A `tags` or `collections` system to scope offers by.** Tempting, because
  `products.category_id` is a _single_ category and there is no tag system — so
  "20% off everything under ₹500" or "off these 12 SKUs" needs an explicit
  product list. `offer_products` is that list. A collections system is a real
  feature with its own storefront surface and belongs in its own step, not
  smuggled in as offer plumbing.
- **Near-miss nudges for code and group-restricted offers.** Leaks a targeted
  code to every visitor and defeats the restriction that was deliberately set.
  §14b.
- **Loyalty points, referrals, birthday offers.** Each needs a system that does
  not exist. Listed in §4/§5 as not-planned so they are not mistaken for gaps.

---

## 18. Decisions — all settled (owner, 2026-09-02)

| #   | Question                | Decision                                                                                                                                                                   | Where |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | Stacking                | **Best offer wins** — exclusive selection by value, bounded three-scenario comparison, priority demoted to a tie-break                                                     | §10   |
| 2   | Plan gating             | **`maxActiveOffers`: free 3, Basic/Pro unlimited; every type on every plan.** No per-reward-type entitlement                                                               | §15   |
| 3   | Mink authority          | **Full** — read, propose, create, update, activate. Own default-off gate, mandatory budget cap, created disabled, activation is a separate approval                        | §14c  |
| 4   | `special_price` + offer | **Configurable**: `offers.onSalePrice` = `best` (default) \| `skip` \| `stack`                                                                                             | §14   |
| 5   | Free shipping           | **An offer may only reduce shipping**; the quote takes the lower of offer and standing policy. "Free above ₹500" is a `free_shipping` reward with a `min_subtotal` trigger | §14   |
| 6   | Near-miss nudge         | **Ships in Phase A**, reported by the engine, one nudge, never for code or group-restricted offers                                                                         | §14b  |

**Nothing is open.** Two consequences of decision 1 are worth re-reading before
Phase A starts, because they are requirements rather than suggestions: the
per-order discount ceiling (§11) and the offer editor's historical replay (§10).
Best-offer-wins takes the choice of which offer applies away from the merchant,
and those two are what give it back as _prediction_ and _bounds_.
