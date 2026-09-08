-- Forward-only Help guidance; no merchant data or permissions change.
DO $help_recovery$
DECLARE
  guidance text := $guide$<h2>If the Help Centre cannot load</h2><p>Open <a href="https://help.storemink.com">help.storemink.com</a> to browse topics and published guides. You do not need to sign in or reload the page to reveal the articles.</p><p>If you see <strong>Help Centre is temporarily unavailable</strong>, wait a moment and select <strong>Try again</strong>. This loads the guides again without leaving the page. A temporary loading problem does not mean the guides have been deleted or that your store has lost access.</p><p>If the problem continues, email <a href="mailto:support@storemink.com">support@storemink.com</a> with the page address, approximate time and the message shown. Do not include passwords, one-time codes or customer information.</p>$guide$;
BEGIN
  UPDATE public.help_articles
  SET body = body || guidance, updated_at = now()
  WHERE slug = 'troubleshoot-signup-login-and-store-access'
    AND status = 'published'
    AND category_id IS NOT NULL
    AND position('<h2>If the Help Centre cannot load</h2>' in body) = 0;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'troubleshoot-signup-login-and-store-access'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND position(guidance in body) > 0
  ) THEN
    RAISE EXCEPTION 'Help Centre recovery guidance was not installed; apply the getting-started Help baseline first';
  END IF;
END;
$help_recovery$;
