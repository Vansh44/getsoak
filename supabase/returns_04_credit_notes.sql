-- Returns, step 6 — GST credit notes.
-- docs/returns-exchanges-plan.md §6.5. Run as `postgres`, after returns_03.
--
-- ── Why this exists ────────────────────────────────────────────────────────
-- Under Indian GST, refunding against a tax invoice requires a CREDIT NOTE
-- with its own serial. It is a legal document, not a receipt: it is what
-- reverses the output tax the store already declared, and a merchant's CA will
-- ask for it. Cheap to add now; expensive to retrofit, because the serials are
-- historical and cannot be invented after the fact.
--
-- ── ★ THE SERIAL MUST HAVE NO GAPS, WHICH DECIDES THE WHOLE DESIGN ────────
-- A missing number in a GST document series is precisely what an audit flags.
-- So the number is allocated when a refund **SETTLES**, never when it is
-- raised: refunds_01 writes the row as `pending` BEFORE calling Razorpay, and a
-- pending refund that then fails would burn a serial and leave a hole.
--
-- That rules out doing it in the app: `completed` is reached from FOUR places
-- (the till's direct insert, issueRefund's non-gateway insert, its gateway
-- claim, and the reconcile sweep). Four call sites is four chances to forget.
-- A trigger cannot be forgotten — the same reasoning convention #14 gives for
-- order_ref and SKUs being trigger-owned.
--
-- ── NEW FILE, as always ────────────────────────────────────────────────────
-- identifiers_01_schema.sql and pos_12_returns.sql have both run in prod, and
-- editing a CREATE TABLE IF NOT EXISTS is a silent no-op (§15b).

BEGIN;

-- ---------------------------------------------------------------------------
-- The counter
-- ---------------------------------------------------------------------------
ALTER TABLE public.store_counters
  ADD COLUMN IF NOT EXISTS credit_note_seq integer NOT NULL DEFAULT 0;

-- Mirror of next_order_no: a single UPDATE … RETURNING, so two concurrent
-- refunds can never take the same serial.
CREATE OR REPLACE FUNCTION public.next_credit_note_no(p_store uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v integer;
BEGIN
  INSERT INTO public.store_counters (store_id) VALUES (p_store)
    ON CONFLICT (store_id) DO NOTHING;
  UPDATE public.store_counters SET credit_note_seq = credit_note_seq + 1
    WHERE store_id = p_store RETURNING credit_note_seq INTO v;
  RETURN v;
END; $$;

GRANT EXECUTE ON FUNCTION public.next_credit_note_no(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- The formatter — mirror of sm_order_ref (identifiers_04), cross-checked by
-- lib/identifiers.test.ts against formatCreditNoteRef.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sm_credit_note_ref(p_store int, p_seq int)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 'CRN' || lpad(p_store::text,4,'0') || lpad(p_seq::text,4,'0')
      || public.sm_luhn(lpad(p_store::text,4,'0') || lpad(p_seq::text,4,'0'))::text;
$$;

-- ---------------------------------------------------------------------------
-- The columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_refunds
  ADD COLUMN IF NOT EXISTS credit_note_no integer;
ALTER TABLE public.order_refunds
  ADD COLUMN IF NOT EXISTS credit_note_ref text;
-- When the note was raised. Its DATE is what the return period is filed under,
-- so it is stored rather than derived from the refund row's created_at — which
-- for a gateway refund is when it was REQUESTED, possibly a different month.
ALTER TABLE public.order_refunds
  ADD COLUMN IF NOT EXISTS credit_note_at timestamptz;

-- Per store, never global: each merchant files their own return.
CREATE UNIQUE INDEX IF NOT EXISTS order_refunds_credit_note_key
  ON public.order_refunds (store_id, credit_note_no)
  WHERE credit_note_no IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ★ The trigger — allocate on SETTLEMENT, exactly once
-- ---------------------------------------------------------------------------
-- Fires when a row arrives already `completed` (the till, and every
-- non-gateway refund) OR transitions into it (the gateway claim, and the
-- reconcile sweep). `credit_note_no IS NULL` makes it exactly-once, so a row
-- that flips completed → failed → completed keeps its ORIGINAL serial rather
-- than taking a second one and leaving the first as a gap.
--
-- A refund on an untaxed order gets no note: there is no output tax to
-- reverse, so issuing one would put a number in the series that reverses
-- nothing.
CREATE OR REPLACE FUNCTION public.trg_order_refunds_credit_note()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_store_no int;
  v_seq      int;
  v_taxed    boolean;
BEGIN
  IF new.status <> 'completed' OR new.credit_note_no IS NOT NULL THEN
    RETURN new;
  END IF;

  SELECT coalesce(o.tax, 0) > 0 INTO v_taxed
    FROM public.orders o WHERE o.id = new.order_id;
  IF v_taxed IS NOT TRUE THEN
    RETURN new;
  END IF;

  v_seq := public.next_credit_note_no(new.store_id);
  SELECT store_no INTO v_store_no FROM public.stores WHERE id = new.store_id;

  new.credit_note_no  := v_seq;
  new.credit_note_ref := public.sm_credit_note_ref(v_store_no, v_seq);
  new.credit_note_at  := now();
  RETURN new;
END; $$;

DROP TRIGGER IF EXISTS order_refunds_credit_note ON public.order_refunds;
CREATE TRIGGER order_refunds_credit_note
  BEFORE INSERT OR UPDATE OF status ON public.order_refunds
  FOR EACH ROW EXECUTE FUNCTION public.trg_order_refunds_credit_note();

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- ★ Deliberately NONE. Historical refunds were made without a credit note, and
-- inventing serials for them now would fabricate documents dated to periods
-- already filed — the opposite of what this feature is for. The series starts
-- from the next settled refund. A merchant who needs notes for past refunds
-- must raise them through their accountant, which is the correct process.

COMMENT ON COLUMN public.order_refunds.credit_note_no IS
  'Per-store GST credit note serial. Allocated by a trigger when the refund SETTLES, never when it is raised — a pending refund that later fails would leave a gap, and a gap is what an audit flags.';
COMMENT ON FUNCTION public.trg_order_refunds_credit_note() IS
  'Allocates a credit note serial exactly once, on settlement, and only for refunds against a TAXED order — there is no output tax to reverse otherwise.';

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TRIGGER IF EXISTS order_refunds_credit_note ON public.order_refunds;
-- DROP FUNCTION IF EXISTS public.trg_order_refunds_credit_note();
-- DROP INDEX IF EXISTS public.order_refunds_credit_note_key;
-- ALTER TABLE public.order_refunds
--   DROP COLUMN IF EXISTS credit_note_at,
--   DROP COLUMN IF EXISTS credit_note_ref,
--   DROP COLUMN IF EXISTS credit_note_no;
-- DROP FUNCTION IF EXISTS public.sm_credit_note_ref(int, int);
-- DROP FUNCTION IF EXISTS public.next_credit_note_no(uuid);
-- ALTER TABLE public.store_counters DROP COLUMN IF EXISTS credit_note_seq;
-- COMMIT;
