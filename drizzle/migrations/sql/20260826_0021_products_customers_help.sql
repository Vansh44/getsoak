-- Publish merchant-facing product, inventory, customer, and enquiry guides.
-- Customer deletion is documented only as a current-risk warning because the
-- shipped cascade can remove linked order records.

-- Put Customers & enquiries after Point of Sale. Guard the shift so rerunning
-- this migration never moves the remaining category grid twice.
UPDATE public.help_categories
SET position = position + 1
WHERE position >= 5
  AND NOT EXISTS (
    SELECT 1
    FROM public.help_categories
    WHERE slug = 'customers'
  );

INSERT INTO public.help_categories AS existing
  (slug, title, description, icon, position)
VALUES
  ('products', 'Products & inventory',
   'Add products and variants, organise the catalogue, and keep location stock accurate.',
   'Package', 3),
  ('customers', 'Customers & enquiries',
   'Manage customer profiles and groups, understand customer accounts, and respond to enquiries.',
   'Users', 5)
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  position = EXCLUDED.position,
  updated_at = now();

WITH help_category AS (
  SELECT id, slug
  FROM public.help_categories
  WHERE slug IN ('products', 'customers')
), documents (
  category_slug, slug, title, excerpt, body, seo_title, seo_description, position
) AS (
  VALUES
  (
    'products',
    'add-or-edit-a-product',
    'Add or edit a product',
    'Create a product draft, complete every required field, and understand the published catalogue allowance on each plan.',
    $article$<h2>Add a product</h2>
<ol><li>From the dashboard, open <strong>Products</strong>.</li><li>Select <strong>Add product</strong>.</li><li>On <strong>Basics</strong>, enter the required name, category, and description. The URL handle is filled from the name unless you change it.</li><li>Complete the Media, Pricing, Variants, and Visibility tabs that apply.</li><li>On <strong>SEO</strong>, enter both the SEO title and SEO description. These fields are required even while the product is a draft.</li><li>Select <strong>Create product</strong>.</li></ol>
<p>A new product starts as a draft, so it does not appear to customers until you publish it from the Visibility tab.</p>
<p>If a required field is missing, StoreMink opens the tab that needs attention. A product cannot be saved without a name, category, description, SEO title, and SEO description.</p>
<h2>Edit an existing product</h2>
<ol><li>Open <strong>Products</strong>.</li><li>Search for the product and open it.</li><li>Change the relevant fields.</li><li>Save, then check the product on the storefront if it is published.</li></ol>
<h2>Published plan allowances</h2>
<ul><li><strong>Free:</strong> up to 25 products.</li><li><strong>Basic:</strong> up to 500 products.</li><li><strong>Pro:</strong> unlimited products.</li></ul>
<p>These are the product allowances published for each plan. StoreMink does not delete products after a downgrade. <strong>Current limitation:</strong> the product-creation action does not yet enforce the published cap automatically, so do not treat a successful save above the allowance as a plan upgrade or a larger entitlement.</p>$article$,
    'Add or edit a product in StoreMink',
    'Create and edit StoreMink product drafts, complete required fields, publish when ready, and understand Free Basic and Pro catalogue allowances.',
    1
  ),
  (
    'products',
    'add-product-images-and-variants',
    'Add product images and variants',
    'Upload product and variant images, then add options with their own price, initial stock, StoreMink SKU, and supplier barcode.',
    $article$<h2>Add product images</h2>
<ol><li>Open the product and select <strong>Media</strong>.</li><li>Upload the primary image used as the storefront thumbnail.</li><li>Upload any extra gallery images.</li><li>Remove an image that should no longer appear, then save the product.</li></ol>
<p>The current product editor adds gallery images in upload order and does not provide a control to rearrange them. Choose the primary image separately and upload extra images in the order you want.</p>
<h2>Add variants</h2>
<ol><li>Select the <strong>Variants</strong> tab.</li><li>Select <strong>Add variant</strong>.</li><li>Enter a clear option name, such as a size or colour.</li><li>Enter its base and selling prices, optional sale price, initial stock, supplier barcode, and images. Cost appears only when gross margin is available for the store.</li><li>Repeat for the remaining options. Use the arrows to reorder variant rows; the top variant is selected first on the product page.</li><li>Save the product.</li></ol>
<p>The Stock field sets the starting quantity for a new variant. Changing that field on an existing variant does not update inventory; open <strong>Products → Inventory</strong> and change stock at the correct location instead. Variant gallery images can be added or removed, but cannot currently be rearranged.</p>
<h2>Simple products and variants</h2>
<p>A product without variants uses the product-level price, barcode, tracking, backorder, and low-stock controls. After you add variants, each variant becomes the sellable stock unit, so inventory and scanning use variant values. The current editor does not expose tracking, backorder, or low-stock controls for individual variants; manage their location quantities from Inventory.</p>
<h2>Removing a variant</h2>
<p>Delete only a variant that has never appeared in an order. Order history protects referenced variants, so saving the product will fail if you remove a sold variant. Leave that variant in the product. If it is inventory-tracked, set its location stock to zero to make it unavailable; if you must stop the entire product, change the product to Draft. The current editor does not provide a separate unpublish control for one variant.</p>$article$,
    'Add StoreMink product images and variants',
    'Add StoreMink product and variant images, prices, initial stock, barcodes and ordering, with current gallery and deletion limits.',
    2
  ),
  (
    'products',
    'set-product-pricing-tax-and-shipping-details',
    'Set product pricing, tax, and shipping details',
    'Enter selling and cost prices, choose a tax class, add HSN details, and provide the weight and size used for delivery.',
    $article$<h2>Set prices</h2>
<ol><li>Open the product and select <strong>Pricing</strong>.</li><li>Enter the product base or MRP value and its selling price.</li><li>Open <strong>Variants</strong> to set each option's base price, selling price, and optional sale price.</li></ol>
<p><strong>Cost per unit</strong> and merchandise gross-margin reporting are Pro features, and appear only when StoreMink has also enabled the gross-margin module for the platform. When the field is available, a variant cost can be left blank to inherit the product cost. The first supplied cost can fill older order lines that have no cost snapshot; later edits apply to new sales and do not rewrite an existing snapshot.</p>
<h2>Choose tax details</h2>
<ol><li>Create the required tax class first in <strong>Taxes &amp; invoices</strong>.</li><li>Return to the product and choose the tax class on <strong>Basics</strong>.</li><li>Open <strong>Pricing</strong> and enter the HSN code in the Shipping section when required.</li><li>Save.</li></ol>
<p>Product import does not create tax classes automatically. Historical order lines keep their saved tax and price snapshots when you edit the product later.</p>
<h2>Add shipping details</h2>
<p>On <strong>Pricing</strong>, choose whether the product requires shipping. For a physical product, enter the product-level weight and dimensions. Shiprocket and delivery estimates depend on accurate package and location information.</p>
<h2>Current variant shipping limitation</h2>
<p>The product editor does not expose variant-specific shipping, weight, or dimension fields. Variants inherit the product-level values unless their records already contain an import-supplied override. The current product CSV template does not expose columns for creating or correcting those physical overrides. Correct the final packed measurements while booking a shipment, or contact StoreMink Support if a stored variant override is wrong.</p>$article$,
    'Set StoreMink product price tax and shipping details',
    'Set StoreMink prices, gated product costs, tax class, HSN and product-level shipping measurements, and understand current variant limits.',
    3
  ),
  (
    'products',
    'publish-feature-and-improve-a-product-for-search',
    'Publish, feature, and improve a product for search',
    'Choose storefront visibility, assign catalogue organisation, and write useful page titles and descriptions for search engines.',
    $article$<h2>Choose organisation and visibility</h2>
<ol><li>Open the product and choose its required category on <strong>Basics</strong>.</li><li>Open <strong>Visibility</strong> and choose an optional product-card colour.</li><li>Turn <strong>Featured</strong> on when homepage or builder sections should highlight it.</li><li>Change the status from Draft to Published when it is ready.</li><li>Save and open the storefront product page.</li></ol>
<h2>Add search details</h2>
<ol><li>Select the <strong>SEO</strong> tab.</li><li>Write a short, specific SEO title.</li><li>Write a plain description that explains the real product without invented claims.</li><li>Use the AI helper if useful, then review every word before saving.</li></ol>
<p>AI generation uses the store's monthly allowance or purchased credits. It can draft from the information you provide, but you remain responsible for accuracy.</p>
<h2>If a product is missing from the storefront</h2>
<p>Confirm the product status is <strong>Published</strong>, then clear category filters and search for the exact name or URL handle. Published status controls whether the product appears in the catalogue. A hidden category is removed from category navigation, but does not by itself hide a published product from the full catalogue. Zero tracked stock also does not hide the product; it changes whether customers can buy it and normally shows it as sold out unless backorders are allowed.</p>$article$,
    'Publish and improve StoreMink products for search',
    'Publish and feature a StoreMink product, assign its category and card colour, write SEO details, and troubleshoot missing storefront products.',
    4
  ),
  (
    'products',
    'organize-products-with-categories-and-card-colours',
    'Organise products with categories and card colours',
    'Create reusable catalogue categories and visual card colours, then assign them to products.',
    $article$<h2>Create a category</h2>
<ol><li>Open <strong>Products → Categories</strong>.</li><li>Create a category with a name and URL handle.</li><li>Add its description and image when useful.</li><li>Choose its status and order, then save.</li></ol>
<p>Use a stable handle because it becomes part of storefront browsing and import matching.</p>
<h2>Create a card colour</h2>
<ol><li>Open <strong>Products → Colours</strong>.</li><li>Add a clear internal name and choose the colour value.</li><li>Save it.</li></ol>
<h2>Assign organisation to products</h2>
<ol><li>Open a product.</li><li>On <strong>Basics</strong>, choose its required category.</li><li>On <strong>Visibility</strong>, choose the optional card colour.</li><li>Save and check the product card on the storefront.</li></ol>
<p>Making a category Hidden removes that category from storefront category navigation. It does not unpublish products assigned to it; change a product's own status to Draft when the product itself must be hidden.</p>
<h2>Import behaviour</h2>
<p>A product CSV can create a missing category by name or handle. It never creates a missing tax class. Category imports match existing categories by handle.</p>$article$,
    'Organise StoreMink products with categories and colours',
    'Create StoreMink product categories and card colours, assign them in the product editor, and understand handles and CSV matching.',
    5
  ),
  (
    'products',
    'understand-storemink-skus-and-barcodes',
    'Understand StoreMink SKUs and barcodes',
    'Know the difference between StoreMink’s permanent stock identifier and the editable supplier code printed on packaging.',
    $article$<h2>StoreMink SKU</h2>
<p>StoreMink generates a system SKU for every sellable simple product or variant. It is permanent and read-only so stock history, imports, transfers, orders, and POS can continue to identify the same item.</p>
<h2>Supplier barcode</h2>
<p>The barcode is the code already printed on the product or supplied by the manufacturer. It is editable and can be an EAN, UPC, or another text code. A product with variants stores the barcode on each variant.</p>
<h2>Where each value is used</h2>
<ul><li>Use the <strong>StoreMink SKU</strong> to match rows in an inventory CSV.</li><li>Use the <strong>barcode</strong> for hardware or camera scanning and catalogue search.</li><li>Use the product handle to match products in a product CSV.</li></ul>
<h2>Avoid duplicate barcodes</h2>
<p>Give each sellable item the barcode from its own packaging. Duplicate or incorrect codes can make search or a register scan return the wrong item.</p>$article$,
    'StoreMink SKUs and supplier barcodes explained',
    'Understand permanent StoreMink SKUs, editable supplier barcodes, simple products and variants, inventory CSV matching, and scanning.',
    6
  ),
  (
    'products',
    'track-inventory-and-allow-backorders',
    'Track inventory and allow backorders',
    'Turn stock tracking on, understand on-hand, reserved, and available quantities, and decide whether customers may buy past zero.',
    $article$<h2>Turn on tracking for a simple product</h2>
<ol><li>Open a product that has no variants and select <strong>Pricing</strong>.</li><li>In Inventory, turn on <strong>Track quantity for this product</strong>.</li><li>Choose whether to continue selling when out of stock.</li><li>Enter a product-specific low-stock threshold, or leave 0 to use the store default.</li><li>Save the product.</li><li>Open <strong>Products → Inventory</strong>, choose the correct location, and set its stock. An existing simple product also shows a <strong>Manage</strong> link beside Stock.</li></ol>
<h2>Products with variants</h2>
<p>When a product has variants, the simple-product inventory controls are hidden and each variant is the stock unit shown in Inventory. The current product editor lets you enter starting stock for a new variant, but does not expose per-variant tracking, backorder, or low-stock-threshold controls. Change existing variant quantities only from <strong>Products → Inventory</strong> at the correct location.</p>
<h2>Understand the quantities</h2>
<ul><li><strong>On hand</strong> is the physical quantity recorded at the location.</li><li><strong>Reserved</strong> is stock held for orders that have not released or completed the reservation.</li><li><strong>Available</strong> is on hand minus reserved.</li></ul>
<h2>Allow backorders</h2>
<p>For a simple product, turn on backorders only when you are prepared to accept an order beyond available stock. StoreMink still shows and records the resulting stock position, but fulfilment is your responsibility.</p>
<h2>Checkout safety</h2>
<p>The storefront limits quantities using the current availability and rechecks price, stock, coupon, tax, and shipping at checkout. A stale cart is corrected before an order is completed.</p>$article$,
    'Track StoreMink inventory and allow backorders',
    'Enable inventory tracking, understand on-hand reserved and available stock, set low-stock thresholds, allow backorders, and understand checkout checks.',
    7
  ),
  (
    'products',
    'adjust-stock-at-a-location',
    'Adjust stock at a location',
    'Set a counted quantity or add and subtract stock while keeping a location-based inventory history.',
    $article$<h2>Choose the location</h2>
<ol><li>Open <strong>Products → Inventory</strong>.</li><li>Select a specific location.</li><li>Search for the product or SKU.</li></ol>
<p><strong>All locations</strong> is a read-only total. Choose one location before changing stock.</p>
<h2>Set the stock level</h2>
<ol><li>Select the item row to open <strong>Manage stock</strong>.</li><li>Enter the exact stock level, or use the minus, plus, and quick-adjust buttons to calculate the new level.</li><li>Choose the reason.</li><li>Select <strong>Save stock</strong>.</li></ol>
<h2>Adjust several items</h2>
<p>Select multiple rows and choose the bulk stock action when they should all receive the same exact stock level. This is an absolute Set operation, not a separate amount added to or subtracted from every item. Review the location, selection, and value before confirming.</p>
<h2>Only on-hand stock is editable</h2>
<p>The Inventory screen changes on-hand stock. Orders control reservations, and available stock is calculated from on hand minus reserved. Correct the order lifecycle instead of trying to overwrite a reservation. Every saved change writes a ledger movement so the history remains explainable.</p>$article$,
    'Adjust StoreMink inventory at a location',
    'Choose a StoreMink location, set or adjust on-hand stock, use bulk actions, and understand why reserved and available quantities are read-only.',
    8
  ),
  (
    'products',
    'set-low-stock-defaults-and-read-stock-history',
    'Set low-stock defaults and read stock history',
    'Choose the default tracking behaviour and alert level, find low stock, and review the ledger behind a quantity.',
    $article$<h2>Set store-wide defaults</h2>
<p>Open <strong>/dashboard/inventory/settings</strong> on your store dashboard. The current sidebar and Inventory page do not expose a link to this settings route, so enter the address directly.</p>
<ol><li>Choose whether newly created simple products should track inventory by default.</li><li>Set the store-wide low-stock threshold.</li><li>Save.</li></ol>
<h2>Override one simple product</h2>
<p>For a product without variants, open the product's <strong>Pricing</strong> tab and enter a product-specific threshold when it needs an earlier or later warning. Enter 0 to use the store default. The current editor does not expose this override for an individual variant.</p>
<h2>Find low stock</h2>
<p>Use the low-stock badge or filter in Inventory. Choose the correct location before ordering or moving stock because one store-wide total can hide a shortage at a particular shop.</p>
<h2>Read the history</h2>
<p>Select an item, then choose <strong>History</strong>. Each entry currently shows the reason, timestamp, quantity delta, an order ID when present, the note or “System Update”, and the balance after the movement.</p>
<p><strong>Current limitation:</strong> the history drawer does not display or filter by location and does not display the operator. On a multi-location store, use it to understand the sequence of changes, but do not use the drawer alone to attribute a movement to a particular shop or person. Use the location selector to check the current shelf and contact StoreMink Support when exact attribution is required.</p>$article$,
    'Set StoreMink low-stock alerts and view history',
    'Set StoreMink inventory defaults and low-stock thresholds, find shortages by location, and use the stock ledger to investigate quantities.',
    9
  ),
  (
    'products',
    'bulk-update-products-and-stock',
    'Bulk update products and stock',
    'Select many catalogue rows to publish or feature, update location stock, and permanently delete only records that have never been ordered.',
    $article$<h2>Choose products</h2>
<ol><li>Open <strong>Products</strong>.</li><li>Use search and filters to narrow the list.</li><li>Select the required rows, or select the current filtered set when offered.</li><li>Choose the bulk action.</li><li>Review the count and confirm.</li></ol>
<h2>Available product actions</h2>
<p>Use bulk actions to publish or unpublish products, change featured state, or request deletion of selected products. The action applies only to the selection shown in the confirmation.</p>
<h2>Bulk stock changes</h2>
<p>Open <strong>Inventory</strong>, choose a specific location, select the stock rows, and set the exact quantity that should apply to every selected row. Stock changes go through the inventory ledger.</p>
<h2>Deletion is only for unused products</h2>
<p>Delete only a product and variants that have never appeared in an order. Order history protects referenced products and variants, so a sold product cannot be deleted. A bulk deletion also fails when its selection contains a protected product. Unpublish the product instead so it remains available to historical orders, invoices, and reports.</p>
<p>For an unused product, deletion permanently removes its catalogue record, variants, and images and cannot be undone. Storefront links and selected builder content can stop working, so export or record anything you need first.</p>$article$,
    'Bulk update StoreMink products and inventory',
    'Select multiple StoreMink products to publish feature unpublish or delete them, and make location stock changes through the inventory ledger.',
    10
  ),
  (
    'products',
    'import-and-export-products-categories-inventory-orders-and-coupons',
    'Import and export products, categories, inventory, orders, and coupons',
    'Use CSV templates and background jobs safely, understand matching rules, and fix row-level import problems.',
    $article$<h2>Supported resources</h2>
<ul><li>Products, categories, inventory, and coupons can be imported and exported.</li><li>Orders can be exported but not imported.</li><li>Customer import and export are not currently available.</li></ul>
<h2>Start a job</h2>
<ol><li>Open <strong>Products</strong>, <strong>Categories</strong>, <strong>Inventory</strong>, or <strong>Coupons</strong>. These resource pages provide both import and export; the Orders page provides export only.</li><li>Choose the import or export action on that page. For an import, download the current template.</li><li>Complete the CSV without renaming required columns.</li><li>Upload the file and confirm the job.</li><li>You may close the page while StoreMink processes it.</li><li>Open <strong>Logs → Import logs</strong> or <strong>Logs → Export logs</strong> to monitor the job and read row warnings and errors.</li></ol>
<p>An import can contain up to 50,000 rows and the file can be up to 25 MB.</p>
<h2>Important matching rules</h2>
<ul><li>Product rows sharing a <strong>Handle</strong> become one product with variants.</li><li>Categories match on Handle, inventory matches on StoreMink SKU, and coupons match on Code.</li><li>A column missing from the file means leave the existing value unchanged.</li><li>Variants missing from the CSV are kept. An unused variant can be removed in the product editor, but a variant referenced by an order cannot be deleted.</li><li>Product-import stock applies when creating a product. Use Inventory import to change stock for an existing SKU.</li><li>A missing category may be created, but a missing tax class is never created automatically.</li></ul>
<h2>Inventory import</h2>
<p>Inventory import sets On hand at the selected or named location through a ledger adjustment. Reserved and Available are calculated and ignored as import inputs.</p>$article$,
    'Import and export StoreMink CSV data',
    'Import and export StoreMink products categories inventory orders and coupons, follow CSV matching rules, and review background job errors.',
    11
  ),
  (
    'customers',
    'manage-customer-profiles-and-activity',
    'Manage customer profiles and activity',
    'Search the store-wide customer list, view account details and customer-created content, and edit the fields merchants are allowed to change.',
    $article$<h2>Find a customer</h2>
<ol><li>From the dashboard, open <strong>Customers</strong>. The current page heading says <strong>Users</strong>; these are shopper accounts, not dashboard staff.</li><li>Search by name, email, or phone.</li><li>Use the <strong>All users</strong>, <strong>New (30 days)</strong>, <strong>Reviewers</strong>, or <strong>Has email</strong> filter.</li><li>Sort by newest, oldest, name, or activity when needed.</li><li>Open the customer.</li></ol>
<h2>What the profile shows</h2>
<p>The detail shows the verified phone, email when available, joined date, product reviews, and blog submissions. It does not currently include a merchant-facing order-history tab; search <strong>Orders</strong> when you need an order.</p>
<h2>Edit allowed details</h2>
<ol><li>Select <strong>Edit details</strong>.</li><li>Change the first name, optional last name, or email.</li><li>Save.</li></ol>
<p>The phone number is the customer's verified sign-in identifier and cannot be changed by a merchant from this screen.</p>
<h2>Reviews are visible, not moderated here</h2>
<p>The profile can show reviews that the customer submitted. StoreMink does not currently provide a merchant review-approval or removal workflow, so do not promise moderation controls from this page.</p>$article$,
    'Manage StoreMink customer profiles and activity',
    'Search and filter StoreMink customers, view profile reviews and blog submissions, edit permitted details, and understand phone and order-history limits.',
    1
  ),
  (
    'customers',
    'understand-customer-order-and-content-history',
    'Understand customer order and content history',
    'Know where merchants and signed-in shoppers see orders, reviews, blog submissions, notifications, and store credit.',
    $article$<h2>Merchant view</h2>
<p>The dashboard customer profile shows the customer's reviews and blog submissions. To find purchases, open <strong>Orders</strong> and search or filter the order workspace. Customer profiles do not currently combine all orders into one merchant-facing history view.</p>
<h2>Customer view</h2>
<p>A signed-in shopper can open their storefront account to see their own orders, order detail and status, invoices, safe shipment tracking, notifications, saved addresses, and store-credit balance and history when applicable.</p>
<h2>Website and in-store history</h2>
<p>A website order is attached to the signed-in customer. An in-store sale appears in customer history only when the POS operator attached that customer. If a walk-in later creates an account with the same verified phone number, StoreMink can claim the matching in-store profile and connect its history.</p>
<h2>Store-scoped access</h2>
<p>Customers see only records that belong to their identity on the current store. A guessed order URL does not expose another customer's order.</p>$article$,
    'Customer order and activity history in StoreMink',
    'Understand where StoreMink merchants and customers see orders, reviews, blog submissions, notifications, addresses, store credit, and linked POS history.',
    2
  ),
  (
    'customers',
    'create-and-manage-customer-groups',
    'Create and manage customer groups',
    'Build manual customer segments and use them to target coupon eligibility and coupon email campaigns.',
    $article$<h2>Create a group</h2>
<ol><li>Open <strong>Customers → Groups</strong>.</li><li>Select <strong>New group</strong>.</li><li>Enter a name, optional description, and badge colour.</li><li>Create the group.</li></ol>
<h2>Add or remove members</h2>
<ol><li>Open the group.</li><li>Select its member-management action.</li><li>Search the customer list and select or clear customers.</li><li>Save members.</li></ol>
<h2>Use a group with a coupon</h2>
<p>Open or create a coupon and choose one or more allowed customer groups. A group-restricted coupon requires the shopper to sign in so StoreMink can verify membership.</p>
<h2>Use a group for email</h2>
<p>On Pro, a coupon email campaign can target one customer group. The send uses customer accounts with email addresses; it does not use newsletter-form subscriptions.</p>
<h2>Deleting a group</h2>
<p>Before deleting a group, reassign or disable every active coupon that uses it and review planned campaigns. Deleting the group removes its coupon links; if that was a coupon's last selected group, the coupon becomes public and any eligible shopper can use it. Deleting membership does not delete the customer account.</p>$article$,
    'Create and manage StoreMink customer groups',
    'Create StoreMink customer groups, choose members, target coupon eligibility and Pro coupon email campaigns, and understand signed-in restrictions.',
    3
  ),
  (
    'customers',
    'manage-storefront-enquiries',
    'Manage storefront enquiries',
    'Find messages submitted through the storefront form, reply by email, move them through a clear status, and delete them when appropriate.',
    $article$<h2>Find an enquiry</h2>
<ol><li>Open <strong>Customers → Enquiries</strong>.</li><li>Search by message or customer details.</li><li>Filter by status, subject, or date range.</li><li>Sort with new items first, newest first, or oldest first.</li><li>Open the enquiry.</li></ol>
<h2>Work through the enquiry</h2>
<ul><li><strong>New</strong> means nobody has begun handling it.</li><li><strong>In progress</strong> means a team member is working on it.</li><li><strong>Resolved</strong> means the question has been handled.</li><li><strong>Archived</strong> keeps an old item out of the active queue.</li></ul>
<p>Select <strong>Reply via email</strong> to open your email app with a subject. StoreMink does not send the reply from the Enquiries page, so return and update the status after replying.</p>
<h2>Permissions and deletion</h2>
<p>A role with Enquiries view access can read messages. Manage access is required to change status or delete. Deletion is permanent, so prefer Archived when the message may still be useful.</p>$article$,
    'Manage StoreMink storefront enquiries',
    'Search and filter StoreMink enquiries, reply by email, use New In progress Resolved and Archived statuses, and understand permissions and deletion.',
    4
  ),
  (
    'customers',
    'understand-customer-accounts-and-saved-addresses',
    'Understand customer accounts and saved addresses',
    'Learn what shoppers can manage in their storefront profile and which account data is visible to merchant staff.',
    $article$<h2>Customer account</h2>
<p>A shopper signs in on the storefront and completes a profile with their name, verified phone, and optional email. Their account is scoped to the current store and gives them access to their own orders, notifications, addresses, and store credit.</p>
<h2>Saved address book</h2>
<p>A signed-in customer can save an address during checkout or manage addresses from Profile. The first saved address becomes the default automatically. Adding, selecting, or using a later address at checkout does not make it the default. To change the address preselected at the next checkout, open Profile and select <strong>Set default</strong> on that address. Customers can add, edit, set a default, or delete only their own addresses.</p>
<h2>What merchants can see</h2>
<p>The Customers page shows basic profile details, not the customer's private saved-address book. A completed order stores the delivery address snapshot needed to fulfil that order, and authorised order staff can see it in the order.</p>
<h2>Profile changes</h2>
<p>A customer can update their own name and email. Merchant staff with Customers manage access can edit those fields from the dashboard, but cannot change the verified phone number.</p>
<h2>Protect account data</h2>
<p>Never ask a customer to share their password, one-time code, or payment credentials. Use the order reference and the minimum contact information needed to resolve the request.</p>$article$,
    'StoreMink customer accounts and saved addresses',
    'Understand StoreMink customer profiles, verified phone login, saved address books, order address snapshots, merchant visibility, and privacy boundaries.',
    5
  ),
  (
    'customers',
    'customer-data-permissions-location-scope-and-privacy',
    'Customer data permissions, location scope, and privacy',
    'Give staff only the access they need and understand which customer information is store-wide rather than tied to one shop.',
    $article$<h2>Customers and enquiries use separate permissions</h2>
<p>In <strong>Settings → Roles &amp; permissions</strong>, Customers and Enquiries are separately protected sections even though Enquiries appears under Customers in the navigation. Give View or Manage access only to staff who need it.</p>
<h2>Customer profiles are store-wide</h2>
<p>Customer accounts are associated with the store, not a single location. A staff member's location assignment does not narrow the Customers directory. Staff who can view Customers can see the store-wide profile list; order and inventory pages apply their own location scope.</p>
<h2>Saved addresses remain customer-owned</h2>
<p>Merchant customer profiles do not expose the shopper's saved-address book. Staff see an address when it is part of an order they are authorised to fulfil.</p>
<h2>Use and share the minimum data</h2>
<p>Search by contact detail only for a business task, avoid copying private information into notes or chat, and do not export customer data through unsupported workarounds. Customer CSV import and export are not currently available.</p>
<h2>Review permissions regularly</h2>
<p>Remove access when a staff member changes duties, suspend people who no longer work for the business, and use Activity logs to investigate sensitive dashboard actions.</p>$article$,
    'StoreMink customer privacy permissions and location scope',
    'Understand StoreMink Customers and Enquiries permissions, store-wide customer visibility, location scope, saved-address privacy, and data minimisation.',
    6
  ),
  (
    'customers',
    'protect-customer-data-and-understand-deletion-risk',
    'Protect customer data and understand deletion risk',
    'Understand the current permanent-deletion risk and protect required order, invoice, tax, and customer records before taking action.',
    $article$<p><strong>Important:</strong> Customer deletion is permanent. In the current StoreMink data model it can remove the customer's login and linked records, including account-linked orders, reviews, blog submissions, addresses, and group membership. It cannot be undone from the dashboard.</p>
<h2>Contact support before deleting</h2>
<p>Do not use deletion as a routine way to clean up a duplicate, remove someone from marketing, or hide an old customer. Contact <strong>support@storemink.com</strong> before deleting when the customer has ordered, received an invoice, paid tax, received a refund, or has any record the business may be required to retain.</p>
<h2>Use a safer action when possible</h2>
<ul><li>Remove the customer from a marketing group instead of deleting the account.</li><li>Correct the name or email from the customer profile.</li><li>Keep historical orders and invoices for the legally required period.</li><li>Limit staff access with roles rather than deleting customer records.</li></ul>
<h2>Respond to a privacy request carefully</h2>
<p>Verify the requester's identity, determine which records must be retained by law, record the decision, and obtain appropriate privacy or legal advice. Export or securely retain required invoices and order evidence before any irreversible action.</p>
<h2>Current Help Centre limitation</h2>
<p>Because deletion can cascade into order records, this guide intentionally does not provide click-by-click deletion instructions. Ask StoreMink Support to help assess the account and the safest available action.</p>$article$,
    'StoreMink customer deletion and privacy risk',
    'Understand StoreMink customer deletion risk, linked order removal, safer alternatives, legal retention, privacy requests, and when to contact support.',
    7
  )
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT help_category.id,
       documents.slug,
       documents.title,
       documents.excerpt,
       documents.body,
       'published',
       documents.seo_title,
       documents.seo_description,
       documents.position,
       now()
FROM documents
JOIN help_category ON help_category.slug = documents.category_slug
ON CONFLICT (slug) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  title = EXCLUDED.title,
  excerpt = EXCLUDED.excerpt,
  body = EXCLUDED.body,
  status = EXCLUDED.status,
  seo_title = EXCLUDED.seo_title,
  seo_description = EXCLUDED.seo_description,
  position = EXCLUDED.position,
  published_at = COALESCE(existing.published_at, EXCLUDED.published_at),
  updated_at = now();
