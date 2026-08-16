-- AI-credit packs are paid in their dedicated one-time Razorpay checkout.
-- Their linked accounting invoice was historically finalized as `open`, which
-- made the subscription debt banner offer to collect the same ₹59 again.
--
-- The purchase row is the payment evidence. Repair only invoices linked to a
-- purchase already marked paid; never infer payment from invoice kind alone.
-- Including drafts also repairs the narrow case where credit settlement won but
-- document finalization failed. Setting finalized_at allocates its gapless
-- invoice number through the existing trigger.

update public.billing_invoices as invoice
   set finalized_at = coalesce(
         invoice.finalized_at,
         purchase.updated_at,
         invoice.updated_at,
         clock_timestamp()
       ),
       paid_at = coalesce(
         invoice.paid_at,
         purchase.updated_at,
         invoice.finalized_at,
         clock_timestamp()
       ),
       status = 'paid',
       updated_at = clock_timestamp()
  from public.ai_credit_purchases as purchase
 where purchase.invoice_id = invoice.id
   and purchase.status = 'paid'
   and invoice.kind = 'ai_credits'
   and invoice.status in ('draft', 'open', 'processing');
