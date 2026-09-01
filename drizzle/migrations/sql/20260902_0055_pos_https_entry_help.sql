-- Explain the production HTTP-to-HTTPS entry path without changing the
-- original, already-applied POS Help Centre migration.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Where to open the register</h2>',
      $https$<h2>Where to open the register</h2>
<p>You can type the address normally without adding <strong>https://</strong>. StoreMink permanently upgrades a plain HTTP request to the same host, path, and query on encrypted HTTPS.</p>$https$
    ),
    updated_at = now()
WHERE slug = 'pos-overview-and-requirements'
  AND status = 'published'
  AND body NOT LIKE '%StoreMink permanently upgrades a plain HTTP request%';

UPDATE public.help_articles
SET body = $https$<h2>The address says this site cannot be reached</h2>
<p>You can type <strong>pos.storemink.com</strong> or your merchant address normally; you do not need to add <strong>https://</strong>. StoreMink permanently redirects a plain HTTP request to encrypted HTTPS. If the message remains after reloading, check the phone's connection and try another network. The public <strong>pos.storemink.com</strong> page explains the product; to use the register, open your merchant store domain followed by <strong>/pos</strong>.</p>
$https$ || body,
    updated_at = now()
WHERE slug = 'troubleshoot-pos-and-internet-issues'
  AND status = 'published'
  AND body NOT LIKE '%<h2>The address says this site cannot be reached</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'pos-overview-and-requirements'
      AND status = 'published'
      AND body LIKE '%StoreMink permanently upgrades a plain HTTP request%'
      AND body LIKE '%the same host, path, and query on encrypted HTTPS%'
  ) THEN
    RAISE EXCEPTION 'POS overview HTTPS entry guidance was not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'troubleshoot-pos-and-internet-issues'
      AND status = 'published'
      AND body LIKE '%<h2>The address says this site cannot be reached</h2>%'
      AND body LIKE '%you do not need to add <strong>https://</strong>%'
      AND body LIKE '%your merchant store domain followed by <strong>/pos</strong>%'
  ) THEN
    RAISE EXCEPTION 'POS troubleshooting HTTPS entry guidance was not installed';
  END IF;
END $$;
