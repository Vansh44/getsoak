-- =============================================================
-- Line items on a queued email (CODEBASE.md §23).
--
-- An order confirmation that says "Items: 2" is a log line. The shopper knows
-- they ordered something; they want to see WHAT, at what price, adding up to
-- the total they were charged. Every transactional email worth copying leads
-- with the products.
--
-- WHY A COLUMN RATHER THAN THE EVENT PAYLOAD: activity_events.payload is
-- deliberately small and SCALAR — sanitizePayload drops objects and arrays,
-- because that table is an audit trail read by store staff, not a document
-- store. Line items are display data for ONE channel, so they live on the
-- email row instead of being smuggled into the audit record.
--
-- WHY SNAPSHOTTED AT ENQUEUE, like title/body/url: the worker needs no joins
-- into orders/order_items, and mail already queued keeps the prices it was
-- written with. An order edited between enqueue and send does not rewrite a
-- receipt the customer is about to receive.
--
-- Shape (all optional, rendered only when present):
--   {
--     "items":    [{ "name": "Amul Taaza", "variant": "1 L",
--                    "quantity": 2, "total": 118 }],
--     "currency": "INR",
--     "subtotal": 236, "discount": 20, "tax": 11.8,
--     "shipping": 0,   "total": 281.4
--   }
--
-- ⚠ Run as `postgres` against the target Cloud SQL database (through the Cloud
-- SQL Auth Proxy), after notifications_02_email_queue.sql. Idempotent.
-- =============================================================

ALTER TABLE notification_email_queue
  ADD COLUMN IF NOT EXISTS line_items JSONB;

-- =============================================================
-- Rollback:
--   ALTER TABLE notification_email_queue DROP COLUMN IF EXISTS line_items;
-- =============================================================
