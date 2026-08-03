-- ★ CRITICAL: the SQL identifier formatters TRUNCATE past 9999.
-- Run as `postgres`. Safe to run any time — see "Why this is backward
-- compatible" below.
--
-- ── The bug ────────────────────────────────────────────────────────────────
-- `lpad('12345', 4, '0')` returns '1234'. Postgres lpad does not just pad, it
-- TRUNCATES to the target length. Every formatter in identifiers_04_triggers
-- (and the credit-note one added by returns_04) pads each field to 4, so the
-- moment any per-store sequence passes 9999 the code silently loses a digit:
--
--   sm_order_ref(1001,  1000) = ORD100110006
--   sm_order_ref(1001, 10000) = ORD100110006   ← THE SAME STRING
--
-- `lib/identifiers.ts` has always been correct — its `pad()` is documented as
-- "codes grow past these; they never truncate" and behaves that way. Only the
-- SQL mirror was wrong, so the two implementations disagree exactly where it
-- matters and nowhere a test happened to look.
--
-- ── What it breaks ─────────────────────────────────────────────────────────
--   • products / product_variants: `(store_id, sku)` is UNIQUE, so a store's
--     10,000th product FAILS TO INSERT. A hard outage on product creation.
--   • orders: `order_ref` has no unique index, so it is worse in a quieter
--     way — order #1000 and #10000 share a customer-visible reference.
--     Invoices, support lookups and the POS return search (findOrderForReturn
--     matches on order_ref) all become ambiguous, with no error anywhere.
--   • stores: `store_no` is global and starts at 1000, so the platform's
--     10,000th store hits the same wall.
--   • credit notes: a GST series that silently repeats a serial is the worst
--     of the lot, because the document is a legal record.
--
-- ── Why this is backward compatible ────────────────────────────────────────
-- For any value ≤ 9999, `lpad(x,4,'0')` and the non-truncating form produce
-- byte-identical output. This migration therefore CANNOT change any code that
-- has already been issued; it only changes the range that is currently broken.
-- No backfill is needed and none is performed.
--
-- ── The fix ────────────────────────────────────────────────────────────────
-- `lpad(x, greatest(4, length(x)), '0')` — pad to a MINIMUM width instead of
-- an exact one, which is what `lib/identifiers.ts` does.

BEGIN;

-- A shared helper, so the next formatter added can't reintroduce this by
-- copying the pattern — which is exactly how sm_credit_note_ref inherited it.
CREATE OR REPLACE FUNCTION public.sm_pad(p_value int, p_width int)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT lpad(p_value::text, greatest(p_width, length(p_value::text)), '0');
$$;

COMMENT ON FUNCTION public.sm_pad(int, int) IS
  'Zero-pad to a MINIMUM width. Postgres lpad() truncates when the input is longer than the target; every identifier formatter must use this instead. Mirrors pad() in lib/identifiers.ts.';

CREATE OR REPLACE FUNCTION public.sm_sku(p_store int, p_seq int)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 'SKU' || public.sm_pad(p_store,4) || public.sm_pad(p_seq,4)
      || public.sm_luhn(public.sm_pad(p_store,4) || public.sm_pad(p_seq,4))::text;
$$;

CREATE OR REPLACE FUNCTION public.sm_variant_sku(p_store int, p_seq int, p_var int)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 'SKU' || public.sm_pad(p_store,4) || public.sm_pad(p_seq,4)
      || 'V' || public.sm_pad(p_var,2)
      || public.sm_luhn(public.sm_pad(p_store,4) || public.sm_pad(p_seq,4)
                        || public.sm_pad(p_var,2))::text;
$$;

CREATE OR REPLACE FUNCTION public.sm_order_ref(p_store int, p_order int)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 'ORD' || public.sm_pad(p_store,4) || public.sm_pad(p_order,4)
      || public.sm_luhn(public.sm_pad(p_store,4) || public.sm_pad(p_order,4))::text;
$$;

CREATE OR REPLACE FUNCTION public.sm_credit_note_ref(p_store int, p_seq int)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT 'CRN' || public.sm_pad(p_store,4) || public.sm_pad(p_seq,4)
      || public.sm_luhn(public.sm_pad(p_store,4) || public.sm_pad(p_seq,4))::text;
$$;

-- ---------------------------------------------------------------------------
-- Guard: fail the migration if any formatter still truncates.
-- ---------------------------------------------------------------------------
-- The vectors below are the ones lib/identifiers.test.ts asserts, so the two
-- implementations are pinned to each other rather than merely both "looking
-- right". A future edit that reintroduces bare lpad() dies here.
DO $$
BEGIN
  IF public.sm_order_ref(1001, 12345) <> 'ORD1001123452' THEN
    RAISE EXCEPTION 'sm_order_ref still truncates: got %', public.sm_order_ref(1001, 12345);
  END IF;
  IF public.sm_sku(1001, 12345) <> 'SKU1001123452' THEN
    RAISE EXCEPTION 'sm_sku still truncates: got %', public.sm_sku(1001, 12345);
  END IF;
  IF public.sm_credit_note_ref(1001, 12345) <> 'CRN1001123452' THEN
    RAISE EXCEPTION 'sm_credit_note_ref still truncates: got %', public.sm_credit_note_ref(1001, 12345);
  END IF;
  -- And unchanged below the wall, which is what makes this safe to run.
  IF public.sm_order_ref(1001, 1000) <> 'ORD100110006' THEN
    RAISE EXCEPTION 'sm_order_ref changed an ALREADY-ISSUED code: got %', public.sm_order_ref(1001, 1000);
  END IF;
  IF public.sm_sku(1001, 1) <> 'SKU100100015' THEN
    RAISE EXCEPTION 'sm_sku changed an ALREADY-ISSUED code: got %', public.sm_sku(1001, 1);
  END IF;
END $$;

COMMIT;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Restores the truncating behaviour. Only useful if something downstream
-- somehow depends on the broken codes — nothing should.
-- BEGIN;
-- create or replace function public.sm_sku(p_store int, p_seq int)
-- returns text language sql immutable set search_path = '' as $$
--   select 'SKU' || lpad(p_store::text,4,'0') || lpad(p_seq::text,4,'0')
--       || public.sm_luhn(lpad(p_store::text,4,'0') || lpad(p_seq::text,4,'0'))::text;
-- $$;
-- create or replace function public.sm_variant_sku(p_store int, p_seq int, p_var int)
-- returns text language sql immutable set search_path = '' as $$
--   select 'SKU' || lpad(p_store::text,4,'0') || lpad(p_seq::text,4,'0') || 'V' || lpad(p_var::text,2,'0')
--       || public.sm_luhn(lpad(p_store::text,4,'0') || lpad(p_seq::text,4,'0') || lpad(p_var::text,2,'0'))::text;
-- $$;
-- create or replace function public.sm_order_ref(p_store int, p_order int)
-- returns text language sql immutable set search_path = '' as $$
--   select 'ORD' || lpad(p_store::text,4,'0') || lpad(p_order::text,4,'0')
--       || public.sm_luhn(lpad(p_store::text,4,'0') || lpad(p_order::text,4,'0'))::text;
-- $$;
-- create or replace function public.sm_credit_note_ref(p_store int, p_seq int)
-- returns text language sql immutable set search_path = '' as $$
--   select 'CRN' || lpad(p_store::text,4,'0') || lpad(p_seq::text,4,'0')
--       || public.sm_luhn(lpad(p_store::text,4,'0') || lpad(p_seq::text,4,'0'))::text;
-- $$;
-- DROP FUNCTION IF EXISTS public.sm_pad(int, int);
-- COMMIT;
