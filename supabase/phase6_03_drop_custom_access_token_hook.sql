-- Phase 6 follow-up: drop the dead Supabase-era custom_access_token_hook
--
-- custom_access_token_hook was a Supabase Auth (GoTrue) hook that injected
-- user_role / force_password_reset claims into the JWT at token-mint time. In
-- Phase 6 auth moved to Identity Platform (Firebase) and those claims are now
-- set by lib/auth/firebase-claims.ts, so NOTHING invokes this function anymore
-- (there is no GoTrue running against Cloud SQL). It is also now stale: after
-- phase6_01 retyped admins.id/users.id to text, its (event->>'user_id')::uuid
-- cast no longer matches those columns — harmless only because it is never
-- called. Keeping it as a "Supabase rollback" artifact conflicts with the
-- clean-cut, Firebase-only migration (reverting to Supabase auth is no longer a
-- realistic git-revert; this one hook wouldn't get you there), so we remove it
-- and the two Supabase-only grants + RLS policy that only existed to feed it.
--
-- Run as the table/function owner (postgres) via the Cloud SQL proxy, like
-- every other migration in this directory. Idempotent + safe to re-run.

-- 1. The RLS policy that let the Supabase auth role read admins for the hook.
DROP POLICY IF EXISTS "Auth admin can read admins for token hook" ON public.admins;

-- 2. The hook itself. No CASCADE — if some unexpected object depends on it we
--    want to see the error, not silently drop dependents. Dropping the function
--    also removes its EXECUTE grant.
DROP FUNCTION IF EXISTS public.custom_access_token_hook(jsonb);

-- 3. The remaining explicit grants to the Supabase auth role, guarded so this
--    stays safe on any environment where the role was already decommissioned.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    REVOKE SELECT ON TABLE public.admins FROM supabase_auth_admin;
    REVOKE USAGE ON SCHEMA public FROM supabase_auth_admin;
  END IF;
END $$;

-- NOTE: the supabase_auth_admin ROLE itself is intentionally left in place — it
-- may still back other Supabase-era grants across the schema, so removing it
-- belongs to a broader Supabase-role decommission (REASSIGN OWNED / DROP OWNED /
-- DROP ROLE), not to this focused cleanup.

-- ============================================================================
-- Rollback (recreates the hook + its grants + policy exactly as they were):
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
-- RETURNS jsonb
-- LANGUAGE plpgsql
-- STABLE
-- AS $fn$
-- DECLARE
--   claims jsonb;
--   v_role text;
--   v_force boolean;
-- BEGIN
--   SELECT role, force_password_reset
--     INTO v_role, v_force
--   FROM public.admins
--   WHERE id = (event->>'user_id')::uuid;   -- NB: pre-phase6_01, admins.id was uuid
--
--   claims := event->'claims';
--   claims := jsonb_set(claims, '{user_role}',
--     CASE WHEN v_role IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_role) END);
--   claims := jsonb_set(claims, '{force_password_reset}',
--     to_jsonb(COALESCE(v_force, false)));
--   event := jsonb_set(event, '{claims}', claims);
--   RETURN event;
-- END;
-- $fn$;
--
-- GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
-- GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
-- GRANT SELECT ON TABLE public.admins TO supabase_auth_admin;
-- REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook
--   FROM authenticated, anon, public;
-- CREATE POLICY "Auth admin can read admins for token hook"
--   ON public.admins FOR SELECT TO supabase_auth_admin USING (true);
-- ============================================================================
