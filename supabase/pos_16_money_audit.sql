-- Money events in the POS audit trail (roadmap Step 14).
-- Run as `postgres` AFTER pos_05_device_hardening.sql. Idempotent.
--
-- ── What this closes ───────────────────────────────────────────────────────
-- `pos_audit_log` has recorded who signed in and which browser was trusted
-- since pos_05, and NOTHING about money. All six posAudit call sites are auth
-- or device events. So a shop could answer "who was at the till" and not "who
-- gave away ₹400", which is the question a short drawer actually raises.
--
-- The AMOUNTS were never lost — `orders.discount`, `order_items.line_discount`
-- and `order_refunds` all carry them. What was lost is ATTRIBUTION: the actor,
-- and above all the APPROVER.
--
-- ── ★★ THE APPROVER IS THE COLUMN THAT MATTERS ─────────────────────────────
-- An over-cap discount already carries a signed token naming the manager who
-- keyed their PIN (lib/pos/approval.ts). `placePosSale` verified it and threw
-- the identity away — `!!verifyApprovalToken(...)`. Everything else here is
-- reconstructible from the order; the approver is the one fact that was
-- genuinely unrecoverable once the sale committed.
--
-- ── ★ WHY COLUMNS AND NOT `detail` TEXT ────────────────────────────────────
-- An amount you cannot SUM or filter is a log line, not a report. "How much did
-- this shop give away last month, and who approved it" has to be a query.
-- `detail` stays for the human sentence.

BEGIN;

ALTER TABLE pos_audit_log ADD COLUMN IF NOT EXISTS amount   NUMERIC(12,2);
ALTER TABLE pos_audit_log ADD COLUMN IF NOT EXISTS approver TEXT;
-- No FK, matching device_id: the trail must survive the thing it describes.
ALTER TABLE pos_audit_log ADD COLUMN IF NOT EXISTS order_id UUID;

COMMENT ON COLUMN pos_audit_log.amount IS
  'Rupees GIVEN AWAY or MOVED by this event — a discount total, an override delta, a refund, a cash movement. Positive means it left the shop. NULL for auth/device events.';
COMMENT ON COLUMN pos_audit_log.approver IS
  'Who authorised it, when that differs from the actor — the manager whose PIN minted the approval token. NULL when the operator needed no approval.';
COMMENT ON COLUMN pos_audit_log.order_id IS
  'The sale or refund this concerns. "Who discounted" without "what" is half an answer.';

-- The money feed is filtered by event and read newest-first. Partial, because
-- auth events vastly outnumber money ones and never appear in this view.
CREATE INDEX IF NOT EXISTS pos_audit_log_money_idx
  ON pos_audit_log (store_id, created_at DESC)
  WHERE amount IS NOT NULL;

CREATE INDEX IF NOT EXISTS pos_audit_log_order_idx
  ON pos_audit_log (order_id) WHERE order_id IS NOT NULL;

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect three columns and two indexes.
--
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'pos_audit_log'
--    AND column_name IN ('amount','approver','order_id');
-- SELECT indexname FROM pg_indexes
--  WHERE tablename = 'pos_audit_log'
--    AND indexname IN ('pos_audit_log_money_idx','pos_audit_log_order_idx');

-- ── Rollback ────────────────────────────────────────────────────────────────
-- ⚠ Dropping these DESTROYS the attribution trail — the approver especially,
-- which cannot be reconstructed from any other table. Prefer leaving the
-- columns unused.
--
-- BEGIN;
-- DROP INDEX IF EXISTS pos_audit_log_money_idx;
-- DROP INDEX IF EXISTS pos_audit_log_order_idx;
-- ALTER TABLE pos_audit_log DROP COLUMN IF EXISTS amount;
-- ALTER TABLE pos_audit_log DROP COLUMN IF EXISTS approver;
-- ALTER TABLE pos_audit_log DROP COLUMN IF EXISTS order_id;
-- COMMIT;
