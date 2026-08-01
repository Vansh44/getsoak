# Notifications — how the whole thing works

A map of the notification system: the mental model, where each decision lives,
and what to touch when you want to change something. `CODEBASE.md` §22 is the
short version; this is the one to read when something is confusing.

---

## 1. The one-sentence model

> **Something happens → it's recorded → the registry says who cares → each
> audience gets its own message on its own channels.**

```
   a server action                                     TEAM
   emitEvent("order.placed")                     ┌──► • dashboard bell
            │                                    │    • staff email
            ▼                                    │
   ┌──────────────────┐      ┌──────────────┐    │
   │ activity_events  │─────►│   fan-out    │────┤
   │ (ALWAYS written) │      │  (registry)  │    │
   └──────────────────┘      └──────────────┘    │    CUSTOMER
            │                                    └──► • storefront bell
            ▼                                         • shopper email
    /dashboard/activity
      (the audit trail)
```

Two things that follow from this, and explain most of the design:

- **Every event is recorded, even when nobody is notified.** The audit trail is
  complete by construction. "Notify me about everything" would be unusable as
  an inbox, so recording and notifying are separate steps.
- **One event, two audiences, two completely different messages.** "New order
  ORD10010004 · ₹1,240 · from Priya S." and "Thanks for your order — we've got
  it" are the same event. They share nothing else.

---

## 2. The two audiences

|                | **Team**                                            | **Customer**                                  |
| -------------- | --------------------------------------------------- | --------------------------------------------- |
| Who            | The merchant's staff                                | The one shopper it happened to                |
| Recipients     | Many; permission-derived, narrowable                | Exactly one — nothing to choose               |
| Reads it at    | Dashboard bell, `/dashboard/activity`               | `/notifications`, `/orders` on the storefront |
| Email goes to  | Staff inboxes (+ optional Cc/Bcc)                   | The shopper's inbox                           |
| Tone           | Operational — refs, totals, who acted               | Second person, about _their_ order            |
| Who configures | Merchant, in the console                            | Merchant, in the console (separate tab)       |
| Opt-out        | Personal, at `/dashboard/settings/notifications/me` | None — it's transactional                     |

**They are configured separately, and that separation is load-bearing.** Turning
off team email for "New order" must not stop shoppers receiving their
confirmation. That was a real bug once; there is now a regression test for it
(`record.test.ts` → "silences the team without touching the customer").

---

## 3. Where each decision lives

Three layers, each with exactly one owner. Resolution is
**registry ← platform definition ← store settings**, so an empty database
behaves exactly like the code defaults (the same shape as
`lib/settings/registry.ts`, convention #9).

| Layer                    | Owner         | Lives in                      | Decides                                                                 |
| ------------------------ | ------------- | ----------------------------- | ----------------------------------------------------------------------- |
| **Code registry**        | Engineering   | `lib/notifications/events.ts` | What can be emitted, which audiences it reaches, all defaults           |
| **Platform definitions** | StoreMink ops | `notification_definitions`    | Renames, recategorisation, retiring one platform-wide                   |
| **Store settings**       | The merchant  | `notification_settings`       | Per audience: channels, copy, (team) recipients; plus digest and on/off |
| **Personal preference**  | Each staff    | `notification_preferences`    | "Not me" — never "them instead"                                         |

Nothing is seeded into a store's database at signup. A store row appears only
when a merchant changes something, and a field equal to the built-in default is
**not** stored — so improvements to platform copy keep reaching every store that
hasn't deliberately customised it.

---

## 4. Adding a notification

One entry in `lib/notifications/events.ts`:

```ts
{
  key: "order.refund_issued",
  label: "Refund issued",
  description: "A refund was sent back to the customer's payment method.",
  group: "Orders",
  section: "orders",        // which staff may receive it (permissions.ts)
  severity: "info",
  audiences: {
    "store-admins": { inApp: true, email: false },
    customer:       { inApp: true, email: true  },
  },
}
```

Then emit it from the action that does the thing:

```ts
emitEvent({
  type: "order.refund_issued",
  storeId,
  subject: { type: "order", id: order.id, label: order.order_ref },
  customerId: order.customer_id, // required for a customer audience
  payload: { amount: 1240 },
});
```

That's the whole integration. The console row, the preferences matrix, routing,
the default email copy, and the variable palette all derive from the registry
entry. If the payload carries a new value a template should be able to use, add
it to `lib/notifications/variables.ts` — a variable nobody provides is never
offered.

`audiences: {}` means **audit-only**: recorded in Activity, silent everywhere
else. That's how a busy store gets a full history without 400 badges a day.

### Both halves are required — the CI guard says so

A registry entry with no emitter is the worst failure mode this system has: the
console lists it, a merchant configures recipients and writes copy, and nothing
ever arrives. Nothing fails loudly. (This happened — 27 of 38 entries were dead
at one point, including plan changes and customer signup.)

`lib/notifications/coverage.test.ts` makes that state impossible. Every registry
key must either be emitted from `app/` or `lib/`, or appear in that file's
`PENDING` map with the unbuilt feature it's waiting on. There is no third state,
and the allowlist is checked in both directions — a `PENDING` key that gains an
emitter has to come out, so it never turns into a graveyard.

### recordEvent vs emitEvent

`emitEvent` defers via `after()`, so use it in **server actions**. In a **cron
route or webhook** the response is already gone by the time `after()` would run
— use `await recordEvent(…)` there instead.

### Don't double-send

Some events already have a dedicated sender. StoreMink's billing mail
(`lib/email/billing-emails.ts`) goes out from `billing@storemink.com` with
platform branding, so `plan.changed` and `subscription.payment_failed` are
deliberately **in-app only** in the registry — the bell records them, the
existing sender owns the email. `plan.expiring` is the exception: nothing else
warns before a plan lapses, so it keeps its email. Blog approval/rejection went
the other way — the bespoke senders were deleted and the notification system now
owns that mail, because merchants asked to edit the copy.

### Every email is logged — Activity → Email Logs

`/dashboard/activity/email-logs` lists every message this store has sent:
notifications, campaigns, enquiry alerts, invites, password resets, billing, and
sign-in codes. Filterable by status, type, date and recipient; a row opens the
rendered body.

**It is complete by construction.** There used to be eight independent
`resend.emails.send` calls and none of them recorded anything. They all go
through `sendEmail()` in `lib/email/send.ts` now, which sends _and_ logs, and
`send-coverage.test.ts` fails if a new direct call appears. A log with a hole is
worse than none — a merchant searches for the order confirmation, doesn't find
it, and concludes it was never sent.

**Credentials are redacted — except operator sign-in codes.**
`lib/email/mailers.ts` marks `password_reset` and `staff_invite` sensitive:
their subject and body aren't stored, because the reset link IS the credential
and the invite carries a plaintext temporary password. Store staff can read this
table, so a stored credential there outlives whatever it was for. Who, when, and
whether it sent are always kept.

`operator_otp` is the exception, by explicit decision: the code is stored in
full so a sign-in that "never arrived" can be checked directly. It's platform
mail (`store_id NULL`), so it only shows on the storemink.com console, never in
a merchant's log — but any operator can read another operator's live code.
Set `sensitive: true` on that entry to reverse it.

**Adding a new kind of email:** add an entry to `MAILERS`, then call
`sendEmail({ ..., mailer: "your_key" })`. The log's Type filter and label come
from the registry, and the coverage test makes sure you didn't bypass it.

### Delivery is not the same as sending

Resend accepting a message is not delivery, and the gap is where mail quietly
dies. Two things close it:

**Bounces and complaints suppress the address.**
`/api/webhooks/resend` (Svix-signature-verified — the endpoint decides whether
we stop mailing someone, so unsigned it would let anyone cut off a store's list)
writes permanent failures to `email_suppressions`, and both workers filter
against it before sending. The table is **global, with no `store_id`** — the one
table in this system that isn't tenant-scoped, deliberately: a hard bounce
bounces for everyone, and because all stores share one verified sending domain
by default, the reputation it burns is the platform's. Only **permanent**
signals suppress; a soft bounce (full mailbox, greylisting) resolves itself and
is already covered by the queue's retry, so suppressing on one would cut a real
customer off for good. An unrecognised bounce sub-type is treated as soft.

**Failures are visible.** A row that exhausts its retries used to be marked
`failed` and that was the end of it — no surface, no signal, discoverable only
by noticing the silence. `getDeliveryHealth` now feeds a panel on the
notifications page that appears ONLY when mail actually failed in the last 7
days, with a **Retry** per row. A suppressed address shows "Address unusable"
instead, because retrying it is guaranteed to fail.

### "Instant" depends on one kick landing

The cron heartbeat is **daily**. Instant email is instant only because
`triggerEmailWorker` POSTs the worker route the moment mail is enqueued. If that
kick doesn't land, nothing errors — the row just sits in the queue for up to a
day. So the origin comes from `PLATFORM_URL` (which falls back all the way to
`https://{ROOT_DOMAIN}`) rather than one env var, and only `CRON_SECRET` can
stop it. **If mail is arriving late rather than not at all, look here first.**

### One bad address must not sink a batch

Resend's `batch.send` validates the whole request: ONE malformed recipient and
the call errors for every message in it. Reading that as "all 100 failed" is how
a single typo'd Cc silently costs 99 unrelated people their email — permanently,
in the campaign worker, which has no retry.

So a batch error is not a verdict on the batch. `lib/email/send-batch.ts`
(`sendEmailBatch`) re-sends the slice message by message to find the actual
culprit; only it fails, and its `last_error` names its own problem. The probe is
bounded — three individual failures in a row means an outage, not a poison pill,
so the rest are reported failed without hammering the API another 97 times. Both
workers go through it.

### Firing once, not every time

Several events describe a _threshold being crossed_ rather than a state. Those
compare before/after and fire only on the transition, so a merchant gets one
message instead of one per sale:

| Event                    | Rule                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| `inventory.low_stock`    | `stockAlertFor` in `lib/inventory/alerts.ts` (pure, tested)             |
| `inventory.out_of_stock` | same — restocking re-arms both                                          |
| `ai.credits_low`         | `aiWarnAt` — exact equality at 3 left **and** at 0 (`lib/ai/quota.ts`)  |
| `plan.expiring`          | `expiryWarnWindow` — 24-hour bands at 7 and 1 days out (`lib/plans.ts`) |
| `campaign.sent`          | conditional `→ done` claim in the campaign worker                       |
| `customer.signed_up`     | `xmax = 0` — true INSERT only, not an upsert that updated               |

---

## 5. Delivery

| Channel               | Status | How it gets there                                                         |
| --------------------- | ------ | ------------------------------------------------------------------------- |
| **Web**               | Live   | A row in `notifications`; the bell polls a partial-index count every 45 s |
| **Email**             | Live   | A row in `notification_email_queue`; drained by `/api/cron/send-emails`   |
| SMS / Push / WhatsApp | Locked | Declared and visible in the console, but no provider is connected         |

**Email is a queue, never an inline send.** A Resend round-trip must not sit on
a checkout's code path. Instant mail kicks the worker as soon as the enqueue
transaction commits; hourly/daily rows wait for their clock-aligned window and
are grouped into one digest per person.

**In-app is polling, not push.** Supabase Realtime went with the Cloud SQL
migration. A LISTEN/NOTIFY → SSE service is the upgrade path.

---

## 6. Who receives a team notification

```
  everyone who may `view` the event's section    ← the permission map
                    │
                    ▼  narrowed by the store's routing rule
       permission / specific roles / specific people
```

**Targeting only ever narrows.** Naming someone who can't view the section does
_not_ start sending it to them — a notification's copy is a preview of the thing
itself, so routing must never become a side channel around the dashboard's
access rules. The picker greys such a pick out and names the fix (their role).

---

## 7. Where to look when something's wrong

| Symptom                         | Look at                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| Nothing recorded at all         | The emitter — is `emitEvent` called? `recordEvent` logs and never throws                            |
| Recorded but nobody notified    | `audiences: {}` (audit-only), the notification switched off, or routing narrowed to nobody eligible |
| A staff member isn't getting it | Their role's `view` on the event's section; then their `/me` opt-out                                |
| Customer isn't getting it       | The customer audience's channels; `customerId` missing from the emit                                |
| Email queued but not sent       | `RESEND_API_KEY`, then `notification_email_queue.last_error`                                        |
| Wrong wording                   | Store template for that audience → else `default-templates.ts` → else `render.ts`                   |

---

## 8. The console's shape

The landing page leads with the two jobs a merchant arrives with, rather than
the engine's full generality:

| Page                                | What it's for                                                         |
| ----------------------------------- | --------------------------------------------------------------------- |
| `/dashboard/settings/notifications` | **Customer emails** + **Team alerts** — the two jobs                  |
| `…/all`                             | Every notification, with category/audience/channel filters and search |
| `…/[slug]`                          | One notification: audience → channels → copy (+ Send test, Revert)    |
| `…/me`                              | A staff member's own opt-outs                                         |

The two landing lists deliberately look different, because the jobs are: a
customer row leads with the **message** (there's only ever one recipient), a
team row leads with the **recipients** (the copy matters less than who's on the
hook). A single uniform grid hid that asymmetry, which is what made the page
confusing.

Routes use a dot-free slug (`order-placed`, not `order.placed`) — `proxy.ts`
exempts asset-like paths from the session gate, and a dotted segment slipped
through it.

---

## 9. Files

| File                                           | What it is                                     |
| ---------------------------------------------- | ---------------------------------------------- |
| `lib/notifications/events.ts`                  | The registry. Start here                       |
| `lib/notifications/config.ts`                  | Three-layer resolution; the audience model     |
| `lib/notifications/record.ts`                  | `emitEvent`/`recordEvent` — the one write path |
| `lib/notifications/recipients.ts`              | Permission-derived recipients                  |
| `lib/notifications/routing.ts`                 | Narrowing rules (pure)                         |
| `lib/notifications/render.ts`                  | Built-in bell copy per audience (pure)         |
| `lib/notifications/default-templates.ts`       | Built-in email copy per audience (pure)        |
| `lib/notifications/template.ts`                | `{{token}}` substitution + validation (pure)   |
| `lib/notifications/variables.ts`               | What each event exposes to a template          |
| `lib/email/notification-worker.ts`             | Drains the email queue, groups digests         |
| `app/actions/notification-actions.ts`          | Console + staff inbox                          |
| `app/actions/customer-notification-actions.ts` | Shopper inbox                                  |

SQL: `supabase/notifications_01_schema.sql` (events, inbox, preferences),
`_02_email_queue.sql`, `_03_console.sql` (definitions + store settings),
`_04_email_cc.sql`.
