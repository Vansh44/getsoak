# Autopay — what is built, and how to turn it on

Autopay means StoreMink debits a merchant's registered mandate at renewal
instead of issuing an invoice they pay by hand. It is **built and off**.

Turning it on is one line — `RECURRING_CHARGE_VERIFIED` in
`lib/billing/gateway.ts` — but do not flip it until the run below passes
against a **test-mode** Razorpay account. Everything after that line charges
real merchants.

---

## What "built" covers

| Piece                                       | State                                                         |
| ------------------------------------------- | ------------------------------------------------------------- |
| Customer creation                           | `rzpCreateCustomer` — idempotent via `fail_existing: "0"`     |
| Authorisation order (registers the mandate) | `rzpCreateAuthorizationOrder`                                 |
| Subsequent charge                           | `rzpChargeMandate` + `chargeMandateViaRazorpay`               |
| Mandate recording                           | `activateMandate` in `lib/billing/enrol.ts` (already existed) |
| Collection routing                          | `collectionRoute` — mandate ceiling AND the AFA limit         |
| Unknown-outcome handling                    | `collect.ts` + `lib/billing/reconcile.ts`                     |
| Checkout token capture                      | `ensureRzpCustomer` + `readMandateFromPayment`                |

The API shapes were taken from Razorpay's published reference on **2026-08-14**,
not inferred:

- `POST /customers` — `{name, email, contact, fail_existing: "0"}`
- `POST /orders` — `{amount, currency, customer_id, method, token: {max_amount, expire_at, frequency}}`
- `POST /payments/create/recurring` — `{email, contact, amount, currency, order_id, customer_id, token, recurring}`

What is **not** verified is live behaviour: what a real decline looks like, what
arrives on a retry, and how UPI mandate confirmation is timed.

---

## Two things that shaped the design

**A recurring charge is TWO calls.** `/payments/create/recurring` requires an
`order_id`, so the implementation creates an order and then charges it. The gap
between them is the risk: an order created and a charge we never got an answer
to is indistinguishable from a charge that worked. Every failure in
`chargeMandateViaRazorpay` therefore maps deliberately, and the default is
`unknown` — never `failed`. `collect.ts` never retries an unknown and never
opens a grace window for one.

**₹99,999 is Razorpay's ceiling on `token.max_amount`.** A Pro-yearly merchant
with five extra locations provisions to ₹1,16,000, and their _authorisation
order_ would be rejected — they could not set autopay up at all, with an opaque
gateway error. `mandateFitsGateway()` answers that instead of clamping: a
clamped mandate would be created, never usable, and the merchant would be told
autopay was on. Offering nothing is honest; offering a mandate we cannot charge
is the "promise a charge that never comes" failure again.

---

## How the mandate is captured

`startEnrolment` creates a Razorpay customer and an AUTHORISATION order instead
of a plain one, but only when all three of these hold — each is a way a merchant
would otherwise be told autopay is on and then invoiced by hand forever:

- `RECURRING_CHARGE_VERIFIED` is true (we can actually collect),
- `mandateFitsGateway(size)` — above ₹99,999 the authorisation order itself is
  rejected,
- a billing contact exists, since a mandate belongs to a _customer_.

Fail any one and it stays an ordinary one-time checkout.

**★★ `confirmEnrolment` then reads the token from the PAYMENT, not from the
browser.** Razorpay Checkout's success handler returns a payment id, an order id
and a signature — never a token — so a client-supplied `token_id` would be a
value the browser chose, and attaching a mandate is standing permission to debit
that merchant every cycle. `GET /payments/:id` returns `token_id` and
`customer_id`, and we have just verified that payment's signature.

A failed lookup returns null and the plan is still granted: the money is already
captured, so losing autopay is the acceptable half of that trade.

---

## The verification run

Use a **test-mode** account (`rzp_test_…`) and a store you do not mind billing.

### 1. Charge shape

With `RECURRING_CHARGE_VERIFIED` still `false`, drive the implementation
directly against test mode and confirm:

- [ ] `POST /customers` returns a `cust_…` id, and calling it twice with the
      same email returns the **same** id rather than an error.
- [ ] `POST /orders` with a `token` block returns an order (not a 400 about
      unexpected fields).
- [ ] `POST /payments/create/recurring` against a confirmed token returns
      `razorpay_payment_id`.
- [ ] Note the exact `status` values you see. If any is outside
      `mapGatewayStatus`'s list, add it there — an unrecognised status resolves
      to `unknown`, which is safe but leaves the invoice for reconciliation.

### 2. The outcomes that matter more than the happy path

- [ ] **Decline** — force one (test cards documented by Razorpay). Confirm the
      result maps to `rejected`, and that `collect.ts` records a failed attempt
      and opens the grace window rather than retrying.
- [ ] **Over the mandate ceiling** — charge more than `max_amount`. Confirm the
      gateway refuses and that `collectionRoute` would have routed it to manual
      first.
- [ ] **Over the AFA limit** (₹15,000) — confirm `collectionRoute` returns
      `over_afa_limit` and no charge is attempted.
- [ ] **Timeout** — kill the network mid-charge. Confirm the attempt lands in
      `unknown` and that `lib/billing/reconcile.ts` settles it on the next
      sweep by asking Razorpay directly.

### 3. Idempotency

- [ ] Run the same collection twice. The partial unique index on
      `billing_payment_attempts` must refuse the second, and the merchant must
      be charged **once**.
- [ ] Confirm `idempotency_key` appears in the payment's `notes` at Razorpay —
      that copy is what reconciliation matches on if the header is ever renamed.

### 4. Only then

- [ ] Flip `RECURRING_CHARGE_VERIFIED` to `true`.
- [ ] Watch the first live renewal cycle end to end before trusting it.

---

## If it goes wrong after the flip

Set it back to `false`. The renewal worker returns to issuing invoices merchants
pay by hand — a complete billing path that has been the only one in use all
along. Nothing is lost but automation, and no merchant loses their plan for it:
`collect.ts` treats an absent charge function as `manualRequired`, never as a
failure, so no grace clock starts.
