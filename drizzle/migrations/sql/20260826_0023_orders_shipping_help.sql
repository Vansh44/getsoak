-- Publish the Orders & shipping Help Centre foundation and repair a small set
-- of already-published POS/Analytics statements that no longer match the UI.
-- This is forward-only: earlier content migrations remain immutable.

WITH orders_category AS (
  SELECT id
  FROM public.help_categories
  WHERE slug = 'orders'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT orders_category.id,
       document.slug,
       document.title,
       document.excerpt,
       document.body,
       'published',
       document.seo_title,
       document.seo_description,
       document.position,
       now()
FROM orders_category
CROSS JOIN (VALUES
  (
    'manage-website-and-pos-orders',
    'Manage website and POS orders',
    'Find an order, understand its channel and location, use safe filters and exports, and know which actions belong to delivery or POS sales.',
    $article$<p>The Orders workspace brings together website orders and completed Point of Sale sales. The channel tells you where the order began; the assigned location tells you which shop or warehouse owns the physical work.</p>
<h2>Open and find an order</h2>
<ol><li>From the dashboard, open <strong>Orders</strong>.</li><li>Use <strong>All</strong>, <strong>Website</strong>, or <strong>POS</strong> when those tabs are available.</li><li>Search by the order reference or customer information shown by the page.</li><li>Use the available status, payment, method, date, and channel controls to narrow the list.</li><li>Open the row to see products, totals, payment, fulfilment, refund, and customer details.</li></ol>
<p>The POS tab appears only when the store is entitled to POS. Without it, Orders remains the website-order workspace.</p>
<h2>Understand location scope</h2>
<p>The main order list applies the staff member's assigned location scope. Online or older orders without a physical location remain identified as online or unassigned instead of being silently attached to a shop. If restricted staff can open an order or cancellation from a location they were not assigned, treat that as an access problem: do not act on it, record the order reference, and contact StoreMink support.</p>
<h2>Website and POS actions differ</h2>
<ul><li>A delivery order can carry a fulfilment location, parcel, courier, tracking, cancellation, and refund workflow.</li><li>A pickup order moves through preparation and handover at the chosen shop.</li><li>A POS sale is already completed at the counter. It can be searched, reprinted, returned, or refunded where the operator has permission, but it does not receive delivery controls.</li></ul>
<h2>Export safely</h2>
<p>The current export carries the selected status and channel. Search text, date, payment-status, and payment-method filters from the screen are not applied to the file. Open the export and verify its rows before sharing it. Treat customer names, addresses, phone numbers, and payment references as private business data.</p>
<h2>If an order appears under an unexpected total</h2>
<p>Order lists can include pending or operational rows that are not yet recognized sales. Analytics counts paid, COD, or completed/refunded POS orders according to its metric rules and subtracts completed refunds by settlement date. Compare the same date, status, channel, and location before assuming data is missing.</p>$article$,
    'Manage StoreMink website and POS orders',
    'Find, filter, open, and export StoreMink website and POS orders, understand channel and location scope, and use the correct fulfilment actions.',
    1
  ),
  (
    'set-your-order-cancellation-policy',
    'Set your order cancellation policy',
    'Choose whether customers can request cancellation, the allowed time window, and whether requests wait for approval or cancel automatically.',
    $article$<p>StoreMink uses a request-first cancellation flow. A customer asks to cancel the whole order; the saved policy decides whether the request waits for a merchant or is approved automatically.</p>
<h2>Open cancellation settings</h2>
<ol><li>Open <strong>Orders → Order Settings</strong>.</li><li>Turn customer cancellation requests on or off.</li><li>Choose the request window: none, until fulfilment, one hour, 24 hours, or the available custom duration.</li><li>Choose <strong>Require approval</strong> or <strong>Automatic</strong>.</li><li>Save the settings.</li></ol>
<p>Approval is required by default. The server checks the policy again when the customer submits, so an old browser screen cannot bypass a changed window.</p>
<h2>What a request covers</h2>
<p>Cancellation is whole-order only. The customer cannot use this flow to cancel one line, change a variant, or edit the delivery address. If fulfilment is too far advanced or the window closed, the request is refused and the merchant can decide whether another support workflow applies.</p>
<h2>Approval does not equal a refund</h2>
<p>With manual approval, the merchant chooses the refund destination, restocking choice, and customer notification. Automatic cancellation currently records the refund obligation for later handling; it does <strong>not</strong> automatically transfer money to Razorpay, cash, or a bank account.</p>
<h2>Stock and store credit</h2>
<p>When cancellation releases a valid stock reservation, StoreMink claims that release once so a repeated action cannot add the units twice. If this cancellation releases store credit that the same order previously spent, StoreMink reinstates that spent value through its protected ledger path. This is cancellation cleanup, not choosing store credit as a new refund destination. Restocking and restoring customer value are separate decisions.</p>
<h2>Before enabling automatic cancellation</h2>
<ul><li>Make sure the team knows where to find automatically cancelled orders.</li><li>Decide how outstanding online, COD, and store-credit refunds will be completed.</li><li>Confirm the window does not conflict with packing or carrier pickup times.</li><li>Use manual approval when the team must inspect fraud, stock, fulfilment, or payment state first.</li></ul>$article$,
    'Set StoreMink order cancellation rules',
    'Configure StoreMink customer cancellation requests, time windows, approval mode, whole-order limits, stock release, and refund responsibilities.',
    2
  ),
  (
    'review-and-resolve-cancellation-requests',
    'Review and resolve cancellation requests',
    'Approve or decline a customer request, choose an honest refund destination, restock safely, and handle pending or failed refunds.',
    $article$<p>Requests that need review appear under <strong>Orders → Cancellations</strong>. Work from this queue so the decision, operator, reason, refund, stock, and customer message remain connected to the order.</p>
<h2>Review the request</h2>
<ol><li>Open the request and confirm the order, customer, products, payment state, fulfilment progress, and request time.</li><li>Check whether stock is still reserved, already packed, handed to a carrier, collected, or delivered.</li><li>Read earlier refunds and store-credit use before choosing a destination.</li></ol>
<h2>Approve and cancel</h2>
<ol><li>Select <strong>Approve &amp; cancel</strong>.</li><li>Choose whether eligible stock should be released or restocked.</li><li>Choose an available refund destination: original payment, store credit, or handle later.</li><li>Choose whether to notify the customer.</li><li>Confirm once and wait for the result.</li></ol>
<p><strong>Handle later</strong> records an outstanding responsibility; it does not move money. An original online-payment refund goes through Razorpay, never the cash drawer. Store credit is available only for an identified eligible customer.</p>
<h2>Decline</h2>
<p>Enter a clear reason and decline the request. The order remains active. Do not promise a refund in the decline reason unless the business will complete it through a separate supported refund workflow.</p>
<h2>When a refund is pending or unknown</h2>
<p>StoreMink writes a pending refund before calling the provider. A timeout remains pending and counts against the refundable balance until reconciliation decides the outcome. Do not click again or refund separately in Razorpay while the first result is unknown.</p>
<h2>After the decision</h2>
<ul><li>Confirm the order status and stock result.</li><li>Confirm any reinstatement of credit originally spent on this order, or the separately chosen final refund state.</li><li>Review the customer notification when it was requested.</li><li>Keep any manual refund reference with the order.</li></ul>$article$,
    'Review StoreMink cancellation requests',
    'Approve or decline StoreMink order cancellation requests, choose stock and refund outcomes, and handle original-payment, store-credit, later, or pending results.',
    3
  ),
  (
    'set-up-locations-and-capabilities',
    'Set up locations and capabilities',
    'Create shops and warehouses, turn on the jobs each location can perform, and understand staff scope and location limits.',
    $article$<p>A location is a top-level StoreMink workspace shared by inventory, orders, Point of Sale, pickup, returns, and fulfilment. It is not owned by the POS settings area.</p>
<h2>Create or edit a location</h2>
<ol><li>From the dashboard, open <strong>Locations</strong>.</li><li>Create a location or open an existing one.</li><li>Choose the location type and enter its complete address, state, PIN code, contact details, GST details, and receipt information where needed.</li><li>Keep it active when staff and routing may use it.</li><li>Choose its capabilities and save.</li></ol>
<h2>The six capabilities</h2>
<ul><li><strong>Sell here:</strong> allows Point of Sale work at the location.</li><li><strong>Fulfil online orders:</strong> makes its stock eligible for website delivery routing.</li><li><strong>Customer pickup:</strong> lets shoppers choose the shop for collection. It depends on Sell here.</li><li><strong>Accept returns:</strong> is one prerequisite for an eligible website order to be returned at this shop, and it depends on Sell here. It cannot activate website returns by itself. The store-wide Returns settings group is not currently rendered in the merchant dashboard; if this workflow is unavailable, contact StoreMink support instead of promising it to customers.</li><li><strong>Receive stock:</strong> allows inbound receiving into this location.</li><li><strong>Transfer stock:</strong> allows stock transfers involving this location.</li></ul>
<p>StoreMink prevents the last online-fulfilment location from being turned off through the normal location workflow because delivery orders still need a source.</p>
<h2>Location access for staff</h2>
<p>A non-superadmin assigned to particular locations sees only permitted location-shaped data. For non-superadmins, no location assignments means unrestricted access to all locations; it does not mean no access. Superadmins remain store-wide.</p>
<p>The location name shown in the top bar explains the current context. It is not a universal switch that silently changes every page. Use each page's location control where one is provided.</p>
<h2>Plans and additional locations</h2>
<p>Location creation and some capabilities depend on the active plan. The Locations page shows the current included allowance and live price, if any, for an additional location. Do not rely on an old quoted price. Releasing a paid location takes effect according to the subscription cycle, and lowering a plan never silently deletes a shop.</p>
<h2>Before enabling fulfilment or Shiprocket</h2>
<p>Complete the Indian address and monitored contact phone. Shiprocket warehouse sync skips locations without the required address data, even when <strong>Fulfil online orders</strong> is on.</p>$article$,
    'Set up StoreMink locations and capabilities',
    'Create StoreMink locations, configure all six POS, fulfilment, pickup, returns, receiving, and transfer capabilities, and understand staff scope.',
    4
  ),
  (
    'choose-online-fulfilment-priority',
    'Choose online fulfilment priority',
    'Order the locations StoreMink tries for website delivery and understand stock checks, inactive shops, and the current one-location rule.',
    $article$<p>StoreMink currently routes each website delivery order by location priority. It tries eligible locations in the saved order and chooses the first one whose recorded on-hand stock covers the tracked lines for the whole order.</p>
<p><strong>Reservation caveat:</strong> The current routing resolver does not subtract active reservations from on-hand stock. A priority location can therefore be selected even when its truly available stock is lower. Verify available stock before committing fulfilment, especially while pickups or other checkouts hold reservations.</p>
<h2>Prepare eligible locations</h2>
<ol><li>Open <strong>Locations</strong>.</li><li>Open each warehouse or shop that may ship website orders.</li><li>Turn on <strong>Fulfil online orders</strong>.</li><li>Confirm its active state, complete address, and location inventory.</li></ol>
<h2>Set the order</h2>
<ol><li>Open <strong>Locations → Online fulfilment &amp; pickup</strong>.</li><li>Under <strong>Order</strong>, move eligible locations up or down.</li><li>Choose whether inactive locations should be skipped.</li><li>Save the fulfilment rules.</li></ol>
<p>A newly eligible location that is missing from an older saved list is appended so it is not silently ignored. Removed or ineligible IDs are ignored.</p>
<h2>Current routing limits</h2>
<ul><li><strong>Priority is the only active strategy.</strong> Nearest, most stock, and cheapest shipping are shown as planned, not usable choices.</li><li>One location must serve the whole order. StoreMink does not split one order across warehouses or parcels.</li><li>Online stock counts only locations enabled for online fulfilment. Dashboard and POS all-location stock can therefore be higher.</li><li>If no usable rule or eligible warehouse is available, the current flow can fall back to the main/default location instead of refusing every order. Treat that as a safety fallback, not a routing strategy.</li></ul>
<h2>Why a location was skipped</h2>
<p>Check that it is eligible, active when inactive locations are skipped, and has enough recorded on-hand stock for every tracked line. Then separately check available stock, which is on-hand minus active reservations, before packing or promising the order. Backorder and untracked products follow their own product rules.</p>$article$,
    'Choose StoreMink online fulfilment priority',
    'Configure StoreMink priority-only fulfilment routing, eligible locations, online stock, inactive-location behavior, fallback, and one-location limits.',
    5
  ),
  (
    'offer-and-manage-store-pickup',
    'Offer and manage store pickup',
    'Let shoppers collect from a shop, choose readiness and payment rules, prepare the order, and hand it over with the collection code.',
    $article$<p>Pickup lets a customer reserve online and collect from an eligible shop. It uses that shop's stock and keeps the website order connected to the counter handover.</p>
<h2>Turn pickup on</h2>
<ol><li>Open <strong>Locations</strong> and enable <strong>Sell here</strong> and <strong>Customer pickup</strong> for each collection shop.</li><li>Open <strong>Locations → Online fulfilment &amp; pickup</strong>.</li><li>Turn pickup on for the store.</li><li>Set the ready-in days and hold-for days.</li><li>Choose whether the customer may choose payment timing, must prepay, or must pay at collection.</li><li>Save the settings.</li></ol>
<p>Prepaid-only pickup needs an enabled online gateway. The pickup payment policy does not alter delivery-order payment choices.</p>
<h2>What checkout does</h2>
<p>The shopper chooses an eligible shop with enough available stock. StoreMink reserves the units at that location, but on-hand stock is not decremented until handover. This is why available stock can be lower than the physical on-hand number while pickups wait.</p>
<h2>Prepare the order</h2>
<ol><li>Open the POS <strong>Pickups</strong> queue at the collection shop.</li><li>Find the order and confirm its products, payment status, due amount, and promise.</li><li>Pack the items and mark the order ready.</li><li>Keep the parcel until the customer provides the collection code or QR code.</li></ol>
<h2>Take payment and hand over</h2>
<p>A prepaid order needs no new tender. A pay-at-store order shows the amount due; take an allowed counter tender and then complete handover. Pay at store is only the earlier promise, not the tender itself. Store credit must be attached to the correct customer and is used as a completed payment, not an unsecured deposit.</p>
<h2>Expiry and reminders</h2>
<p>The customer sees a calendar date rather than a live countdown. StoreMink has reminder and expiry workers, but actual timing depends on the production scheduler being deployed and healthy. Non-production environments can have no scheduler, so do not use staging timing as a customer promise.</p>
<h2>Important limits</h2>
<ul><li>A placed pickup cannot be discounted at handover because its invoice and GST base already exist.</li><li>Pickup is not split across shops.</li><li>Use the explicit acknowledgement if an exceptional handover must occur before Ready; the audit must show what happened.</li><li>A failed or uncertain online payment must be reconciled before taking money again.</li></ul>$article$,
    'Offer and manage StoreMink store pickup',
    'Configure StoreMink pickup locations, readiness, hold and payment policies, reserve stock, prepare orders, take collection payment, and hand over safely.',
    6
  ),
  (
    'set-shipping-charges-and-delivery-estimates',
    'Set shipping charges and delivery estimates',
    'Choose free, fixed, or live Shiprocket rates and control the delivery prices and dates customers see at checkout.',
    $article$<p>Shipping settings price delivery orders. Pickup and digital-only orders remain free and do not make a Shiprocket serviceability request.</p>
<p><strong>Controlled live verification required:</strong> Merchant-account Shiprocket rates have not yet completed the release checklist's controlled live run. Do not show or rely on them for customers until a test quote succeeds against the merchant's own connected account and the checkout result is checked in both StoreMink and Shiprocket.</p>
<h2>Open shipping settings</h2>
<ol><li>From the dashboard, open <strong>Settings → Shipping &amp; delivery</strong>.</li><li>Choose one checkout rate mode.</li><li>Enter the related charge and delivery estimate settings.</li><li>Save, then test a physical product with a real destination PIN code.</li></ol>
<h2>Free shipping</h2>
<p>Choose free shipping to charge ₹0 for every delivery order. Configure the manual minimum and maximum delivery days shown to the shopper.</p>
<h2>Fixed rate</h2>
<p>Enter one charge per order. The fixed fee does not change by destination, weight, or product. You can add an optional free-shipping threshold and a manual delivery estimate.</p>
<h2>Live Shiprocket rates</h2>
<p>Connect and enable Shiprocket first. StoreMink checks serviceability using the routed fulfilment location, destination PIN code, payment type, parcel weight, and dimensions. You can add handling days, add a fixed or percentage adjustment to carrier prices, and show the cheapest choice or up to five courier choices.</p>
<h2>Checkout verifies the choice again</h2>
<p>The browser quote is not trusted as the final amount. StoreMink re-quotes or validates shipping on the server when the order is placed and saves the chosen service, charge, and delivery promise with the order. A later settings or carrier-price change does not rewrite the placed order.</p>
<h2>Current limits</h2>
<p>StoreMink does not yet provide postal zones, weight or price tables, product-specific shipping profiles, split parcels, or multiple warehouses for one order. Fixed-rate shipping is one order-level charge. When product measurements are missing, the current Shiprocket parcel builder substitutes 500 g and 10 × 10 × 5 cm defaults; that can produce an inaccurate quote or booking. Enter the real weight and dimensions before enabling live rates.</p>$article$,
    'Set StoreMink shipping rates and estimates',
    'Configure free, fixed, or live Shiprocket delivery rates in StoreMink, free thresholds, handling days, adjustments, courier choices, and server re-quoting.',
    7
  ),
  (
    'connect-shiprocket-and-sync-warehouses',
    'Connect Shiprocket and sync warehouses',
    'Connect your own Shiprocket API user, sync eligible fulfilment locations, add the webhook, and pause or disconnect safely.',
    $article$<p>StoreMink connects to a Shiprocket account owned by your business. Shiprocket charges, COD settlement, carrier agreements, and account operations remain between your business and Shiprocket.</p>
<p><strong>Controlled live verification required:</strong> Merchant-account rates, booking, and authenticated webhooks have not yet completed the release checklist's controlled live run. Do not rely on the connection for a customer parcel until those checks succeed with the merchant's own account and the results are confirmed in both systems.</p>
<h2>Prepare the account and locations</h2>
<ul><li>Create a dedicated Shiprocket API user rather than using a shared personal password.</li><li>In StoreMink, complete the business contact phone under <strong>Settings → Taxes &amp; invoices</strong>.</li><li>Give every shipping location a complete Indian address, state, PIN code, and contact details.</li><li>Turn on <strong>Fulfil online orders</strong> only for locations that should become Shiprocket pickup warehouses.</li></ul>
<h2>Connect Shiprocket</h2>
<ol><li>Open <strong>Settings → Channels → Shiprocket</strong>.</li><li>Enter the API-user email and password.</li><li>Select <strong>Connect</strong>. StoreMink verifies the login before encrypting and saving it.</li><li>Select <strong>Sync warehouses</strong>.</li><li>Review which eligible locations synced and which were skipped for incomplete data.</li></ol>
<p>Re-syncing keeps the stable mapping for an existing location. A location without <strong>Fulfil online orders</strong> is not synced merely because it exists in StoreMink.</p>
<h2>Add the webhook</h2>
<ol><li>Copy the provider-neutral StoreMink webhook URL and token shown in Channels.</li><li>In Shiprocket, open its API webhook settings.</li><li>Paste the URL and token exactly.</li><li>If you rotate the token in StoreMink, update Shiprocket immediately because the earlier token stops authenticating callbacks.</li></ol>
<h2>Pause or disconnect</h2>
<p>Pausing stops new provider work while keeping credentials and mappings. Disconnecting removes the saved connection, but existing StoreMink shipment records remain. New booking and provider refresh stop until a valid connection is restored.</p>
<h2>Verification status</h2>
<p>The StoreMink integration includes automated provider, state, and response tests, but this release has not yet completed its live merchant test-account browser, booking, and webhook smoke run. Do not rely on it for a customer parcel until that controlled test succeeds in both StoreMink and Shiprocket.</p>$article$,
    'Connect Shiprocket to StoreMink',
    'Connect a Shiprocket API user to StoreMink, sync online fulfilment warehouses, configure its webhook, pause or disconnect, and understand verification status.',
    8
  ),
  (
    'pack-book-and-manage-a-shipment',
    'Pack, book, and manage a shipment',
    'Confirm parcel measurements, book through Shiprocket, retry a stopped stage safely, schedule pickup, print documents, or use another courier.',
    $article$<p>A delivery order is routed to one fulfilment location. Packing confirms the parcel StoreMink will send to a carrier; booking creates the provider shipment in resumable stages.</p>
<p><strong>Controlled live verification required:</strong> Do not book a customer parcel through a merchant Shiprocket account until a controlled test has completed order creation, AWB assignment, label generation, and any pickup or manifest steps the team will use, with the result checked in both StoreMink and Shiprocket.</p>
<h2>Before booking</h2>
<ol><li>Open the delivery order and confirm its assigned fulfilment location.</li><li>Check the delivery name, phone, address, state, and PIN code.</li><li>Confirm the packed weight and dimensions. Product measurements are copied into the order when it is placed, so later catalogue edits do not silently change this parcel.</li><li>Check the COD or prepaid amount and selected shipping service.</li></ol>
<p>The delivery phone can be corrected before Shiprocket creates provider identifiers. After a Shiprocket order, shipment, or AWB exists, change it through the provider's supported process rather than making StoreMink and the carrier disagree.</p>
<h2>Book with Shiprocket</h2>
<ol><li>Select <strong>Book with Shiprocket</strong>.</li><li>StoreMink first creates its local fulfilment record.</li><li>It then creates the Shiprocket order, assigns an AWB, and generates the label.</li><li>Download or print the label when available.</li><li>Schedule carrier pickup and generate the manifest when the shipment is ready.</li></ol>
<h2>If a stage fails</h2>
<p>Select the available retry action after reading the error. StoreMink saves each completed provider stage before continuing, so a retry resumes from the missing stage instead of intentionally creating a second Shiprocket order or AWB.</p>
<h2>Use another courier</h2>
<p>Choose the manual courier path when Shiprocket is not used. Enter the carrier, AWB or tracking reference, and tracking link accurately. StoreMink records and displays them but cannot fetch Shiprocket tracking or perform provider actions for a manual parcel.</p>
<h2>Current parcel limits</h2>
<p>One StoreMink order currently becomes one parcel from one location. Split parcels, multi-warehouse allocation, reverse labels, weight-dispute handling, and COD-remittance reconciliation are not built into the StoreMink shipment workflow.</p>$article$,
    'Pack and book StoreMink shipments',
    'Pack a StoreMink order, book resumable Shiprocket stages, assign AWB and label, schedule pickup, generate manifests, retry safely, or use a manual courier.',
    9
  ),
  (
    'track-deliveries-and-handle-ndr-or-rto',
    'Track deliveries and handle NDR or RTO',
    'Read courier tracking, refresh a parcel, respond to a non-delivery report, start return to origin, and cancel before pickup when allowed.',
    $article$<p>StoreMink turns carrier updates into stable shipment statuses and a customer-readable tracking history. Raw Shiprocket response data is not shown to shoppers.</p>
<p><strong>Controlled live verification required:</strong> Do not rely on webhook tracking, NDR, RTO, or shipment cancellation for customer operations until a controlled parcel has proved authenticated callbacks and status mapping with the merchant's own account. Until then, verify every status and action in Shiprocket or the carrier portal.</p>
<h2>Track a parcel</h2>
<ul><li>Open the order to see the carrier, AWB, tracking link, current parcel status, and scans.</li><li>Use refresh when a provider update appears delayed.</li><li>The authenticated webhook also sends updates to StoreMink. Repeated events are deduplicated and an older event cannot move a parcel backwards.</li></ul>
<h2>Non-delivery report</h2>
<p>An NDR means the carrier could not complete delivery and needs an allowed action. Review the reason and customer details, then choose the available Shiprocket action:</p>
<ul><li><strong>Reattempt:</strong> ask the carrier to try delivery again using the confirmed details.</li><li><strong>Return to origin:</strong> ask the carrier to return the parcel to the shipping location.</li></ul>
<p>Use only an action shown for the current provider state. StoreMink refuses an NDR action when the parcel is not actionable.</p>
<h2>Cancel a shipment</h2>
<p>A Shiprocket parcel can be cancelled through StoreMink only before the provider has moved it beyond the supported pre-pickup state. After that, use the provider's NDR or support process. Cancelling the parcel does not by itself cancel the commerce order, refund the customer, or restock goods.</p>
<h2>Return to origin is not a customer return</h2>
<p>RTO describes a delivery parcel coming back because delivery failed. A customer return is a separate order-return and refund workflow. Inspect and receive returned stock through the correct process rather than treating every RTO scan as sellable inventory.</p>
<h2>If tracking disagrees</h2>
<p>Compare StoreMink with the connected Shiprocket account and the carrier link. Refresh once, then contact support with the order reference, shipment ID, and AWB if the webhook or normalized status remains wrong. Do not share the Shiprocket password or webhook token.</p>$article$,
    'Track StoreMink deliveries and handle NDR or RTO',
    'Track StoreMink Shiprocket parcels, refresh scans, safely reattempt delivery, start RTO, cancel before pickup, and distinguish shipment from order status.',
    10
  ),
  (
    'refund-orders-and-understand-credit-notes',
    'Refund orders and understand credit notes',
    'Choose an eligible refund path, keep refunds separate from stock and status changes, and understand when a GST credit note is created.',
    $article$<p>Order cancellation, parcel cancellation, returned stock, refund settlement, and a GST credit note are connected records, but they are not the same action. Complete each required step and verify its own result.</p>
<p><strong>Before the first live Razorpay refund:</strong> use a small controlled order in the merchant's own account, confirm the provider result, StoreMink reconciliation, and final refund state, and keep the reference. Until that test succeeds, do not rely on the automated path for a customer deadline; complete the refund once in Razorpay and record the same movement manually in StoreMink.</p>
<h2>Choose the refund amount and destination</h2>
<ol><li>Open the order and review the original payments and earlier refunds.</li><li>Choose a full or partial amount within the remaining refundable value.</li><li>Choose an eligible destination: original Razorpay payment, a manual refund already completed elsewhere, or customer store credit.</li><li>For a manual refund, enter the external reference.</li><li>Submit once and wait for the result.</li></ol>
<p>A pending refund counts against the remaining refundable amount. If Razorpay times out, leave it pending for reconciliation and do not retry blindly.</p>
<h2>Stock is separate</h2>
<p>Refunding money does not prove that sellable goods returned to a location. Restock through cancellation or receiving only when the units are actually eligible. If cancellation or failed-payment cleanup releases credit that this order previously spent, StoreMink reinstates that spent value through its protected ledger. That cleanup is separate from choosing store credit as an explicit refund destination for new customer value. A normal refund does not silently convert to or add store credit.</p>
<h2>GST credit notes</h2>
<p>A completed refund on a taxed order can create a consecutive credit note tied to the original invoice and refund. It reverses the relevant taxable value. For POS orders with saved supplier and place-of-supply state facts, StoreMink can derive CGST/SGST or IGST treatment from those saved states. Website checkout does not currently preserve the same split facts, so do not assume a website-order credit note reproduces an original split. A pending or failed refund does not consume a final credit-note number.</p>
<p>One partial refund can produce a partial credit note. The document uses saved transaction amounts rather than today's product price or tax class, but the GST split limitation above still applies. Review StoreMink's GST document output with the business's accountant or tax adviser.</p>
<h2>Important refund rules</h2>
<ul><li>An original online-card refund goes through Razorpay, not the cash drawer.</li><li>A manual record does not move money; use it only after the external refund happened.</li><li>Store credit belongs to the identified customer in this store and is a payment, not a discount.</li><li>Do not promise completion until the refund status is settled.</li></ul>$article$,
    'Refund StoreMink orders and understand credit notes',
    'Refund StoreMink orders through Razorpay, manual methods, or store credit, keep stock separate, and understand partial GST credit notes.',
    11
  ),
  (
    'troubleshoot-orders-fulfilment-and-shipping',
    'Troubleshoot orders, fulfilment, and shipping',
    'Fix missing orders, wrong location scope, routing, pickup, rates, Shiprocket warehouse, booking, tracking, and refund problems safely.',
    $article$<p>Start with the StoreMink order reference and read its current payment, location, fulfilment, parcel, and refund states. Avoid changing several settings at once; identify which stage is blocked first.</p>
<p><strong>Controlled live verification required:</strong> Merchant-account Shiprocket rates, booking, and authenticated webhooks have not yet completed the controlled live run. Do not rely on them for customers until that test succeeds; cross-check every pilot quote, parcel, and callback in Shiprocket.</p>
<h2>An order is missing</h2>
<ul><li>Check the Website, POS, and All tabs that your plan provides.</li><li>Remove narrow search, date, status, payment, method, or channel filters.</li><li>Ask a superadmin to check the staff member's assigned locations and Orders permission.</li><li>Remember that a pending checkout can appear operationally without counting as recognized sales.</li></ul>
<h2>The wrong location was chosen</h2>
<p>Check <strong>Fulfil online orders</strong>, active state, priority order, recorded on-hand stock, and the skip-inactive setting. The current resolver does not subtract reservations, so verify available stock separately. Only priority routing is active. A whole order must fit one location, and the fallback can use the main/default location when the configured list cannot serve it.</p>
<h2>Pickup is unavailable</h2>
<p>Check that the store offers pickup, the shop is active, and both <strong>Sell here</strong> and <strong>Customer pickup</strong> are on. Confirm location stock and the pickup payment policy. Prepaid-only pickup needs Razorpay enabled.</p>
<h2>A shipping rate is missing</h2>
<ul><li>For fixed or free shipping, check the saved mode and delivery estimate.</li><li>For live rates, confirm Shiprocket is connected and enabled, the warehouse is synced, and the PIN codes are serviceable.</li><li>Enter accurate product weight and dimensions. Missing measurements use the current 500 g and 10 × 10 × 5 cm defaults, which can misquote the parcel rather than block it.</li><li>Pickup and digital-only orders intentionally return ₹0 without a live carrier quote.</li></ul>
<h2>Warehouse sync skipped a location</h2>
<p>Turn on <strong>Fulfil online orders</strong> and complete its Indian address, state, PIN code, contact phone, and required business contact. Correct the data and sync again. Do not create a duplicate location to work around an address error.</p>
<h2>Booking stopped halfway</h2>
<p>Read the last completed provider stage and use Retry. StoreMink resumes from saved Shiprocket order, shipment, or AWB identifiers. Do not create a second parcel manually in Shiprocket unless the first attempt is confirmed absent.</p>
<h2>Tracking or NDR is wrong</h2>
<p>Refresh once and compare the AWB in Shiprocket. Use reattempt or RTO only when the current NDR permits it. A carrier cancellation or RTO does not automatically cancel the StoreMink order, refund money, or restock units.</p>
<h2>Know the current limits</h2>
<p>Postal zones, weight/price tables, product shipping profiles, split warehouses or parcels, reverse shipping labels, weight disputes, and COD-remittance reconciliation are not built. Live Shiprocket merchant-account booking and webhook verification is also still pending, so do not rely on the connection for customer parcels until the controlled test succeeds.</p>
<h2>Contact support safely</h2>
<p>Send the order reference, shipment ID, AWB, safe provider error, and redacted screenshot. Never send payment API keys, Shiprocket passwords, webhook tokens, OTPs, card details, or unnecessary customer data.</p>$article$,
    'Troubleshoot StoreMink orders and shipping',
    'Troubleshoot StoreMink order visibility, location routing, pickup, shipping rates, Shiprocket warehouse sync, booking, tracking, NDR, RTO, and refunds.',
    12
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

-- Locations moved out of the POS workspace. Replace only the exact earlier
-- wording, and only while the new six-capability wording is absent.
UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        '<li>The POS workspace now shows Overview, Settings, Staff, Devices, and Locations.</li>',
        '<li>The Point of Sale workspace now shows its POS tools. Open <strong>Locations</strong> from the top-level dashboard navigation to manage shops and warehouses.</li>'
      ),
      '<ul><li><strong>Sell here</strong> allows StoreMink POS at that location.</li><li><strong>Customer pickup</strong> lets shoppers choose the shop at checkout. Sell here must also be on because somebody at the shop has to hand the goods over.</li><li><strong>Accept returns</strong> allows eligible website orders to be returned at this shop when the store-wide returns policy also allows it.</li><li><strong>Fulfil online orders</strong> lets the location supply delivery orders. StoreMink will not let you turn off the last location that can fulfil online orders.</li></ul>',
      '<ul><li><strong>Sell here</strong> allows StoreMink POS at that location.</li><li><strong>Fulfil online orders</strong> makes the location eligible to supply website delivery orders. StoreMink will not let you turn off the last online-fulfilment location.</li><li><strong>Customer pickup</strong> lets shoppers choose the shop at checkout and depends on Sell here.</li><li><strong>Accept returns</strong> allows eligible website orders to be returned at this shop and depends on Sell here.</li><li><strong>Receive stock</strong> allows inbound receiving at the location.</li><li><strong>Transfer stock</strong> allows stock transfers involving the location.</li></ul>'
    ),
    updated_at = now()
WHERE slug = 'enable-pos-and-set-up-locations'
  AND status = 'published'
  AND body NOT LIKE '%<strong>Receive stock</strong> allows inbound receiving at the location.%';

-- Pro authorises at most five active browser devices per POS location. Add the
-- explicit replacement flow without rewriting the rest of the guide.
UPDATE public.help_articles
SET body = replace(
      body,
      '<h2>Revoke a device</h2>',
      '<h2>When the location already has five devices</h2><p>Pro allows up to <strong>five authorised devices per location</strong>. StoreMink does not silently remove one. When the limit is reached, the owner chooses an existing device to retire before authorising the current browser. The least recently used devices are listed first to help with the decision, but the choice remains with the owner.</p><h2>Revoke a device</h2>'
    ),
    updated_at = now()
WHERE slug = 'authorize-and-manage-pos-devices'
  AND status = 'published'
  AND body NOT LIKE '%five authorised devices per location%';

-- Expand the held-sale paragraph to match the implemented cap, fields,
-- repricing, single-till claim, deleted-line notice, discard and expiry rules.
UPDATE public.help_articles
SET body = replace(
      body,
      '<p>Select <strong>Hold sale</strong> to clear the counter for the next customer. A held sale keeps the selected products, quantities, discount, and GSTIN for seven days and is visible to other tills at the same location. It does <strong>not</strong> reserve stock or freeze prices. When resumed, the current price and live stock apply.</p>',
      '<p>Select <strong>Hold sale</strong> to clear the counter for the next customer. A held sale keeps the selected products, quantities, discount, attached customer, GSTIN, and note. It is shared with other tills at the same location, but one till can claim a particular held sale at a time. A location can keep up to <strong>20 held sales</strong>. Holding does <strong>not</strong> reserve stock or freeze prices, so StoreMink uses current prices and live stock when the sale resumes. Products or variants deleted meanwhile are dropped with a notice. Finish or discard a held sale when it is no longer needed; unclaimed holds expire after seven days.</p>'
    ),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale'
  AND status = 'published'
  AND body NOT LIKE '%20 held sales%';

-- GA4 and Meta Pixel shipped after the original Analytics overview. Remove the
-- one stale release sentence while preserving the rest of the guide.
UPDATE public.help_articles
SET body = replace(
      body,
      'Their setup guides remain unavailable to merchants until those connections are released.',
      'Their setup guides are available to eligible merchants, and storefront tracking starts only after the visitor allows the matching consent category.'
    ),
    updated_at = now()
WHERE slug = 'understand-analytics-dashboard'
  AND status = 'published'
  AND body LIKE '%Their setup guides remain unavailable to merchants until those connections are released.%';

-- The older counter-return guide was written against a Returns settings group
-- that is not rendered in the merchant dashboard. Keep the location capability
-- accurate, make the store-wide prerequisite explicit, and remove the
-- unsupported POS store-credit return destination.
UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old$<p>Turn on <strong>Accept returns</strong>, enable <strong>Accept online returns in your shops</strong>, and give this location the <strong>Accept returns</strong> capability. The manager can then search an eligible online order. It appears as <strong>Bought elsewhere</strong> so the source is clear.</p>$old$,
        $new$<p>Online returns at a shop work only when the store's existing in-store-return policy is already active and the location has the <strong>Accept returns</strong> capability. The location capability is available under <strong>Locations</strong>, but the Returns settings group that controls the store-wide policy is not currently rendered in the merchant dashboard. If the workflow is unavailable, do not promise a counter return or look for a hidden switch; contact StoreMink support to confirm the account's current configuration. When the prerequisites are already active, a manager can search an eligible online order. It appears as <strong>Bought elsewhere</strong> so the source is clear.</p>$new$
      ),
      $old$<ul><li>A StoreMink online card payment goes back through the original gateway. The till does not offer cash for it.</li><li>A COD or counter-paid order may offer the allowed counter methods.</li><li>Store credit is offered only when a customer account is attached.</li><li>A cash refund reduces the current drawer's expected cash.</li></ul>$old$,
      $new$<ul><li>A StoreMink online card payment goes back through the original gateway. The till does not offer cash for it.</li><li>A COD or counter-paid order may offer only the supported counter refund methods shown by the till.</li><li>The POS return flow does not offer store credit as a refund destination.</li><li>A cash refund reduces the current drawer's expected cash.</li></ul>$new$
    ),
    updated_at = now()
WHERE slug = 'take-returns-at-the-counter'
  AND status = 'published'
  AND (body NOT LIKE '%The POS return flow does not offer store credit as a refund destination.%'
       OR body NOT LIKE '%the Returns settings group that controls the store-wide policy is not currently rendered in the merchant dashboard.%');

-- Store credit is an explicit destination only in dashboard workflows that
-- offer it. Separately, cancellation/failure cleanup may reinstate credit that
-- the same order spent. Also stop pointing merchants to the hidden Returns UI.
UPDATE public.help_articles
SET body = replace(
      replace(
        replace(
          body,
          $old$<p>Choose <strong>Store credit</strong> when the order belongs to a customer account. The balance belongs to that customer at that store and appears at online checkout and the POS tender panel. Store credit is a payment balance, not a discount: the order total and GST do not change when it is spent.</p>$old$,
          $new$<p>Choose <strong>Store credit</strong> only in a supported dashboard refund or cancellation workflow when StoreMink explicitly offers it and the order belongs to a customer account. The balance belongs to that customer at that store and appears at online checkout and the POS tender panel. Store credit is a payment balance, not a discount: the order total and GST do not change when it is spent. The POS return flow does not offer store credit as a refund destination.</p>$new$
        ),
        $old$<p>If an order that used store credit is cancelled or correctly refunded, StoreMink restores the eligible credit exactly once and records the reason in the credit ledger.</p>$old$,
        $new$<p>If cancellation or failed-payment cleanup releases store credit that this order previously spent, StoreMink reinstates that spent value exactly once and records the reason in the credit ledger. This is reinstatement of the original tender, not a new store-credit refund destination.</p>$new$
      ),
      $old$<p>Exchanges begin from the customer's delivered-order return request when the store has both <strong>Accept returns</strong> and <strong>Offer exchanges</strong> enabled. The customer can choose another in-stock variant. StoreMink supports an even or cheaper replacement; a more expensive replacement is refused and the customer should place a new order.</p>$old$,
      $new$<p>Exchange requests depend on an existing store-wide return and exchange policy. The Returns settings group that controls those store-wide options is not currently rendered in the merchant dashboard, so merchants cannot turn the options on there. If the capability is not already active, do not promise customer self-service exchanges; contact StoreMink support to confirm the account's current configuration. When it is active, the customer can choose another in-stock variant from the delivered-order return request. StoreMink supports an even or cheaper replacement; a more expensive replacement is refused and the customer should place a new order.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'refunds-store-credit-exchanges-and-credit-notes'
  AND status = 'published'
  AND (body NOT LIKE '%This is reinstatement of the original tender, not a new store-credit refund destination.%'
       OR body NOT LIKE '%The Returns settings group that controls those store-wide options is not currently rendered in the merchant dashboard%'
       OR body NOT LIKE '%The POS return flow does not offer store credit as a refund destination.%');

DO $migration$
DECLARE
  category_count integer;
  article_count integer;
  repaired_count integer;
  shiprocket_warning_count integer;
  store_credit_guard_count integer;
BEGIN
  SELECT count(*) INTO category_count
  FROM public.help_categories
  WHERE slug = 'orders';

  IF category_count <> 1 THEN
    RAISE EXCEPTION '20260826_0023 expected one orders Help Centre category, found %', category_count;
  END IF;

  SELECT count(*) INTO article_count
  FROM public.help_articles article
  INNER JOIN public.help_categories category ON category.id = article.category_id
  WHERE category.slug = 'orders'
    AND article.status = 'published'
    AND article.slug IN (
      'manage-website-and-pos-orders',
      'set-your-order-cancellation-policy',
      'review-and-resolve-cancellation-requests',
      'set-up-locations-and-capabilities',
      'choose-online-fulfilment-priority',
      'offer-and-manage-store-pickup',
      'set-shipping-charges-and-delivery-estimates',
      'connect-shiprocket-and-sync-warehouses',
      'pack-book-and-manage-a-shipment',
      'track-deliveries-and-handle-ndr-or-rto',
      'refund-orders-and-understand-credit-notes',
      'troubleshoot-orders-fulfilment-and-shipping'
    );

  IF article_count <> 12 THEN
    RAISE EXCEPTION '20260826_0023 expected 12 published order and shipping guides, found %', article_count;
  END IF;

  SELECT count(*) INTO repaired_count
  FROM public.help_articles
  WHERE status = 'published'
    AND ((slug = 'enable-pos-and-set-up-locations'
         AND body LIKE '%<strong>Receive stock</strong> allows inbound receiving at the location.%'
         AND body LIKE '%top-level dashboard navigation%')
     OR (slug = 'authorize-and-manage-pos-devices'
         AND body LIKE '%five authorised devices per location%')
     OR (slug = 'process-an-in-store-sale'
         AND body LIKE '%20 held sales%')
     OR (slug = 'understand-analytics-dashboard'
         AND body LIKE '%Their setup guides are available to eligible merchants, and storefront tracking starts only after the visitor allows the matching consent category.%')
     OR (slug = 'take-returns-at-the-counter'
         AND body LIKE '%the Returns settings group that controls the store-wide policy is not currently rendered in the merchant dashboard.%'
         AND body LIKE '%The POS return flow does not offer store credit as a refund destination.%'
         AND body NOT LIKE '%Turn on <strong>Accept returns</strong>, enable <strong>Accept online returns in your shops</strong>%')
     OR (slug = 'refunds-store-credit-exchanges-and-credit-notes'
         AND body LIKE '%The Returns settings group that controls those store-wide options is not currently rendered in the merchant dashboard%'
         AND body LIKE '%The POS return flow does not offer store credit as a refund destination.%'
         AND body LIKE '%This is reinstatement of the original tender, not a new store-credit refund destination.%'
         AND body NOT LIKE '%cancelled or correctly refunded%'));

  IF repaired_count <> 6 THEN
    RAISE EXCEPTION '20260826_0023 expected 6 repaired POS/Analytics guides, found %', repaired_count;
  END IF;

  SELECT count(*) INTO shiprocket_warning_count
  FROM public.help_articles
  WHERE status = 'published'
    AND slug IN (
      'set-shipping-charges-and-delivery-estimates',
      'connect-shiprocket-and-sync-warehouses',
      'pack-book-and-manage-a-shipment',
      'track-deliveries-and-handle-ndr-or-rto',
      'troubleshoot-orders-fulfilment-and-shipping'
    )
    AND body LIKE '%<strong>Controlled live verification required:</strong>%';

  IF shiprocket_warning_count <> 5 THEN
    RAISE EXCEPTION '20260826_0023 expected controlled-live warnings in 5 Shiprocket-dependent guides, found %', shiprocket_warning_count;
  END IF;

  SELECT count(*) INTO store_credit_guard_count
  FROM public.help_articles
  WHERE status = 'published'
    AND ((slug = 'set-your-order-cancellation-policy'
         AND body LIKE '%This is cancellation cleanup, not choosing store credit as a new refund destination.%')
      OR (slug = 'refund-orders-and-understand-credit-notes'
          AND body LIKE '%A normal refund does not silently convert to or add store credit.%'));

  IF store_credit_guard_count <> 2 THEN
    RAISE EXCEPTION '20260826_0023 expected narrowed store-credit wording in 2 order guides, found %', store_credit_guard_count;
  END IF;
END
$migration$;
