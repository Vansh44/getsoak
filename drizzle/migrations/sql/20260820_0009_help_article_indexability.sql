-- A published Help article needs a category because its canonical URL is
-- /help/{category}/{slug}. Repair any legacy orphan first, then make the
-- database enforce the same rule as the operator actions and sitemap.

UPDATE public.help_articles
SET status = 'draft',
    published_at = NULL,
    updated_at = now()
WHERE status = 'published'
  AND category_id IS NULL;

ALTER TABLE public.help_articles
ADD CONSTRAINT help_articles_published_has_category
CHECK (status <> 'published' OR category_id IS NOT NULL);
