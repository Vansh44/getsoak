-- Attribute every POS tender to the drawer that actually took it.
--
-- orders.shift_id remains the sale/collection completion shift for historical
-- gross-sales reporting. It cannot identify the drawer for deposits because an
-- order can accept money on several shifts before it is collected.

ALTER TABLE public.order_payments
  ADD COLUMN shift_id uuid;

-- Preserve the old attribution for existing tender rows before readers switch
-- to the new source of truth.
UPDATE public.order_payments AS payment
SET shift_id = sale.shift_id
FROM public.orders AS sale
WHERE sale.id = payment.order_id
  AND payment.shift_id IS NULL
  AND sale.shift_id IS NOT NULL;

ALTER TABLE public.order_payments
  ADD CONSTRAINT order_payments_shift_id_fkey
    FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE SET NULL;

CREATE INDEX order_payments_shift_captured_idx
  ON public.order_payments (shift_id, captured_at);

COMMENT ON COLUMN public.order_payments.shift_id IS
  'Drawer shift that captured this tender; NULL when open shifts are optional and none was open.';
