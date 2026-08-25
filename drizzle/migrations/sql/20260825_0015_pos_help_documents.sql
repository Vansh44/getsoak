-- Publish the complete Point of Sale guide set in the public Help Centre.
-- The articles describe shipped behaviour only. They stay database-backed so
-- platform operators can refine the wording later without a code deploy.

-- Put Point of Sale directly after Products & inventory. Guard the shift so a
-- manually pre-created category does not move the remaining grid twice.
UPDATE public.help_categories
SET position = position + 1
WHERE position >= 4
  AND NOT EXISTS (
    SELECT 1
    FROM public.help_categories
    WHERE slug = 'point-of-sale'
  );

INSERT INTO public.help_categories AS existing
  (slug, title, description, icon, position)
VALUES
  (
    'point-of-sale',
    'Point of Sale',
    'Set up your register, sell in store, manage tills, stock, pickups, shifts, returns, and receipts.',
    'ScanLine',
    4
  )
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  position = EXCLUDED.position,
  updated_at = now();

WITH pos_category AS (
  SELECT id
  FROM public.help_categories
  WHERE slug = 'point-of-sale'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT pos_category.id,
       document.slug,
       document.title,
       document.excerpt,
       document.body,
       'published',
       document.seo_title,
       document.seo_description,
       document.position,
       now()
FROM pos_category
CROSS JOIN (VALUES
  (
    'pos-overview-and-requirements',
    'Point of Sale overview and requirements',
    'Start here to understand what StoreMink POS does, what you need, which devices work, and how online and in-store selling stay connected.',
    $article$<p>StoreMink Point of Sale is the in-store register for your StoreMink shop. It uses the same products, customers, orders, tax settings, and location stock as your website, so you do not have to keep two separate systems in sync.</p>
<h2>What you can do with StoreMink POS</h2>
<ul><li>Scan, search, or tap products and complete an in-store checkout.</li><li>Take cash, record payments from your own card machine or UPI app, charge a connected online gateway, use store credit, or split a payment.</li><li>Work with stock separately at each shop, including receiving, counting, correcting, and transferring units.</li><li>Prepare online pickup orders, take payment at collection, record deposits, and hand parcels over with a collection code.</li><li>Accept eligible returns at the counter, restock at the receiving shop, and refund using an allowed method.</li><li>Open and close cash shifts, record cash movements, and review frozen Z-reports.</li><li>Print GST-ready receipts, email a receipt, and reprint an earlier sale.</li></ul>
<h2>What you need</h2>
<ul><li><strong>StoreMink Pro:</strong> Point of Sale is included in Pro. Two locations are included; additional active locations are billed through your subscription.</li><li><strong>An active selling location:</strong> the location must be active and have <strong>Sell here</strong> enabled.</li><li><strong>A modern browser:</strong> use a desktop, laptop, tablet, or phone. StoreMink does not require a proprietary terminal.</li><li><strong>An internet connection:</strong> the catalogue is cached for fast search, but completing a sale, payment, return, stock movement, or pickup needs the server.</li><li><strong>An authorised device for staff:</strong> cashiers and managers can sell only from a browser the owner has authorised.</li></ul>
<h2>Where to open the register</h2>
<p>Open <strong>https://your-store-domain/pos</strong>. On a StoreMink subdomain this is <strong>https://your-store.storemink.com/pos</strong>. The public site at pos.storemink.com explains the product; it is not a merchant register.</p>
<h2>Choose the next guide</h2>
<ul><li><a href="/help/point-of-sale/enable-pos-and-set-up-locations">Enable POS and set up locations</a></li><li><a href="/help/point-of-sale/process-an-in-store-sale">Process an in-store sale</a></li><li><a href="/help/point-of-sale/take-payments-and-split-tenders">Take payments and split tenders</a></li><li><a href="/help/point-of-sale/prepare-and-hand-over-pickup-orders">Prepare and hand over pickup orders</a></li><li><a href="/help/point-of-sale/take-returns-at-the-counter">Take returns at the counter</a></li></ul>$article$,
    'StoreMink POS overview and requirements',
    'Learn what StoreMink Point of Sale includes, which devices work, plan and location requirements, internet needs, and where to open the register.',
    1
  ),
  (
    'enable-pos-and-set-up-locations',
    'Enable POS and set up locations',
    'Turn on Point of Sale, prepare your first shop, choose location capabilities, and understand included and additional locations.',
    $article$<p>Point of Sale is enabled once for the store, but stock, staff access, receipts, pickups, and returns are controlled by location.</p>
<h2>Enable Point of Sale</h2>
<ol><li>From the StoreMink dashboard, select <strong>Point of Sale</strong>.</li><li>If the store is not on Pro, select <strong>Upgrade to Pro</strong> and complete the plan change.</li><li>Select <strong>Enable POS</strong>.</li><li>The POS workspace now shows Overview, Settings, Staff, Devices, and Locations.</li></ol>
<p>Turning POS off later stops new register work but does not delete locations, staff, stock, receipts, or earlier sales.</p>
<h2>Prepare a selling location</h2>
<ol><li>Open <strong>Locations</strong>.</li><li>Create a shop or open an existing location.</li><li>Add the location name, type, complete address, GSTIN, GST state code, and receipt prefix as needed.</li><li>Make sure the location is active.</li><li>Turn on <strong>Sell here</strong>.</li><li>Save the location.</li></ol>
<h2>Choose location capabilities</h2>
<ul><li><strong>Sell here</strong> allows StoreMink POS at that location.</li><li><strong>Customer pickup</strong> lets shoppers choose the shop at checkout. Sell here must also be on because somebody at the shop has to hand the goods over.</li><li><strong>Accept returns</strong> allows eligible website orders to be returned at this shop when the store-wide returns policy also allows it.</li><li><strong>Fulfil online orders</strong> lets the location supply delivery orders. StoreMink will not let you turn off the last location that can fulfil online orders.</li></ul>
<h2>Included and additional locations</h2>
<p>Pro includes two locations. When you reach the allowance, the Locations page shows the current price for another location. Additional locations require an active subscription payment method and enough authorised recurring-payment capacity. Releasing an unused paid location takes effect at the end of the billing cycle; StoreMink never silently deletes a shop.</p>
<h2>Location access for dashboard staff</h2>
<p>An admin with no assigned locations can see the whole store. An admin assigned to particular locations sees only those locations' orders and stock. Typing another location into a URL does not widen access.</p>$article$,
    'Enable StoreMink POS and set up locations',
    'Enable StoreMink Point of Sale, configure selling locations and capabilities, and understand included locations, add-ons, and staff location access.',
    2
  ),
  (
    'set-up-pos-staff-and-pins',
    'Set up POS staff, roles, and PINs',
    'Invite cashiers and managers, understand their access, complete registration, use PIN sign-in, and remove access safely.',
    $article$<p>Each person should use their own POS account and PIN. Shared PINs make it impossible to know who sold, discounted, moved stock, or handled cash.</p>
<h2>Invite a staff member</h2>
<ol><li>Open <strong>Point of Sale → Staff</strong>.</li><li>Select <strong>Invite staff</strong>.</li><li>Enter the person's name and email.</li><li>Choose <strong>Cashier</strong> or <strong>Manager</strong>.</li><li>Choose the locations where they may work.</li><li>Send the invitation.</li></ol>
<p>The owner never creates or sees the staff PIN. The invitation link is sent to the staff member.</p>
<h2>Complete staff registration</h2>
<ol><li>Open the invitation link from the email.</li><li>Create a password.</li><li>Verify the mobile number with the one-time code.</li><li>Create and confirm the private 8-digit PIN.</li><li>Open the store's <strong>/pos</strong> address and sign in.</li></ol>
<p>The invitation is single-use. If it has expired or was already used, the owner can send a new invitation.</p>
<h2>Cashier and manager access</h2>
<ul><li><strong>Cashiers</strong> can sell, search sales, reprint receipts, work the pickup queue, mark orders ready, take collection payment, and sell into an open drawer.</li><li><strong>Managers</strong> can also adjust and transfer stock, take returns, manage the cash drawer, and edit the register layout.</li><li><strong>Owners</strong> control POS settings, invite staff, and grant lasting device trust. Discount access still follows the store's discount policy.</li></ul>
<h2>Sign in with a PIN or password</h2>
<p>Staff can sign in with email and PIN for a quick counter login, or with email and password. The register auto-locks after the configured period and asks for the PIN again. Auto-lock applies on every POS screen, including Stock, Returns, Pickups, Sales, and Drawer.</p>
<h2>Forgotten credentials and removed access</h2>
<p>Use <strong>Forgot PIN or password?</strong> on the POS login page. For safety, the page shows the same message whether or not an email exists. The reset link is single-use and expires after one hour. Deactivating a staff member ends their POS access on the next request.</p>$article$,
    'Set up StoreMink POS staff, roles, and PINs',
    'Invite StoreMink POS cashiers and managers, complete staff registration, understand permissions, sign in with a PIN, and remove access.',
    3
  ),
  (
    'authorize-and-manage-pos-devices',
    'Authorise and manage POS devices',
    'Authorise a desktop, tablet, or phone as a till, use a pairing code, revoke access, and respond to a copied device session.',
    $article$<p>StoreMink treats each authorised browser as a till. Staff cannot take money from a new browser until the store owner has trusted it. Owners are not blocked by the device check, but should still manage shared counter devices carefully.</p>
<h2>Authorise the browser you are using</h2>
<ol><li>Open the store's <strong>/pos</strong> address on the counter device.</li><li>Sign in as the store owner.</li><li>Select <strong>Authorise this device</strong>.</li><li>Give the till a clear name, such as <strong>Bandra front counter</strong>.</li><li>Staff can now sign in on that browser.</li></ol>
<h2>Authorise with a pairing code</h2>
<ol><li>On the dashboard, open <strong>Point of Sale → Devices</strong>.</li><li>Generate a pairing code.</li><li>On the till, enter the code at the device prompt.</li></ol>
<p>The code can be used once and expires after 10 minutes. Generating the code grants trust, so only the store owner can do it. A staff member may redeem a valid code on the device.</p>
<h2>Revoke a device</h2>
<ol><li>Open <strong>Point of Sale → Devices</strong>.</li><li>Find the browser by its device name and location.</li><li>Select <strong>Revoke</strong>.</li></ol>
<p>Revocation removes trust immediately. A delegated POS admin can revoke a suspicious device because revocation only takes access away, but cannot authorise a new one.</p>
<h2>If a device session is copied</h2>
<p>StoreMink rotates a security value when a device is used. If the same device cookie is copied into another browser, the mismatch revokes the device and records a clone-detected security event. Re-authorise the genuine till only after checking who had access to the browser.</p>
<h2>Good device practice</h2>
<ul><li>Use a separate browser profile for each physical till.</li><li>Name devices by shop and counter rather than by a person's name.</li><li>Revoke lost, sold, or shared devices immediately.</li><li>Do not copy browser data between tills.</li><li>Keep the operating system and browser updated.</li></ul>$article$,
    'Authorise and manage StoreMink POS devices',
    'Learn how to authorise a StoreMink till, use a pairing code, revoke a POS device, and respond to copied browser sessions.',
    4
  ),
  (
    'configure-pos-register-settings',
    'Configure POS register settings',
    'Choose auto-lock, price override, discount approval, open-shift, and cash-variance rules for every register.',
    $article$<p>POS Settings control how the register behaves for staff. Open <strong>Point of Sale → Settings</strong>. Only people with permission to manage POS can change these rules.</p>
<h2>Auto-lock the register</h2>
<p><strong>Auto-lock the register after</strong> is the number of inactive minutes before the register asks for the operator's PIN again. The default is 10 minutes. Choose a short period for an open counter and a longer period only when the device is physically controlled.</p>
<h2>Control price changes</h2>
<p>Turn <strong>Allow price overrides at the register</strong> off when listed prices must always be used. This setting stops everybody, including the owner, from changing a line price during a sale.</p>
<h2>Control discounts</h2>
<ul><li><strong>Only the owner can give discounts</strong> is on by default. Cashiers and managers then cannot add an order discount, mark down a line, or reduce a line price.</li><li>If you turn owner-only discounts off, set the percentage a cashier may give without approval.</li><li>Keep <strong>Require a manager's PIN for large discounts</strong> on when a cashier must get approval above that percentage.</li><li>A 0% limit means every cashier discount needs approval; it does not stop ordinary full-price sales.</li></ul>
<h2>Require an open shift</h2>
<p>Turn <strong>Require an open shift to sell</strong> on when every counter payment must belong to a drawer shift. With it on, staff must open the drawer before a sale, deposit, or unpaid pickup collection. A prepaid pickup can still be handed over because no money enters the drawer.</p>
<h2>Set the cash variance tolerance</h2>
<p>The variance tolerance is the number of rupees a closing count may differ from expected cash before StoreMink flags it as over or short. Set it to match your cash-handling policy. The variance is still recorded even when it falls inside the tolerance.</p>
<h2>Save and explain the rules</h2>
<p>Tell staff when you change a policy. A stricter shift or discount setting can change what they are allowed to do on the very next sale.</p>$article$,
    'Configure StoreMink POS register settings',
    'Configure POS auto-lock, price overrides, owner-only discounts, manager approval limits, required shifts, and cash variance tolerance.',
    5
  ),
  (
    'customize-register-and-scan-products',
    'Customise the register and scan products',
    'Arrange the quick product grid, search the full catalogue, scan with hardware or a phone camera, and understand stock refreshes.',
    $article$<p>The Sell screen is designed for quick taps and scans. The product grid can be arranged for each location without hiding the rest of the catalogue.</p>
<h2>Edit the quick product layout</h2>
<ol><li>Open <strong>Sell</strong> as a manager or owner.</li><li>Select <strong>Edit layout</strong>.</li><li>Drag commonly sold products into the grid.</li><li>Arrange them in the order that is easiest for the counter.</li><li>Save the layout.</li></ol>
<p>A cashier does not see Edit layout. A product left out of the quick grid is still available through search or barcode scan. If a location has no saved layout, the register shows the whole catalogue.</p>
<h2>Search for a product</h2>
<p>Select the search box and enter a product name, SKU, or barcode. Search uses the catalogue cached on the device, so results appear quickly even on a slow connection. If a product was created after the last sync, StoreMink asks the server before reporting no match.</p>
<h2>Use a hardware barcode scanner</h2>
<p>Connect a scanner that behaves like a keyboard. Scan a barcode from anywhere on the Sell screen. On a tablet, the scan still works when the search field is not focused, and it will not re-add a product tile that was tapped just before the scan.</p>
<h2>Use the phone or tablet camera</h2>
<ol><li>Select the camera scanner on the Sell screen.</li><li>Allow camera access in the browser.</li><li>Place one barcode clearly inside the frame.</li><li>Close the camera when the item is added.</li></ol>
<h2>Understand unavailable products</h2>
<p>Tracked products with no available stock move to the end of the grid and cannot be added. Restocking returns them to their saved position. Product, price, publication, variant, and stock changes sync in the background. The screen catches up when the tab becomes visible or the network returns.</p>
<h2>The cache is not an offline till</h2>
<p>The cache makes browsing and searching resilient, but it is never the final authority for price or stock. StoreMink checks the live product and shelf again when the sale is completed.</p>$article$,
    'Customise the StoreMink POS register and scan products',
    'Arrange the POS product grid, search products, scan barcodes with hardware or a camera, and understand catalogue and stock syncing.',
    6
  ),
  (
    'process-an-in-store-sale',
    'Process an in-store sale',
    'Add products, attach or create a customer, enter a GSTIN, hold a cart, take payment, and finish a sale safely.',
    $article$<p>Use the Sell screen for an ordinary counter checkout. StoreMink checks the live price, stock, customer, approval, and payment before it writes the sale.</p>
<h2>Add products</h2>
<ol><li>Open <strong>Sell</strong>.</li><li>Tap a product, scan its barcode, or search by name, SKU, or barcode.</li><li>Change the quantity in the cart if needed.</li><li>Review the subtotal, discount, tax, and total.</li></ol>
<h2>Attach an existing customer</h2>
<ol><li>Open <strong>Customer</strong> from the cart.</li><li>Search by name, mobile number, or email.</li><li>Select the correct customer.</li></ol>
<p>Attaching the customer puts the receipt in their in-store order history and makes their store-credit balance available.</p>
<h2>Add a new walk-in customer</h2>
<p>If search finds nobody, select <strong>Add as a new customer</strong>. Enter a name and mobile number; email is optional. The new customer is attached immediately. If that person later signs up online using the same mobile number, StoreMink can connect the earlier in-store history and store credit to the new account.</p>
<h2>Add a business GSTIN</h2>
<p>Enter the buyer's GSTIN when it is needed on the receipt. StoreMink validates the format, changes it to uppercase, and prints it even when no customer account is attached.</p>
<h2>Hold a sale</h2>
<p>Select <strong>Hold sale</strong> to clear the counter for the next customer. A held sale keeps the selected products, quantities, discount, and GSTIN for seven days and is visible to other tills at the same location. It does <strong>not</strong> reserve stock or freeze prices. When resumed, the current price and live stock apply.</p>
<h2>Take payment and complete</h2>
<ol><li>Select <strong>Take payment</strong>.</li><li>Choose one payment method, or turn on split payment.</li><li>Confirm the amount received and any change.</li><li>Complete the sale.</li><li>Print the receipt or start a new sale.</li></ol>
<p>If live stock changed while the cart was open, StoreMink refuses the sale before moving stock. For an online gateway payment that was already captured, follow the on-screen retry guidance and do not charge the customer a second time.</p>$article$,
    'How to process a sale in StoreMink POS',
    'Process a StoreMink POS sale, attach or create a customer, add GSTIN, hold and resume a cart, take payment, and complete checkout.',
    7
  ),
  (
    'take-payments-and-split-tenders',
    'Take payments and split tenders',
    'Understand cash, card machine, UPI app, verified online payments, store credit, split payments, deposits, and change.',
    $article$<p>The tender panel separates money StoreMink takes or verifies from money you record after using another device. Always choose the method that matches what actually happened.</p>
<h2>Payment methods</h2>
<table><thead><tr><th>Method</th><th>What it means</th></tr></thead><tbody><tr><td>Cash</td><td>Cash enters the drawer. You can enter more than the balance and StoreMink calculates change.</td></tr><tr><td>Card machine</td><td>The customer paid on your own card terminal. Complete that terminal payment first; StoreMink records it but cannot verify it.</td></tr><tr><td>UPI app</td><td>The customer paid through your own UPI app or QR. Confirm it in that app first; StoreMink records it but cannot verify it.</td></tr><tr><td>Online</td><td>StoreMink opens the connected Razorpay checkout and verifies the captured payment and amount before completing the sale.</td></tr><tr><td>Store credit</td><td>Uses the attached customer's available balance. It is a payment, not a discount.</td></tr></tbody></table>
<h2>Take one full payment</h2>
<p>Select the method. Card machine, UPI app, Online, and store credit use the remaining balance and can complete in one step. Cash lets you enter the amount handed over so the receipt can show change.</p>
<h2>Split a payment</h2>
<ol><li>Turn on <strong>Split payment</strong>.</li><li>Select the first method and enter its amount.</li><li>Add it to the sale.</li><li>Select the next method and enter the remaining amount.</li><li>Continue until the balance is covered, then complete the sale.</li></ol>
<p>Only a cash tender can be more than the amount owed because only cash can create change. A card, UPI, online, or store-credit amount cannot exceed the balance.</p>
<h2>Use store credit</h2>
<p>Attach the customer before opening the tender panel. Apply up to the available balance, then take the remainder by another method. The goods value and GST stay unchanged because credit settles money rather than reducing the selling price.</p>
<h2>Take payment for a pickup</h2>
<p>A pay-at-store pickup uses the same tender choices. A part payment is recorded as a deposit and the parcel stays on the shelf. The next visit shows the remaining balance. Store credit can settle a collection in full but cannot be used for a short deposit.</p>
<h2>When an online payment fails after capture</h2>
<p>If the gateway captured money but the sale could not finish, do not charge again. Keep the staged online payment and retry completion. If another till sold the final unit during payment, the sale can fail against captured money; the owner must refund that payment from the dashboard.</p>$article$,
    'Take payments and split tenders in StoreMink POS',
    'Use cash, card machine, UPI app, Razorpay, store credit, split payments, pickup deposits, and change in StoreMink POS.',
    8
  ),
  (
    'discounts-price-overrides-and-manager-approval',
    'Discounts, price overrides, and manager approval',
    'Apply line or order discounts safely, understand owner-only rules, set cashier limits, and approve a sale with a manager PIN.',
    $article$<p>A discount can be an amount off the whole sale, an amount off one line, or a lower price typed for a line. StoreMink treats all three as money being given away and applies the same permission rules.</p>
<h2>Default rule: owner only</h2>
<p><strong>Only the owner can give discounts</strong> is on by default. Cashiers and managers then do not see discount fields and cannot bypass the rule by calling the sale action directly. A manager PIN does not unlock an owner-only policy.</p>
<h2>Let cashiers discount within a limit</h2>
<ol><li>Open <strong>Point of Sale → Settings</strong>.</li><li>Turn off <strong>Only the owner can give discounts</strong>.</li><li>Keep <strong>Require a manager's PIN for large discounts</strong> on.</li><li>Set the maximum percentage a cashier may give without approval.</li><li>Save.</li></ol>
<p>StoreMink adds order and line discounts together before checking the percentage, so splitting one large discount across several lines does not avoid approval.</p>
<h2>Approve a larger discount</h2>
<ol><li>The cashier prepares the exact cart and discount.</li><li>Select payment and try to complete the sale.</li><li>When asked, a manager enters their own PIN.</li><li>StoreMink completes the same cart with that approval.</li></ol>
<p>The approval is valid only for that store, location, till, operator, cart, and discount for a short time. Changing the cart or discount requires a new approval.</p>
<h2>Control price overrides</h2>
<p><strong>Allow price overrides at the register</strong> decides whether any line can be repriced. When it is off, even the owner cannot override a price. When it is on, the person must still pass the owner-only or manager-approval discount rule.</p>
<h2>Review what happened</h2>
<p>Completed discounts and overrides appear in <strong>Point of Sale → Money</strong>. The log records the amount, operator, order, and approving manager when one was required. Refused attempts do not create money-log rows.</p>$article$,
    'POS discounts, price overrides, and manager approval',
    'Learn StoreMink POS discount permissions, cashier limits, manager PIN approvals, line markdowns, price overrides, and money auditing.',
    9
  ),
  (
    'print-email-and-understand-pos-receipts',
    'Print, email, and understand POS receipts',
    'Print an 80 mm receipt, email a walk-in, show GST details, find earlier sales, and reprint a receipt.',
    $article$<p>Every completed POS sale has a receipt based on the sale's saved items, tax, customer, location, and payments. Reprinting later does not recalculate the receipt from today's settings.</p>
<h2>Print after a sale</h2>
<ol><li>Complete the payment.</li><li>On <strong>Sale complete</strong>, select <strong>Print receipt</strong>.</li><li>Choose the connected thermal printer in the browser print dialog.</li><li>Use 80 mm paper and the printer's normal margins or borderless setting.</li></ol>
<p>The print view hides the dark register interface and prints only the receipt.</p>
<h2>Email a receipt to a walk-in</h2>
<p>On the tender panel, enter <strong>Email a receipt (optional)</strong> when no customer with an email is attached. An invalid address never blocks a completed sale; StoreMink skips the email and the paper receipt remains available. The box clears before the next customer.</p>
<p>If the attached customer already has an email, StoreMink sends the normal order confirmation instead of a second direct receipt.</p>
<h2>What the receipt shows</h2>
<ul><li>Store and selling-location details, including the receipt number and configured prefix.</li><li>Items, quantities, line markdowns, order discount, tax, and total.</li><li>Each payment method, cash tendered, and change due.</li><li>The attached customer or walk-in details that were recorded.</li><li>The buyer's GSTIN when entered at the till.</li><li>CGST and SGST or IGST from the tax snapshot, with HSN details where configured.</li></ul>
<h2>Find and reprint an older receipt</h2>
<ol><li>Open <strong>Sales</strong> from the POS menu.</li><li>Search or choose a recent sale from this location.</li><li>Open the sale.</li><li>Select <strong>Print receipt</strong>.</li></ol>
<p>Cashiers can reprint receipts. Managers with return permission also see the action to return items.</p>
<h2>Customer order history</h2>
<p>When a customer is attached, the sale appears under <strong>In store</strong> in their storefront order history with the location, items, total, and invoice. It is shown as purchased in store, not as a delivery order.</p>$article$,
    'Print and email StoreMink POS receipts',
    'Print an 80 mm POS receipt, email walk-in receipts, understand GST and payment details, search sales, and reprint in StoreMink.',
    10
  ),
  (
    'manage-pos-inventory-and-stock-transfers',
    'Manage POS inventory and stock transfers',
    'Receive, count, correct, and transfer stock from the shop floor while keeping a location-level inventory history.',
    $article$<p>The Stock screen works with the shelf at the operator's current location. It does not edit the combined total for every shop.</p>
<h2>Who can manage stock</h2>
<p>Managers and authorised owners can open <strong>Stock</strong>. Cashiers can sell tracked stock but cannot declare how many units exist, receive deliveries, or transfer products.</p>
<h2>Receive stock</h2>
<ol><li>Open <strong>Stock</strong>.</li><li>Search or scan the product.</li><li>Select the receive action.</li><li>Enter the number of new units received.</li><li>Add a useful note and confirm.</li></ol>
<h2>Count or correct stock</h2>
<p>Choose the count/correction action and enter the quantity physically on the shelf. StoreMink writes the difference as an atomic stock movement. If another till sells while you count, that sale is not erased. A count equal to the recorded stock writes no movement.</p>
<h2>Transfer stock to another location</h2>
<ol><li>Open the product from Stock.</li><li>Select <strong>Transfer</strong>.</li><li>Choose the destination location.</li><li>Enter the quantity and confirm.</li></ol>
<p>The source decreases and destination increases in one transaction, with paired transfer-out and transfer-in ledger rows. If there are not enough units at the source, the transfer is refused.</p>
<h2>Understand the inventory history</h2>
<p>Every receive, correction, count, transfer, sale, return, and other tracked movement records the location, quantity change, reason, actor, and time. This append-only history explains how the current figure was reached.</p>
<h2>Live updates and unavailable stock</h2>
<p>The Stock list refreshes in the background while the tab is visible and no adjustment panel is open. It catches up immediately when the network returns. Correcting a tracked product to zero creates the same out-of-stock notification as selling the final unit.</p>
<h2>Dashboard inventory</h2>
<p>Use the dashboard Inventory page for a wider view. <strong>All locations</strong> is a read-only total; choose one location before editing so a correction is applied to the right shelf.</p>$article$,
    'Manage inventory and transfers in StoreMink POS',
    'Receive, count, correct, and transfer location stock in StoreMink POS and understand the inventory movement ledger and live updates.',
    11
  ),
  (
    'open-close-and-reconcile-cash-shifts',
    'Open, close, and reconcile cash shifts',
    'Start a drawer with a float, record cash movements, close with a count, understand variance, and review Z-reports.',
    $article$<p>A shift groups the money handled by one location's drawer. StoreMink records each payment against the shift that actually took it, including a deposit collected before the final pickup payment.</p>
<h2>Open a shift</h2>
<ol><li>Open <strong>Drawer</strong> from the POS menu.</li><li>Count the starting cash.</li><li>Enter the opening float.</li><li>Select <strong>Open shift</strong>.</li></ol>
<p>Only one shift can be open at a location. Cashiers can sell into the drawer but cannot open or close it.</p>
<h2>Record cash movements</h2>
<ul><li><strong>Cash drop</strong> records money removed for banking or safe storage.</li><li><strong>Paid in</strong> records cash added after opening.</li><li><strong>Payout</strong> records cash taken out for an approved business reason.</li></ul>
<p>Add a clear note. These movements affect expected cash and appear in the money audit.</p>
<h2>What expected cash includes</h2>
<p>Expected cash starts with the opening float, adds cash sales and cash taken for pay-at-store pickups, subtracts change, cash refunds, drops, and payouts, then adds paid-in movements. Card, UPI, online, store-credit, and prepaid pickup amounts do not enter the drawer.</p>
<h2>Close and reconcile</h2>
<ol><li>Count the physical cash in the drawer.</li><li>Enter the closing count.</li><li>Review StoreMink's expected amount and equation.</li><li>Confirm the close.</li></ol>
<p>Variance is <strong>counted cash minus expected cash</strong>. StoreMink flags a difference outside the POS cash-variance tolerance. A closed shift cannot be closed again.</p>
<h2>Review shift history and Z-reports</h2>
<p>From the dashboard, open <strong>Point of Sale → Shifts</strong>. Each closed Z-report is a frozen snapshot of its sales, tenders, refunds, movements, expected cash, count, and variance. Editing an order later does not rewrite a closed report.</p>
<h2>When shifts are required</h2>
<p>If <strong>Require an open shift to sell</strong> is enabled, the register refuses sales, deposits, and unpaid pickup collection until a manager opens the drawer. A prepaid pickup remains collectable because no counter payment is taken.</p>$article$,
    'Open, close, and reconcile StoreMink POS shifts',
    'Open a POS drawer with a float, record cash movements, close and reconcile cash, understand variance, and review frozen Z-reports.',
    12
  ),
  (
    'prepare-and-hand-over-pickup-orders',
    'Prepare and hand over pickup orders',
    'Work the pickup queue, use collection codes, mark parcels ready, take deposits or final payment, handle expiry, and complete hand-over.',
    $article$<p>Pickup connects website checkout with the shop counter. An order first reserves stock at the chosen location; the physical on-hand quantity drops only when the parcel is handed over.</p>
<h2>Before pickup orders can arrive</h2>
<ul><li>Turn on <strong>Offer pickup at checkout</strong> in Locations → Online fulfilment.</li><li>Give at least one active shop both <strong>Sell here</strong> and <strong>Customer pickup</strong>.</li><li>Choose whether collection orders are paid online, paid at the counter, or left to the shopper.</li><li>Set the ready time and collection hold period.</li></ul>
<h2>Understand the queue</h2>
<p>Open <strong>Pickups</strong>. <strong>To prepare</strong> contains orders staff still need to pack. <strong>Ready to collect</strong> contains parcels waiting for the customer. New orders appear automatically; an unchanged queue polls less often to reduce background traffic.</p>
<h2>Find an order</h2>
<p>Search by order reference, customer phone, or email, or scan/type the collection code. The code also appears as text below the customer's QR so it works when email images are blocked. If the order belongs to another shop, StoreMink names that location instead of pretending the order does not exist.</p>
<h2>Mark a parcel ready</h2>
<ol><li>Check and pack every item.</li><li>Select <strong>Mark ready</strong>.</li><li>The row moves to Ready to collect immediately.</li><li>The customer receives the ready notification with the shop name, address, and collection code.</li></ol>
<h2>Take payment or a deposit</h2>
<p>For a pay-at-store order, select <strong>Take payment</strong>. Use cash, card machine, UPI app, Online, store credit, or a split. A short payment is a deposit: StoreMink records it, shows the remaining amount, and keeps the parcel in the queue. Deposits remain attributed to the shift that took them.</p>
<h2>Hand the parcel over</h2>
<p>A paid and ready order can be handed over immediately. If nobody marked it ready, StoreMink asks the operator to confirm that the goods are physically present before continuing. Completion converts the stock reservation into the final stock reduction and removes the order from the queue.</p>
<h2>Expiry and late customers</h2>
<p>Ready orders nearing expiry are highlighted. If the hold date has passed but the expiry sweep has not cancelled the order yet, it can still be served and the screen explains the situation. After the sweep cancels it, the order shows no hand-over action and says that the stock returned to availability.</p>
<h2>Open the detail panel</h2>
<p>Select the order reference to see the customer, collection code, every item, totals, paid amount, deposit tenders, balance, status, promised date, actual prepared time, and available actions before releasing the parcel.</p>$article$,
    'Prepare and hand over StoreMink pickup orders',
    'Use the POS pickup queue, collection codes, ready notifications, pay-at-store tenders, deposits, expiry handling, and parcel hand-over.',
    13
  ),
  (
    'take-returns-at-the-counter',
    'Take returns at the counter',
    'Find a POS or eligible online order, choose returned items, control restocking, use a valid refund method, and avoid over-refunding.',
    $article$<p>Returns give goods and money back, so they require the POS return/refund permission. Cashiers can search and reprint sales but cannot open the return flow unless their role is granted that capability.</p>
<h2>Return a sale made at this shop</h2>
<ol><li>Open <strong>Returns</strong> or find the order from <strong>Sales</strong>.</li><li>Search by order reference, receipt number, phone, or email.</li><li>Open the order and select <strong>Return items</strong>.</li><li>Choose each item and quantity being returned.</li><li>Mark damaged units as <strong>Do not restock</strong> when they cannot go back on sale.</li><li>Choose an available refund method and confirm.</li></ol>
<p>StoreMink calculates the refundable amount from the saved sale, including that line's share of order discounts and tax. It never trusts a refund total sent by the browser and never refunds more units or money than remain.</p>
<h2>Return an online order in store</h2>
<p>Turn on <strong>Accept returns</strong>, enable <strong>Accept online returns in your shops</strong>, and give this location the <strong>Accept returns</strong> capability. The manager can then search an eligible online order. It appears as <strong>Bought elsewhere</strong> so the source is clear.</p>
<h2>Choose the correct refund route</h2>
<ul><li>A StoreMink online card payment goes back through the original gateway. The till does not offer cash for it.</li><li>A COD or counter-paid order may offer the allowed counter methods.</li><li>Store credit is offered only when a customer account is attached.</li><li>A cash refund reduces the current drawer's expected cash.</li></ul>
<h2>Choose where stock returns</h2>
<p>A counter return restocks at the shop that physically received the goods, not automatically at the shop that sold them or the default location. Damaged/no-restock units do not increase sellable stock.</p>
<h2>If the gateway refund cannot be confirmed</h2>
<p>The physical return remains recorded because the shop already has the goods. The screen warns the operator that the owner must complete or reconcile the refund from the dashboard. Do not hand out cash for a card-not-present payment.</p>
<h2>Partial and repeated returns</h2>
<p>A partial return leaves the original sale completed for the items the customer kept. StoreMink locks and re-checks the order so two tills cannot both refund the same remaining unit.</p>$article$,
    'Take POS and online returns at the counter',
    'Take partial StoreMink POS returns, accept eligible online returns in store, choose refund methods, restock the correct shop, and prevent over-refunds.',
    14
  ),
  (
    'refunds-store-credit-exchanges-and-credit-notes',
    'Refunds, store credit, exchanges, and credit notes',
    'Understand refund destinations, store-credit balances, exchange requests, replacement stock, and GST credit notes after a return.',
    $article$<p>A return records the goods that came back. A refund records how the customer is repaid. They are related but separate steps, and an approved or received return does not always refund automatically.</p>
<h2>Refund to the original method</h2>
<p>For an eligible Razorpay payment, StoreMink sends the refund through the merchant's connected account. A completed refund reduces sales on its settlement date. A timeout can mean the refund is still in flight, so do not send it again until StoreMink reconciles the result.</p>
<h2>Refund as store credit</h2>
<p>Choose <strong>Store credit</strong> when the order belongs to a customer account. The balance belongs to that customer at that store and appears at online checkout and the POS tender panel. Store credit is a payment balance, not a discount: the order total and GST do not change when it is spent.</p>
<p>A walk-in with no customer attached cannot receive store credit. Attach or create the customer before the original sale whenever they may need account-based after-sales support.</p>
<h2>Reinstate previously spent credit</h2>
<p>If an order that used store credit is cancelled or correctly refunded, StoreMink restores the eligible credit exactly once and records the reason in the credit ledger.</p>
<h2>Understand exchanges</h2>
<p>Exchanges begin from the customer's delivered-order return request when the store has both <strong>Accept returns</strong> and <strong>Offer exchanges</strong> enabled. The customer can choose another in-stock variant. StoreMink supports an even or cheaper replacement; a more expensive replacement is refused and the customer should place a new order.</p>
<p>The replacement stock is held when the request is submitted. Declining or withdrawing releases the hold. Approving and receiving the goods creates a separate paid replacement order and moves both returned and replacement stock exactly once.</p>
<h2>GST credit notes</h2>
<p>When a refund for a taxed order settles, StoreMink creates a consecutive GST credit-note number for that store. The document refers to the original invoice and reverses only the returned lines and tax. Intra-state notes show CGST and SGST; inter-state notes show IGST. A pending or failed refund does not consume a credit-note number.</p>
<h2>Retained fees</h2>
<p>When the returns policy keeps an allowed restocking or return-postage fee, the credit note shows the credited goods value, fees retained, and final refunded amount separately.</p>$article$,
    'StoreMink refunds, store credit, exchanges, and GST credit notes',
    'Understand StoreMink POS refunds, store credit, exchange requests and reservations, replacement orders, and GST credit notes.',
    15
  ),
  (
    'view-pos-sales-shifts-money-and-analytics',
    'View POS sales, shifts, money, and analytics',
    'Find in-store sales, reprint receipts, review POS orders, audit discretionary money events, and filter analytics by location.',
    $article$<p>StoreMink keeps quick counter history inside POS and fuller operational reporting in the dashboard.</p>
<h2>Use the Sales screen at the counter</h2>
<ol><li>Open <strong>Sales</strong> from the POS menu.</li><li>Search recent sales from the current location.</li><li>Open a sale to view its receipt.</li><li>Reprint it, or start a return when your role allows returns.</li></ol>
<h2>Use the dashboard Orders workspace</h2>
<p>When POS is enabled on Pro, Dashboard → Orders shows <strong>All orders</strong>, <strong>Website orders</strong>, and <strong>POS orders</strong>. A standard register sale shows Sold at location, cashier, customer or Walk-in, items, payments, and receipt. It does not show delivery or shipment controls because the goods were handed over at the register.</p>
<h2>Review shift history</h2>
<p>Open <strong>Point of Sale → Shifts</strong> to review open and closed drawers. Closed Z-reports preserve sales, tenders, refunds, cash movements, counts, and variance from the moment the shift closed.</p>
<h2>Review the Money log</h2>
<p>Open <strong>Point of Sale → Money</strong> for discretionary events rather than every ordinary sale. It records completed discounts, price overrides, refunds, cash drops, payouts, and paid-in movements with the operator, order, amount, and approver. Device pairing and security events remain on Devices instead.</p>
<h2>Use Analytics</h2>
<p>Open <strong>Analytics</strong> and choose a date range and accessible location. POS orders contribute to recognised sales, orders, units, products, channels, locations, payment-method reports, inventory velocity, refunds, and gross margin when configured. Split tenders appear by their real methods rather than as one vague Split row.</p>
<h2>Understand location scope</h2>
<p>An unrestricted owner can choose one physical location or the whole accessible store. Staff assigned to a location cannot use an Analytics URL to see another shop. A location view excludes online or unassigned orders when it is meant to describe that exact shop.</p>
<h2>Customer history</h2>
<p>A customer attached at the till sees the sale under <strong>In store</strong> in their storefront order history. Pickup orders also appear in the in-store journey even though the order was placed through website checkout.</p>$article$,
    'View StoreMink POS sales, shifts, money, and analytics',
    'Find and reprint POS sales, review register orders and Z-reports, audit money events, and understand location-scoped POS analytics.',
    16
  ),
  (
    'troubleshoot-pos-and-internet-issues',
    'Troubleshoot POS and internet issues',
    'Fix common plan, location, device, staff, stock, shift, payment, pickup, receipt, and connectivity problems at the counter.',
    $article$<h2>POS opens the product page instead of my register</h2>
<p>Use your merchant store domain followed by <strong>/pos</strong>, for example <strong>your-store.storemink.com/pos</strong>. The separate pos.storemink.com address is the public product site.</p>
<h2>POS says it is unavailable</h2>
<ul><li>Confirm the store is currently on Pro.</li><li>Open Dashboard → Point of Sale and make sure POS is enabled.</li><li>Confirm the current location is active and has <strong>Sell here</strong> enabled.</li><li>If the plan was downgraded, restore Pro. Existing POS data is kept.</li></ul>
<h2>A staff member cannot sign in</h2>
<ul><li>Check that the invitation was completed and the staff row is active.</li><li>Check that the person is assigned to this location.</li><li>Use <strong>Forgot PIN or password?</strong> for a single-use reset link.</li><li>If a new browser shows a pairing prompt, the owner must authorise the device or provide a fresh pairing code.</li></ul>
<h2>A pairing code does not work</h2>
<p>Codes are single-use and expire after 10 minutes. Generate a new code from Point of Sale → Devices. If the device was revoked or clone detection fired, review the security event before trusting the browser again.</p>
<h2>A product is missing or sold out</h2>
<p>Search the full catalogue; a product can be absent from the quick layout and still be sellable. Check that it is published, its variant still exists, the barcode is correct, and available stock at this location is above zero. The catalogue catches up after reconnecting, but the server's live price and stock always win at completion.</p>
<h2>The register asks for an open shift</h2>
<p>The store has <strong>Require an open shift to sell</strong> enabled. A manager must open Drawer and enter the float before staff can take counter money. A prepaid pickup can still be handed over.</p>
<h2>Card or UPI is not verified</h2>
<p><strong>Card machine</strong> and <strong>UPI app</strong> record a payment completed outside StoreMink. Check the external terminal or app before adding the tender. Use <strong>Online</strong> when you want StoreMink to charge and verify the connected Razorpay gateway.</p>
<h2>An online payment was captured but the sale failed</h2>
<p>Do not take the payment again. Retry completion with the staged gateway reference. If stock was sold on another till during payment, the owner must refund the captured payment from the dashboard.</p>
<h2>A pickup cannot be found</h2>
<p>Search by order reference, phone, or email, or scan/type the collection code. A code from another location should name that shop. A cancelled, collected, refunded, or expired order can still appear in search but correctly offers no hand-over action.</p>
<h2>The printer or email receipt failed</h2>
<p>Reopen the sale from <strong>Sales</strong> and print again. Check the browser's selected printer, 80 mm paper setting, and system print permission. For email, confirm the address and check the dashboard email log; a receipt delivery failure does not reverse the sale.</p>
<h2>Can I sell without internet?</h2>
<p>No. Cached catalogue search can keep working briefly, but checkout, live stock validation, payment verification, pickup, returns, shifts, and stock movements need the StoreMink server. Restore the connection, let the screen refresh, and then continue. Do not record a sale as completed until StoreMink confirms it.</p>$article$,
    'Troubleshoot StoreMink POS and internet issues',
    'Fix StoreMink POS plan, location, login, device, stock, shift, payment, pickup, receipt, printer, and internet connection issues.',
    17
  )
) AS document(
  slug,
  title,
  excerpt,
  body,
  seo_title,
  seo_description,
  position
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
  published_at = COALESCE(existing.published_at, now()),
  updated_at = now();
