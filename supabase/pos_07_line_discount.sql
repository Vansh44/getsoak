-- POS Phase 2 — record per-line discounts on order_items.
--
-- Run as `postgres` (the table owner), like every other migration in this dir.
--
-- WHY: the register lets a cashier mark down ONE line (a damaged tin, an
-- expiring loaf) rather than discounting the whole sale. Until now that
-- markdown was folded into order_items.total and then lost, which left two
-- problems:
--
--   1. The receipt showed "2 × ₹100 ......... ₹170" — arithmetic that doesn't
--      add up, with nothing explaining the difference.
--   2. Markdowns were unauditable. Shrinkage control means knowing WHICH
--      cashier discounted WHAT, and that signal did not exist.
--
-- `total` keeps its existing meaning (the amount charged, net of the
-- discount), so nothing that already reads this table changes behaviour.
-- The column is additive with a 0 default, so every historical row reads as
-- "no markdown", which is exactly what it was.

BEGIN;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS line_discount numeric(12, 2) NOT NULL DEFAULT 0;

-- A markdown is a reduction, never a surcharge — the register caps it at the
-- line's own gross, and the DB refuses anything else.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_line_discount_check'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_line_discount_check CHECK (line_discount >= 0);
  END IF;
END $$;

COMMENT ON COLUMN order_items.line_discount IS
  'Per-line markdown in store currency. `total` is already net of it.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_line_discount_check;
-- ALTER TABLE order_items DROP COLUMN IF EXISTS line_discount;
-- COMMIT;
