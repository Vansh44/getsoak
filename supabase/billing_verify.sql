-- =============================================================
-- Billing schema — adversarial verification against a LIVE database.
--
-- The unit tests in lib/billing/ cover the pure logic. This covers what only
-- Postgres can answer: do the constraints, partial unique indexes and triggers
-- actually refuse the things the design says they refuse? A CHECK that was
-- written but silently not applied looks identical to one that works, right up
-- until two workers double-charge a merchant.
--
-- ★★ IT WRITES NOTHING AND ENDS CLEANLY. All the mutating work happens inside a
-- plpgsql SUBTRANSACTION that is deliberately rolled back, so no row, and no
-- burned invoice number, survives. The RESULTS survive because plpgsql
-- variables are memory rather than database state — a subtransaction rollback
-- discards the rows but keeps the tally. You get a normal result table, not an
-- error.
--
-- ★ Portable on purpose — NO psql meta-commands (`\set`, `:vars`), which are
-- features of the psql binary that any other client rejects outright.
--
-- Run in Cloud SQL Studio: select the storemink_staging database, paste, Run.
-- Or locally with `npm run db:proxy` up:
--
--   export PGPASSWORD=$(grep '^DB_PASSWORD=' .env | cut -d= -f2- | tr -d '"')
--   psql -h 127.0.0.1 -p 6543 -U app -d storemink_staging -f supabase/billing_verify.sql
--
-- ⚠ Point it at STAGING, never production.
-- =============================================================

DROP TABLE IF EXISTS _billing_verify;
CREATE TEMP TABLE _billing_verify (n int, ok boolean, label text);

DO $$
DECLARE
  -- The store is only an FK target; nothing about it is modified.
  v_store uuid := 'a0000000-0000-4000-8000-000000000001';
  v_inv   uuid := '11111111-1111-4111-8111-111111111111';
  v_ref   text;
  v_res   boolean;
  -- ★ Results live in ARRAYS, not in a table: plpgsql variables are not
  -- transactional, so they survive the rollback below. Numbering comes from the
  -- array index at the end, so checks cannot end up mis-numbered by hand.
  v_ok    boolean[] := '{}';
  v_lbl   text[]    := '{}';
BEGIN
  -- These tables have RLS on with NO policies, so the connection must bypass
  -- RLS: a member of app_service (BYPASSRLS), a superuser, or the table owner.
  -- ★ BEST-EFFORT — Cloud SQL Studio connects as a user that is usually not a
  -- member of app_service, and failing here would block a check that runs
  -- perfectly well as a superuser.
  BEGIN
    PERFORM set_config('role', 'app_service', true);
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- ── Everything below is discarded ────────────────────────────────────────
  BEGIN
    -- Probe first. If RLS is blocking this connection, every check would fail
    -- for a reason that has nothing to do with the schema — so say so once, in
    -- plain words, naming the user.
    BEGIN
      INSERT INTO billing_accounts (store_id, legal_name, state_code)
        VALUES (v_store, 'Verify Co', '07');
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        'BILLING VERIFY cannot run as "%": row-level security is blocking writes to billing_accounts. Connect as a superuser, as the table owner, or as a member of app_service.',
        current_user;
    END;

    INSERT INTO billing_invoices
      (id, store_id, kind, status, subtotal_paise, tax_paise, total_paise, cycle_seq)
      VALUES (v_inv, v_store, 'subscription', 'open', 1500000, 270000, 1770000, 1);

    -- ── Invoices: one per cycle ────────────────────────────────────────────
    BEGIN
      INSERT INTO billing_invoices (store_id, kind, status, subtotal_paise,
        tax_paise, total_paise, cycle_seq)
        VALUES (v_store, 'subscription', 'open', 1500000, 270000, 1770000, 1);
      v_ok := v_ok || false;
    EXCEPTION WHEN unique_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'duplicate renewal invoice refused (spec 35)'::text;

    BEGIN
      INSERT INTO billing_invoices (store_id, kind, status, subtotal_paise,
        tax_paise, total_paise) VALUES (v_store, 'ai_credits', 'open', 12900, 2322, 15222);
      INSERT INTO billing_invoices (store_id, kind, status, subtotal_paise,
        tax_paise, total_paise) VALUES (v_store, 'ai_credits', 'open', 12900, 2322, 15222);
      v_ok := v_ok || true;
    EXCEPTION WHEN unique_violation THEN v_ok := v_ok || false;
    END;
    v_lbl := v_lbl || 'two ai_credits invoices coexist (NULL cycle_seq)'::text;

    BEGIN
      INSERT INTO billing_invoices (store_id, kind, status, subtotal_paise,
        tax_paise, total_paise, cycle_seq)
        VALUES (v_store, 'subscription', 'open', 1500000, 270000, 999, 99);
      v_ok := v_ok || false;
    EXCEPTION WHEN check_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'total_adds_up enforced'::text;

    BEGIN
      INSERT INTO billing_invoices (store_id, kind, status, subtotal_paise,
        tax_paise, total_paise) VALUES (v_store, 'subscription', 'open', 100, 0, 100);
      v_ok := v_ok || false;
    EXCEPTION WHEN check_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'subscription invoice requires a cycle_seq'::text;

    -- ── Numbering: on finalize, by trigger, exactly once ──────────────────
    UPDATE billing_invoices SET finalized_at = now() WHERE id = v_inv;
    SELECT invoice_ref INTO v_ref FROM billing_invoices WHERE id = v_inv;
    v_ok  := v_ok  || (v_ref ~ '^SM/[0-9]{4}-[0-9]{2}/[0-9]{5}$');
    v_lbl := v_lbl || ('finalize allocates a well-formed invoice_ref (got '
                       || coalesce(v_ref, '<null>') || ')')::text;

    UPDATE billing_invoices SET finalized_at = now() WHERE id = v_inv;
    SELECT invoice_ref = v_ref INTO v_res FROM billing_invoices WHERE id = v_inv;
    v_ok  := v_ok  || v_res;
    v_lbl := v_lbl || 're-finalize keeps the same number (no gap burned)'::text;

    -- ── Immutability ─────────────────────────────────────────────────────
    BEGIN
      UPDATE billing_invoices SET total_paise = 1 WHERE id = v_inv;
      v_ok := v_ok || false;
    EXCEPTION WHEN raise_exception THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'finalized invoice money is immutable (spec 23)'::text;

    BEGIN
      UPDATE billing_invoices SET status = 'paid', paid_at = now() WHERE id = v_inv;
      v_ok := v_ok || true;
    EXCEPTION WHEN OTHERS THEN v_ok := v_ok || false;
    END;
    v_lbl := v_lbl || 'status may still move on a finalized invoice'::text;

    BEGIN
      INSERT INTO billing_invoice_items (invoice_id, kind, description,
        unit_amount_paise, amount_paise) VALUES (v_inv, 'base_plan', 'sneaky', 100, 100);
      v_ok := v_ok || false;
    EXCEPTION WHEN raise_exception THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'finalized invoice lines are frozen'::text;

    -- ── Payment attempts: exactly one in flight ──────────────────────────
    INSERT INTO billing_payment_attempts (invoice_id, store_id, idempotency_key,
      mode, state, amount_paise)
      VALUES (v_inv, v_store, 'key-a', 'automatic', 'processing', 1770000);
    BEGIN
      INSERT INTO billing_payment_attempts (invoice_id, store_id, idempotency_key,
        mode, state, amount_paise)
        VALUES (v_inv, v_store, 'key-b', 'manual', 'created', 1770000);
      v_ok := v_ok || false;
    EXCEPTION WHEN unique_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'second in-flight attempt refused (spec 28, 36)'::text;

    UPDATE billing_payment_attempts SET state = 'failed', resolved_at = now()
      WHERE idempotency_key = 'key-a';
    BEGIN
      INSERT INTO billing_payment_attempts (invoice_id, store_id, idempotency_key,
        mode, state, amount_paise)
        VALUES (v_inv, v_store, 'key-c', 'manual', 'created', 1770000);
      v_ok := v_ok || true;
    EXCEPTION WHEN unique_violation THEN v_ok := v_ok || false;
    END;
    v_lbl := v_lbl || 'retry allowed once the previous attempt resolved'::text;

    BEGIN
      UPDATE billing_payment_attempts SET state = 'captured'
        WHERE idempotency_key = 'key-c';
      v_ok := v_ok || false;
    EXCEPTION WHEN check_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'a settled attempt must record when it settled'::text;

    -- ── Mandates: exactly one active ─────────────────────────────────────
    INSERT INTO billing_mandates (store_id, status, method, max_amount_paise,
      provider_token_id) VALUES (v_store, 'active', 'upi', 2700000, 'tok_1');
    BEGIN
      INSERT INTO billing_mandates (store_id, status, method, max_amount_paise,
        provider_token_id) VALUES (v_store, 'active', 'card', 2700000, 'tok_2');
      v_ok := v_ok || false;
    EXCEPTION WHEN unique_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'second active mandate refused'::text;

    BEGIN
      INSERT INTO billing_mandates (store_id, status, method, provider_token_id)
        VALUES (v_store, 'revoked', 'card', 'tok_3');
      v_ok := v_ok || true;
    EXCEPTION WHEN unique_violation THEN v_ok := v_ok || false;
    END;
    v_lbl := v_lbl || 'a revoked mandate coexists with the active one'::text;

    -- ── Tax configuration ────────────────────────────────────────────────
    BEGIN
      UPDATE billing_accounts SET state_code = 'DL' WHERE store_id = v_store;
      v_ok := v_ok || false;
    EXCEPTION WHEN check_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'non-numeric GST state code refused'::text;

    BEGIN
      UPDATE platform_billing_settings SET tax_enabled = true WHERE id;
      v_ok := v_ok || false;
    EXCEPTION WHEN check_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'tax cannot be enabled without a GSTIN'::text;

    -- ── Subscription: impossible states ──────────────────────────────────
    INSERT INTO billing_subscriptions (store_id, plan, period, state,
      current_cycle_seq, current_period_start, current_period_end, plan_source)
      VALUES (v_store, 'basic', 'yearly', 'active', 1,
              now() - interval '10 days', now() + interval '355 days', 'paid');
    BEGIN
      UPDATE billing_subscriptions SET grace_started_at = now()
        WHERE store_id = v_store;
      v_ok := v_ok || false;
    EXCEPTION WHEN check_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'grace timestamps must travel together'::text;

    BEGIN
      UPDATE billing_subscriptions SET current_period_start = NULL,
        current_period_end = NULL WHERE store_id = v_store;
      v_ok := v_ok || false;
    EXCEPTION WHEN check_violation THEN v_ok := v_ok || true;
    END;
    v_lbl := v_lbl || 'an active subscription must have a cycle'::text;

    -- ── billing_claim_downgrade: the concurrency guarantee ───────────────
    SELECT billing_claim_downgrade(v_store) INTO v_res;
    v_ok  := v_ok  || (v_res = false);
    v_lbl := v_lbl || 'an active subscription is not downgraded'::text;

    UPDATE billing_subscriptions SET state = 'grace',
        grace_started_at = now() - interval '1 hour',
        grace_ends_at    = now() + interval '47 hours'
      WHERE store_id = v_store;
    SELECT billing_claim_downgrade(v_store) INTO v_res;
    v_ok  := v_ok  || (v_res = false);
    v_lbl := v_lbl || 'grace not yet expired -> no downgrade (spec 37)'::text;

    -- Deadline passed, but the invoice is PAID.
    UPDATE billing_subscriptions SET grace_ends_at = now() - interval '1 minute'
      WHERE store_id = v_store;
    SELECT billing_claim_downgrade(v_store) INTO v_res;
    v_ok  := v_ok  || (v_res = false);
    v_lbl := v_lbl || 'a paid invoice beats the downgrade worker (spec 11)'::text;

    UPDATE billing_invoices SET status = 'open' WHERE id = v_inv;
    SELECT billing_claim_downgrade(v_store) INTO v_res;
    v_ok  := v_ok  || (v_res = true);
    v_lbl := v_lbl || 'expired + unpaid -> downgraded'::text;

    SELECT billing_claim_downgrade(v_store) INTO v_res;
    v_ok  := v_ok  || (v_res = false);
    v_lbl := v_lbl || 'downgrade is idempotent (spec 39)'::text;

    SELECT plan = 'free' AND billed_locations = 0 AND grace_ends_at IS NULL
             AND downgraded_at IS NOT NULL
      INTO v_res FROM billing_subscriptions WHERE store_id = v_store;
    v_ok  := v_ok  || v_res;
    v_lbl := v_lbl || 'downgrade leaves plan=free, locations=0, grace cleared'::text;

    UPDATE billing_subscriptions SET plan = 'pro', state = 'grace',
        plan_source = 'comp',
        grace_started_at = now() - interval '3 days',
        grace_ends_at    = now() - interval '1 day'
      WHERE store_id = v_store;
    SELECT billing_claim_downgrade(v_store) INTO v_res;
    v_ok  := v_ok  || (v_res = false);
    v_lbl := v_lbl || 'a comped store is never downgraded'::text;

    -- ── The financial year is computed in IST, not UTC ───────────────────
    -- ★ 2026-03-31 18:31Z is 31 MARCH in UTC but 1 APRIL in IST. A UTC-based
    -- implementation files it under the wrong financial year, so this pair is
    -- the whole point of the `at time zone 'Asia/Kolkata'` cast.
    v_ok := v_ok ||
      (billing_fy_label('2026-03-31T18:29:00Z') = '2025-26'
       AND billing_fy_label('2026-03-31T18:31:00Z') = '2026-27'
       AND billing_fy_label('2026-01-15T00:00:00Z') = '2025-26'
       AND billing_fy_label('2027-03-31T18:29:00Z') = '2026-27');
    v_lbl := v_lbl || 'billing_fy_label uses the IST financial-year boundary'::text;

    -- ★ Discard every row above. The arrays survive; the database does not.
    RAISE EXCEPTION 'SM_VERIFY_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    -- Anything that is NOT our own rollback signal is a genuine failure.
    IF SQLERRM <> 'SM_VERIFY_ROLLBACK' THEN RAISE; END IF;
  END;

  -- ★ Drop back to the session user before touching the temp table. The role
  -- switch above is transaction-local, so without this the INSERT still runs as
  -- app_service — which does not own a temp table created by the connecting
  -- user, and the results would be lost to "permission denied".
  PERFORM set_config('role', 'none', true);

  -- Outside the discarded subtransaction: record what the arrays remember.
  INSERT INTO _billing_verify (n, ok, label)
    SELECT i, o, l FROM unnest(v_ok, v_lbl) WITH ORDINALITY AS t(o, l, i);
END $$;

-- One result set: the verdict on row 0, then every check in order.
SELECT 0 AS n,
       -- ★ The count is asserted, not just reported. A run that dies half way
       -- leaves fewer rows, and "0 passed, 0 failed" must never render as green.
       CASE WHEN count(*) = 26 AND count(*) FILTER (WHERE NOT ok) = 0
            THEN 'ALL PASSED' ELSE 'FAILURES' END AS result,
       format('%s passed, %s failed, %s of 26 checks ran — nothing was written',
              count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok),
              count(*)) AS label
  FROM _billing_verify
UNION ALL
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, label
  FROM _billing_verify
 ORDER BY n;
