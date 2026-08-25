-- Publish the merchant Payments, GST & COD Help Centre foundation.
-- These guides describe shipped behaviour only. Keep the content database-
-- backed so operators can refine it without creating a second source of truth.

WITH payments_category AS (
  SELECT id
  FROM public.help_categories
  WHERE slug = 'payments'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT payments_category.id,
       document.slug,
       document.title,
       document.excerpt,
       document.body,
       'published',
       document.seo_title,
       document.seo_description,
       document.position,
       now()
FROM payments_category
CROSS JOIN (VALUES
  (
    'connect-razorpay-and-accept-online-payments',
    'Connect Razorpay and accept online payments',
    'Connect your own Razorpay account, add its webhook, pause or disconnect it safely, and understand where customer money settles.',
    $article$<p>StoreMink connects to a Razorpay account owned by your business. Customers pay through that account and Razorpay settles the money directly to you. StoreMink does not hold the sale proceeds or add a StoreMink transaction fee.</p>
<h2>Before you connect</h2>
<ul><li>Confirm that online payments are available on the store's current plan. The dashboard shows the current requirement.</li><li>Use the Razorpay account that should receive this store's customer payments.</li><li>Sign in to Razorpay and create API keys under <strong>Settings → API keys</strong>.</li><li>Keep the key secret private. Never paste it into chat, email, or a support screenshot.</li></ul>
<h2>Connect the account</h2>
<ol><li>From the StoreMink dashboard, open <strong>Settings → Channels</strong>.</li><li>Open <strong>Razorpay</strong>.</li><li>Paste the Razorpay key ID and key secret.</li><li>Select <strong>Verify &amp; save</strong>. StoreMink verifies the credentials with Razorpay before saving them.</li><li>After the connection opens, select <strong>Generate a webhook secret</strong>.</li><li>Copy and save the generated secret before leaving the screen. StoreMink shows this secret only once.</li><li>In Razorpay, open <strong>Settings → Webhooks → Add New Webhook</strong>.</li><li>Paste the webhook URL shown by StoreMink, enter the generated secret, and enable <strong>payment.captured</strong>.</li></ol>
<p>The Razorpay key secret is encrypted and write-only after it is saved. The separate webhook secret is also stored securely and shown only when it is generated. StoreMink later shows connection state and the webhook URL, but it does not reveal either saved secret again. Generate a new webhook secret if the one-time value was not copied, then update the Razorpay webhook to the new value.</p>
<h2>Pause or disconnect</h2>
<p>Pausing stops new online checkouts while keeping the saved connection. Disconnecting removes StoreMink's saved credentials; it does not close or alter the Razorpay account. Existing orders, payment references, refunds, and invoices remain in StoreMink.</p>
<h2>Check the connection</h2>
<p>Use a real payment only when you are prepared for it to settle normally. StoreMink checks signed provider responses and can also receive a webhook when the shopper closes the page early. Before fulfilling a first or unusual payment, match the StoreMink order, amount, currency, and captured state in the connected Razorpay account. Stop and contact support if those records disagree.</p>
<p>If StoreMink says payment is still being confirmed, do not ask the customer to pay a second time. See <a href="/help/payments/understand-pending-and-failed-online-payments">Understand pending and failed online payments</a>.</p>$article$,
    'Connect Razorpay to StoreMink',
    'Connect your own Razorpay account to StoreMink, configure its webhook, understand settlement, and pause or disconnect online payments safely.',
    1
  ),
  (
    'choose-online-cod-and-pay-at-store-options',
    'Choose online payment, COD, and pay at store',
    'Understand the payment choices StoreMink can offer at website checkout, pickup checkout, and the Point of Sale counter.',
    $article$<p>StoreMink keeps the customer's checkout choice separate from the payment that is finally taken at a counter. This prevents a pickup promise from being mistaken for cash, card, or UPI.</p>
<h2>Online payment</h2>
<p>Online payment uses the store's connected Razorpay account. StoreMink creates a pending order, opens Razorpay, and uses signed provider responses for that pending order to update payment state. Online payment is available only while the connection and the store's plan allow it. Reconcile the amount, currency, and captured state in Razorpay whenever the records look unusual or the order is high value.</p>
<h2>Cash on Delivery</h2>
<p>Cash on Delivery can be offered without an online gateway. It records that money is due when a delivery is completed; it does not mean StoreMink collected cash at checkout. Your delivery and accounting process remains responsible for collecting and reconciling it.</p>
<h2>Pay at store for pickup</h2>
<p><strong>Pay at store</strong> is a promise that payment is due when the customer collects a pickup order. It is not the final tender. At handover, the cashier can take an allowed counter method such as cash, an external card terminal, UPI, a verified online charge, or store credit.</p>
<p>The pickup policy can allow customer choice, require prepayment, or require payment at collection. Requiring prepayment needs a working online gateway. This pickup setting does not change payment choices for delivery orders.</p>
<h2>Counter card and UPI</h2>
<p>At Point of Sale, <strong>Card</strong> and <strong>UPI</strong> record a payment completed on your separate terminal or app. StoreMink does not contact that terminal or verify its settlement. The <strong>Online</strong> tender is different: it creates and verifies a Razorpay charge.</p>
<h2>Before changing payment choices</h2>
<ul><li>Tell staff which counter methods the business accepts and how external terminal references are recorded.</li><li>Do not mark a payment received until the terminal, app, or cash count confirms it.</li><li>Keep at least one valid checkout method available for the fulfilment option you offer.</li><li>Test pickup and delivery separately because their promises and payment timing differ.</li></ul>$article$,
    'Online payment, COD, and pay at store in StoreMink',
    'Understand StoreMink online payment, Cash on Delivery, pickup pay at store, external POS card and UPI records, and verified online tenders.',
    2
  ),
  (
    'understand-pending-and-failed-online-payments',
    'Understand pending and failed online payments',
    'Learn why an online payment can remain pending, how StoreMink reconciles it, and how to avoid charging a customer twice.',
    $article$<p>A customer can leave the payment page, lose the network, or close the browser after Razorpay receives money. StoreMink therefore treats the browser result as one signal, not the only source of truth.</p>
<h2>What the states mean</h2>
<ul><li><strong>Pending:</strong> StoreMink created the order but has not accepted a successful provider result for it.</li><li><strong>Paid:</strong> StoreMink accepted a signed browser result or payment webhook for the pending order. For fulfilment and accounting, reconcile the provider's amount, currency, and captured state when anything looks inconsistent.</li><li><strong>Failed:</strong> Razorpay or StoreMink has confirmed that the attempt did not complete.</li><li><strong>Cancelled or expired:</strong> the order can no longer complete through that attempt. Reserved stock and coupon use are released through the order workflow.</li></ul>
<h2>If the customer says money was debited</h2>
<ol><li>Open the order and read its payment message and Razorpay reference.</li><li>Check the same payment in the connected Razorpay account.</li><li>If Razorpay shows the expected captured amount while StoreMink remains pending, wait for the webhook or scheduled reconciliation instead of taking another payment.</li><li>If the status remains uncertain, contact support with the StoreMink order reference and Razorpay payment ID. Do not share API secrets or card details.</li></ol>
<h2>Do not force success</h2>
<p>Never mark an order paid merely because a shopper shows a message or bank alert. Compare the payment inside the connected Razorpay account. If the StoreMink and Razorpay records disagree on the order, amount, currency, or capture state, do not fulfil or charge again; stop and contact support.</p>
<h2>Point of Sale exception to understand</h2>
<p>The POS checks live shelf stock before starting an Online tender, but it does not hold that stock while the customer pays. Another till can sell the last unit during the charge. If Razorpay captures the payment and final sale completion then fails for stock, do not charge again; refund the captured payment from the dashboard using the original order and payment reference.</p>
<h2>If the payment failed</h2>
<p>Ask the customer to confirm that the first attempt is not captured before trying a new one. A genuine failed attempt can be retried. A pending or unknown attempt should be reconciled first.</p>$article$,
    'Pending and failed StoreMink online payments',
    'Understand pending, paid, failed, cancelled, and expired StoreMink Razorpay payments, reconciliation, duplicate-charge prevention, and POS stock races.',
    3
  ),
  (
    'set-up-gst-and-tax-classes',
    'Set up GST and tax classes',
    'Turn tax calculation on, choose inclusive or exclusive prices, create GST rates, and assign the correct class to products.',
    $article$<p>Tax settings decide how StoreMink calculates and displays GST on website orders, Point of Sale receipts, and customer invoices. Configure them with your accountant or tax adviser; StoreMink provides calculation tools, not tax advice.</p>
<h2>Open tax settings</h2>
<ol><li>From the dashboard, open <strong>Settings → Taxes &amp; invoices</strong>.</li><li>Enter the business name, address, GSTIN, contact details, and invoice prefix that should appear on customer documents.</li><li>Turn tax calculation on only when the business details and rates are ready.</li><li>Choose whether product prices already include tax.</li><li>Save the settings.</li></ol>
<h2>Inclusive and exclusive prices</h2>
<ul><li><strong>Prices include tax:</strong> GST is separated from the listed selling price. Turning tax on does not add the tax again at checkout.</li><li><strong>Prices exclude tax:</strong> StoreMink adds the calculated tax to the taxable amount.</li></ul>
<p>Changing this setting changes future calculations. It does not rewrite the tax snapshot on an order that was already placed.</p>
<h2>Create tax classes</h2>
<ol><li>In <strong>Taxes &amp; invoices</strong>, add a clear class such as <strong>GST 5%</strong>, <strong>GST 12%</strong>, or <strong>GST 18%</strong>.</li><li>Enter the full GST rate.</li><li>Choose a default class for products that do not have their own class.</li><li>Open a product and choose a different tax class when that product needs one.</li></ol>
<p>StoreMink groups tax by rate and applies an order discount proportionally across taxable lines. A product's own class takes priority over the store default.</p>
<h2>Understand the current GST split</h2>
<p>Point of Sale uses the selling location's state and an entered business GSTIN to choose CGST plus SGST or IGST for the receipt. Website checkout and the current A4 order invoice show tax grouped by rate; they do not currently collect and render the same customer place-of-supply split. Do not rely on the website invoice alone for a statutory CGST, SGST, or IGST breakdown. Confirm the required document treatment with your accountant.</p>
<h2>Before publishing</h2>
<ul><li>Check the GSTIN format and state.</li><li>Confirm every rate and product assignment.</li><li>Preview a taxable invoice for inclusive and exclusive totals.</li><li>Ask a qualified adviser to confirm the business's registration, place-of-supply, HSN/SAC, and reporting duties.</li></ul>$article$,
    'Set up StoreMink GST and tax classes',
    'Configure StoreMink GST details, inclusive or exclusive prices, product tax classes, default rates, and CGST, SGST, or IGST calculation.',
    4
  ),
  (
    'create-and-share-customer-invoices',
    'Create and share customer invoices',
    'Understand when StoreMink creates an invoice, which transaction facts stay fixed, and which current business-template details can change on reprint.',
    $article$<p>StoreMink creates customer-facing order and Point of Sale documents from the facts saved with the transaction. A settled taxable refund can also create a GST credit note linked to the original invoice.</p>
<h2>Prepare the invoice identity</h2>
<ol><li>Open <strong>Settings → Taxes &amp; invoices</strong>.</li><li>Add the legal business name, address, tax registration, email, phone, logo, prefix, colour, footer note, and terms that apply.</li><li>Choose which fields appear in the invoice template.</li><li>Save and preview the result.</li></ol>
<p>Use a short invoice prefix that your team recognises. Invoice and credit-note numbering is generated by StoreMink; do not invent a new number when reprinting an existing document.</p>
<h2>Add the customer's GSTIN</h2>
<p>A cashier can enter a business GSTIN on a POS sale even without attaching a customer account. StoreMink validates the shape, changes letters to uppercase, and saves it with the POS transaction. Website checkout does not currently ask the shopper for a GSTIN.</p>
<h2>Open an invoice</h2>
<ul><li>From the dashboard, open the order and select <strong>Print invoice</strong>.</li><li>Use the browser print window to print a copy or save it as a PDF before sharing it through an approved business channel.</li><li>A customer can open the invoice from the order confirmation or order history when that route is available to them.</li><li>For a POS sale, print or reprint the receipt from Sales. Emailing a receipt needs a customer email address.</li></ul>
<h2>What stays fixed and what can change on reprint</h2>
<p>Prices, quantities, discounts, and saved tax amounts come from the transaction rather than today's product catalogue. However, the current A4 reprint also reads the store's latest invoice template and business identity. Changing the logo, prefix, address, contact details, GSTIN, footer, or template settings can therefore change how a historical invoice reprints. Save or print the issued PDF when an immutable document copy is required.</p>
<h2>Invoice versus plan invoice</h2>
<p>A customer order invoice records what your shop sold. A StoreMink plan or AI-credit invoice records what your business bought from StoreMink and is found under <strong>Plan &amp; billing</strong>. They use separate numbering and should not be treated as the same document.</p>
<p>StoreMink's document output should be reviewed for the business's legal and accounting requirements. Contact a tax professional when you need advice about GST compliance.</p>$article$,
    'Create StoreMink customer invoices',
    'Set up StoreMink customer invoice details, add a POS buyer GSTIN, open or reprint an order invoice, and understand fixed transaction values versus current template details.',
    5
  ),
  (
    'issue-full-and-partial-refunds-safely',
    'Issue full and partial refunds safely',
    'Refund an order to its original Razorpay payment, record a manual refund, or issue store credit without duplicating money.',
    $article$<p>A refund is a money movement. Cancelling an order, receiving returned goods, or changing an order status does not by itself prove that money reached the customer.</p>
<p><strong>Before the first live Razorpay refund:</strong> use a small controlled order in the merchant's own account, confirm the provider result, StoreMink reconciliation, and final refund state, and keep the reference. Until that test succeeds, do not rely on the automated path for a customer deadline; complete the refund once in Razorpay and record the same movement manually in StoreMink.</p>
<h2>Before refunding</h2>
<ol><li>Open the order and confirm the customer, amount paid, earlier refunds, and reason.</li><li>Check whether returned stock has been received and whether the refund should restock anything.</li><li>Choose the amount. StoreMink prevents the completed and pending refund total from exceeding the refundable amount.</li><li>Choose an honest destination.</li></ol>
<h2>Original online payment</h2>
<p>After the controlled live test has succeeded for the connected merchant account, use the original-payment option for an eligible Razorpay payment. StoreMink writes a pending refund before contacting Razorpay and uses an idempotency reference so a retry cannot intentionally create a second refund. An online card payment is returned through Razorpay, not from the cash drawer.</p>
<h2>Manual refund</h2>
<p>Use a manual refund only after money was returned outside StoreMink, such as through a supported bank or cash process. Enter a useful external reference. This records what happened; it does not move money for you.</p>
<h2>Store credit</h2>
<p>Choose store credit when the customer agrees and an eligible customer account is attached. StoreMink adds the value to that store's credit ledger instead of calling Razorpay or paying cash.</p>
<h2>If the provider times out</h2>
<p>A timeout or unknown Razorpay result remains <strong>pending</strong>. It still counts against the refundable balance while StoreMink reconciles it. Do not create another refund or refund separately from Razorpay until the first result is known.</p>
<h2>GST credit notes</h2>
<p>A settled refund on a taxed order can receive a consecutive credit-note number and reverse the corresponding taxable value. For POS orders with saved supplier and place-of-supply state facts, the credit note can derive the CGST/SGST or IGST treatment from those saved states. Website checkout does not currently preserve the same split facts, so review a website-order credit note with the business's accountant instead of assuming it reproduces an original split. A pending or failed refund does not receive a final credit-note serial. The credit note records a tax reversal; it is not a second refund.</p>
<h2>If a refund fails</h2>
<p>Read the order's exact message. Reconnect the correct Razorpay account when credentials are missing. When the provider directs you to refund in its own dashboard, complete it there once and then record the same refund manually with the provider reference. Never report a refund complete until its money movement is known.</p>$article$,
    'Issue safe refunds in StoreMink',
    'Issue full or partial StoreMink refunds through Razorpay, manual methods, or store credit, handle pending results safely, and understand GST credit notes.',
    6
  ),
  (
    'use-and-understand-store-credit',
    'Use and understand store credit',
    'Learn how StoreMink issues, spends, restores, and reports customer store credit across online checkout, POS, and pickup.',
    $article$<p>Store credit is value held for one customer in one StoreMink store. It is a payment method, not a coupon or discount, so invoices still show the goods value and calculate GST on the correct taxable amount.</p>
<h2>How a customer receives credit</h2>
<p>The shipped merchant workflow issues store credit as a refund destination. StoreMink adds a ledger entry and updates the customer's balance together. There is no general gift-card feature, expiry rule, or merchant screen for granting arbitrary promotional credit.</p>
<h2>Where it can be spent</h2>
<ul><li><strong>Online checkout:</strong> an authenticated customer can apply available credit. If a small remaining amount cannot be charged safely online, StoreMink can hold back enough credit for the gateway minimum.</li><li><strong>Point of Sale:</strong> attach the customer, then choose store credit as a tender. It can be combined with another allowed tender.</li><li><strong>Pickup:</strong> attach the correct customer and use store credit for the amount due at collection. Store credit is applied as a completed payment, not as an unsecured deposit.</li></ul>
<h2>Balance protection</h2>
<p>StoreMink checks and spends the balance atomically. Two tills or checkouts cannot both spend the same value successfully. If the balance changes while payment is open, the later attempt is refused and staff should refresh before trying again.</p>
<h2>Cancellations and refunds</h2>
<p>When checkout or payment failure cleanup, or a supported cancellation, reverses an order that spent store credit, StoreMink restores the eligible amount exactly once. A later dashboard refund does not automatically reinstate previously spent credit; it issues new credit only when staff explicitly choose <strong>Store credit</strong> as the refund destination. Restocking physical goods and restoring customer value remain separate decisions.</p>
<h2>Important limits</h2>
<ul><li>Credit belongs to one store and cannot be transferred to another merchant.</li><li>A customer must be identified before credit can be used.</li><li>Store credit is not cash and is not automatically paid to a bank account.</li><li>Changing a customer's email or later claiming a till-created profile does not create a second balance.</li></ul>
<h2>Check a balance</h2>
<p>The customer can see their available balance in the store profile. Staff can see it after attaching the customer in an allowed checkout. Use the ledger and related order or refund reference when investigating a difference; do not adjust an amount only from memory.</p>$article$,
    'Use StoreMink customer store credit',
    'Understand StoreMink store credit issuance, online and POS spending, pickup payments, cancellation restoration, balance safety, and current limits.',
    7
  ),
  (
    'troubleshoot-payments-tax-and-refunds',
    'Troubleshoot payments, GST, and refunds',
    'Use safe checks for gateway connections, missing payment choices, unexpected tax, duplicate-risk payments, pending refunds, and invoice differences.',
    $article$<p>Start with the order, payment, refund, or invoice reference shown in StoreMink. Do not solve a payment problem by changing an order status or entering a second transaction without checking the first one.</p>
<h2>Online payment is missing</h2>
<ul><li>Open <strong>Settings → Channels → Razorpay</strong> and confirm the account is connected and enabled.</li><li>Check that the current plan allows online payments.</li><li>Confirm the shopper chose a fulfilment method that has a valid payment option.</li><li>For pickup that requires prepayment, reconnect the gateway before enabling that policy.</li></ul>
<h2>Razorpay rejected the credentials</h2>
<p>Create or copy an active key pair from the intended Razorpay account. Paste the key ID and secret without extra text. StoreMink verifies them before saving. Do not send the secret to support.</p>
<h2>A customer may have paid twice</h2>
<p>Stop taking payments. Compare the StoreMink order and every Razorpay payment ID, amount, currency, and capture state. Reconcile the pending order first, then refund only a confirmed duplicate. A bank alert alone is not enough to decide which attempt settled.</p>
<h2>GST looks wrong</h2>
<ul><li>Check whether tax calculation is enabled and prices are inclusive or exclusive.</li><li>Check the product's tax class and the store default.</li><li>Check the location state, customer place of supply, and GSTIN state digits.</li><li>Remember that discounts are allocated across taxable lines and can change each rate's taxable value.</li><li>Open the original invoice. Later setting changes do not rewrite an earlier order.</li></ul>
<h2>A refund is still pending</h2>
<p>Do not retry blindly. A pending provider result reserves that part of the refundable amount. Refresh the order and compare it with Razorpay. If it remains unresolved, send support the order reference, refund reference, and Razorpay ID, but no keys, OTPs, card numbers, or customer secrets.</p>
<h2>The invoice and dashboard total differ</h2>
<p>Check that you are comparing the same order and document. Store credit is payment, not a discount; inclusive tax is already inside the selling price; shipping and order discounts have their own lines; and a completed later refund is represented by its refund and credit note rather than rewriting the original invoice.</p>
<h2>When to get professional help</h2>
<p>Contact a qualified tax adviser for registration, GST rate, place-of-supply, HSN/SAC, filing, and legal-document requirements. Contact StoreMink support for a reproducible calculation or status problem, using redacted screenshots and safe references.</p>$article$,
    'Troubleshoot StoreMink payments, GST, and refunds',
    'Fix StoreMink Razorpay connection, missing checkout methods, duplicate-risk or pending payments, GST differences, refunds, and invoice questions safely.',
    8
  )
) AS document(
  slug, title, excerpt, body, seo_title, seo_description, position
)
ON CONFLICT (slug) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  body = EXCLUDED.body,
  status = 'published',
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  position = EXCLUDED.position,
  published_at = COALESCE(existing.published_at, EXCLUDED.published_at, now()),
  updated_at = now();

DO $migration$
DECLARE
  category_count integer;
  article_count integer;
BEGIN
  SELECT count(*) INTO category_count
  FROM public.help_categories
  WHERE slug = 'payments';

  IF category_count <> 1 THEN
    RAISE EXCEPTION '20260826_0022 expected one payments Help Centre category, found %', category_count;
  END IF;

  SELECT count(*) INTO article_count
  FROM public.help_articles article
  INNER JOIN public.help_categories category ON category.id = article.category_id
  WHERE category.slug = 'payments'
    AND article.status = 'published'
    AND article.slug IN (
      'connect-razorpay-and-accept-online-payments',
      'choose-online-cod-and-pay-at-store-options',
      'understand-pending-and-failed-online-payments',
      'set-up-gst-and-tax-classes',
      'create-and-share-customer-invoices',
      'issue-full-and-partial-refunds-safely',
      'use-and-understand-store-credit',
      'troubleshoot-payments-tax-and-refunds'
    );

  IF article_count <> 8 THEN
    RAISE EXCEPTION '20260826_0022 expected 8 published payment guides, found %', article_count;
  END IF;
END
$migration$;
