-- Backfill: move the one live operator comp into the overlay columns.
-- Companion to docs/comped-plans-spec.md §10 step 2.
-- APPLIED to production 2026-09-06.
--
-- ★★ THIS IS NOT A MIGRATION AND MUST NOT BE ENROLLED IN THE LEDGER. It is
-- environment-specific DATA, it changes what a live merchant may do, and the
-- spec calls for it to be reviewed by hand. Migrations are schema; this is
-- surgery on one row.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE: exactly ONE row on production (`echos`).
--
-- ⚠ CORRECTION TO AN EARLIER ASSUMPTION: `stores.plan_source` DEFAULTS to
-- 'comp', so every store reads as comped whether or not anyone comped it. All
-- four production stores show 'comp'; only two are real grants, and only one
-- needs anything doing:
--
--   wholesip      pro  · comp · no expiry · NO subscription
--                 A genuine INDEFINITE operator grant with no paid plan
--                 underneath. LEFT ALONE: the overlay is deliberately
--                 time-boxed (stores_comp_window_complete requires a start and
--                 an end), so an open-ended grant cannot be expressed in it —
--                 and does not need to be. `plan`/`plan_source` already model
--                 it correctly and `effectivePlan` returns pro.
--   demo-vitrine  free · comp · no expiry · no subscription   → default value only
--   echoss        free · comp · no expiry · no subscription   → default value only
--   echos         pro  · comp · expires 2026-09-22 · paid basic subscription
--                 ↑ THE ONE. A timed Pro grant sitting on top of a plan the
--                 merchant pays for, which is exactly the state the overlay
--                 exists to represent.
--
-- ★ SAFE FOR THE §7 EXEMPTION REMOVAL AFTERWARDS. Once this runs, no store is
-- both comped and invoiceable: wholesip, demo-vitrine and echoss have no
-- `billing_subscriptions` row at all, and echos has cancel_at_period_end = true,
-- which `claimDue` excludes independently of plan_source.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IT DOES, AND WHY THE MERCHANT NOTICES NOTHING
--
-- Everything is DERIVED — no value is typed in twice:
--   plan / plan_source / plan_expires_at ← the store's own billing_subscriptions
--   comp_plan        ← the plan the operator granted (today's stores.plan)
--   comp_expires_at  ← the grant's end (today's stores.plan_expires_at)
--   comp_starts_at   ← when the operator actually granted it, from plan_events
--                      (2026-08-22 20:43:11Z, source 'operator')
--   comp_duration_days ← left NULL on purpose: the operator chose an END DATE,
--                      not a duration, and inventing "31" would record a choice
--                      nobody made. The column is only used to compute a window
--                      at acceptance, which already happened.
--
-- Entitlement before and after, by date:
--   now → 15 Sep   before: pro (plan=pro)          after: max(basic, pro) = pro
--   15 → 22 Sep    before: pro                     after: paid lapsed → free,
--                                                         comp pro    → pro
--   after 22 Sep   before: free (expiry cron)      after: comp cleared → free
-- Identical throughout. STEP 3 proves it against the real row.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══ STEP 1 — PRE-FLIGHT. Read this before running anything. ═════════════════
select s.slug, s.plan, s.plan_source, s.plan_expires_at, s.comp_plan,
       b.plan as sub_plan, b.state, b.cancel_at_period_end, b.current_period_end,
       (select pe.created_at from plan_events pe
         where pe.store_id = s.id and pe.source = 'operator'
         order by pe.created_at desc limit 1) as granted_at
  from stores s
  join billing_subscriptions b on b.store_id = s.id
 where s.slug = 'echos';


-- ═══ STEP 2 — THE BACKFILL. One row, one transaction, fully guarded. ═════════
begin;

update stores s
   set -- The paid entitlement, taken from the subscription that pays for it.
       plan            = b.plan,
       plan_source     = 'paid',
       plan_expires_at = b.current_period_end,
       -- The operator grant, preserved exactly, as an overlay.
       comp_plan          = s.plan,
       comp_expires_at    = s.plan_expires_at,
       comp_starts_at     = g.granted_at,
       comp_duration_days = null,
       comp_offered_at    = null
  from billing_subscriptions b
 -- ⚠ Keyed on b.store_id, NOT s.id: in an UPDATE ... FROM, the target table
 -- cannot be referenced from the FROM list, laterally or otherwise. `b` is in
 -- the FROM, and b.store_id = s.id is enforced below.
 cross join lateral (
         select pe.created_at as granted_at
           from plan_events pe
          where pe.store_id = b.store_id and pe.source = 'operator'
          order by pe.created_at desc
          limit 1
       ) g
 where b.store_id = s.id
   and s.slug = 'echos'
   -- ★ THE GUARD. Every one of these was observed on 2026-09-06; if any has
   -- moved since, the row is not what this statement was written for and it
   -- must match zero rows rather than guess.
   and s.plan            = 'pro'
   and s.plan_source     = 'comp'
   and s.plan_expires_at = timestamptz '2026-09-22 20:43:11.096+00'
   and s.comp_plan is null              -- not already backfilled (idempotent)
   and b.plan_source     = 'paid'
   and b.state           = 'active'
   and g.granted_at < now()             -- satisfies stores_comp_window_complete
returning s.slug, s.plan, s.plan_source, s.plan_expires_at,
          s.comp_plan, s.comp_starts_at, s.comp_expires_at;
-- EXPECT EXACTLY 1 ROW. If it returns 0, STOP and re-read STEP 1 — do not
-- loosen the guard to make it fire.

-- Audit it, in the same transaction. ⚠ plan_events.source is
-- 'operator' | 'billing' | 'system' — NOT the 'comp' | 'paid' | 'trial' of
-- stores.plan_source. Writing the wrong vocabulary here is rejected by the
-- CHECK and, sharing this transaction, would roll the backfill back (§15).
insert into plan_events (store_id, from_plan, to_plan, source, actor, note)
select s.id, 'pro', s.plan, 'system', 'comped-plans-backfill',
       'moved the operator Pro grant into the comp overlay; paid entitlement '
       || 'restored from the active subscription'
  from stores s
 where s.slug = 'echos' and s.comp_plan is not null;

-- ═══ STEP 3 — VERIFY BEFORE COMMITTING. ══════════════════════════════════════
-- Reproduces effectivePlan (higher-ranked of paid and comp) at three instants
-- and compares against what the OLD row would have resolved to. All three must
-- read `true`, or the merchant's entitlement moved and this must be rolled back.
with rank(plan, r) as (values ('free',0), ('basic',1), ('pro',2)),
     s as (select * from stores where slug = 'echos'),
     probe(at) as (values
        (now()),
        (timestamptz '2026-09-18 12:00:00+00'),
        (timestamptz '2026-09-23 12:00:00+00'))
select probe.at,
       -- what the row resolves to NOW that it is an overlay
       greatest(
         case when s.plan_expires_at is null or s.plan_expires_at > probe.at
              then (select r from rank where rank.plan = s.plan) else 0 end,
         case when s.comp_expires_at is not null and s.comp_expires_at > probe.at
              then (select r from rank where rank.plan = s.comp_plan) else 0 end
       ) as after_rank,
       -- what the ORIGINAL row (pro, expiring 2026-09-22) resolved to
       case when timestamptz '2026-09-22 20:43:11.096+00' > probe.at then 2 else 0 end
         as before_rank,
       greatest(
         case when s.plan_expires_at is null or s.plan_expires_at > probe.at
              then (select r from rank where rank.plan = s.plan) else 0 end,
         case when s.comp_expires_at is not null and s.comp_expires_at > probe.at
              then (select r from rank where rank.plan = s.comp_plan) else 0 end
       ) = case when timestamptz '2026-09-22 20:43:11.096+00' > probe.at then 2 else 0 end
         as unchanged
  from s, probe;

-- ★★ AND ASSERT IT, so the transaction cannot commit unless it holds. A SELECT
-- a human has to read is not a gate; this is. It also re-checks that the guarded
-- UPDATE actually fired, so a silent zero-row match aborts instead of committing
-- an audit row for a backfill that never happened.
do $$
declare
  r   record;
  bef int;
  aft int;
  at_ timestamptz;
begin
  select plan, plan_source, plan_expires_at, comp_plan, comp_starts_at, comp_expires_at
    into r from stores where slug = 'echos';

  if r.plan <> 'basic' or r.plan_source <> 'paid' or r.comp_plan <> 'pro'
     or r.comp_starts_at is null or r.comp_expires_at is null then
    raise exception 'backfill did not apply: the guarded UPDATE matched no row (plan=%, source=%, comp=%)',
      r.plan, r.plan_source, r.comp_plan;
  end if;

  foreach at_ in array array[
        now(),
        timestamptz '2026-09-18 12:00:00+00',
        timestamptz '2026-09-23 12:00:00+00']
  loop
    aft := greatest(
      case when r.plan_expires_at is null or r.plan_expires_at > at_
           then case r.plan when 'pro' then 2 when 'basic' then 1 else 0 end else 0 end,
      case when r.comp_expires_at > at_
           then case r.comp_plan when 'pro' then 2 when 'basic' then 1 else 0 end else 0 end);
    -- The ORIGINAL row: plan 'pro', expiring 2026-09-22 20:43:11.096+00.
    bef := case when timestamptz '2026-09-22 20:43:11.096+00' > at_ then 2 else 0 end;
    if aft <> bef then
      raise exception 'entitlement CHANGED at %: was rank %, now rank %', at_, bef, aft;
    end if;
  end loop;

  raise notice 'verified: entitlement unchanged at all three instants';
end $$;

-- commit;    ← uncomment only when STEP 2 returned 1 row and STEP 3 is all true
-- rollback;  ← otherwise


-- ═══ ROLLBACK (after committing, if it must be undone) ═══════════════════════
-- Restores the exact pre-backfill row. Safe to run more than once.
--
-- update stores
--    set plan               = 'pro',
--        plan_source        = 'comp',
--        plan_expires_at    = timestamptz '2026-09-22 20:43:11.096+00',
--        comp_plan          = null,
--        comp_duration_days = null,
--        comp_offered_at    = null,
--        comp_starts_at     = null,
--        comp_expires_at    = null
--  where slug = 'echos' and comp_plan = 'pro';
