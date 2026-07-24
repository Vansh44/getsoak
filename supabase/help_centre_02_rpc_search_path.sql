-- Help Centre follow-up: harden the two public SECURITY DEFINER counter RPCs.
--
-- help_article_view / help_article_vote shipped with `SET search_path = public`
-- and unqualified table references. Every other SECURITY DEFINER function in
-- this codebase pins `search_path = ''` and fully-qualifies objects (see
-- adjust_stock, the coupon-usage / identifier allocators), which removes any
-- search-path-hijack surface. Align these two for consistency.
--
-- CREATE OR REPLACE keeps the functions' existing GRANTs (app_user, app_service),
-- so no re-grant is needed. Same signature = in-place replace, no overload.
-- Idempotent + safe to re-run. Run as the function owner (postgres) via the
-- Cloud SQL proxy, like every migration here.

CREATE OR REPLACE FUNCTION public.help_article_view(p_id UUID)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.help_articles SET view_count = view_count + 1
  WHERE id = p_id AND status = 'published';
$$;

CREATE OR REPLACE FUNCTION public.help_article_vote(p_id UUID, p_helpful BOOLEAN)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.help_articles
     SET helpful_yes = helpful_yes + (CASE WHEN p_helpful THEN 1 ELSE 0 END),
         helpful_no  = helpful_no  + (CASE WHEN p_helpful THEN 0 ELSE 1 END)
   WHERE id = p_id AND status = 'published';
$$;

-- Rollback: re-run the original definitions from help_centre.sql
-- (SET search_path = public, unqualified help_articles).
