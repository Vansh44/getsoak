-- Keep the published Mink guide aligned with proposal restoration, independent
-- rollout gates and the exact checkpoint behavior hardened after Phase 4.

UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Draft troubleshooting</h2>',
      $reliability$<h2>Proposal and approval reliability</h2>
<p>A generated proposal appears as a private proposal card in the live answer and in the retained conversation after a refresh. The card contains the saved proposal and its Review controls; plain answer text is not a substitute for that card. If a proposal cannot be restored, retry from the original prompt before generating another one so you can verify whether credits were already charged.</p>
<p>StoreMink controls general Mink availability and private drafting separately. Removing the invitation-only rollout requirement does not enable drafting for every store: StoreMink support must still enable the store's drafting switch, and the signed-in admin still needs the matching Manage permission. Each live-action tool remains independently disabled until support enables it.</p>
<p>Approval checks use the exact database checkpoint captured by the preview. An unchanged destination can be approved normally, including coupons whose date fields use an equivalent display format. If another person or tab changes the destination after preview, Mink refuses the old approval and asks you to review a new one. The same checkpoint rule protects rollback from overwriting later manual work.</p>
<h2>Draft troubleshooting</h2>$reliability$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body NOT LIKE '%Proposal and approval reliability%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND body LIKE '%Proposal and approval reliability%'
      AND body LIKE '%retained conversation after a refresh%'
      AND body LIKE '%does not enable drafting for every store%'
      AND body LIKE '%exact database checkpoint captured by the preview%'
  ) THEN
    RAISE EXCEPTION 'Mink proposal and action reliability guidance was not installed';
  END IF;
END $$;
