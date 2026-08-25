-- Publish the Getting started and Account & billing Help Centre foundations.
-- These guides describe shipped merchant workflows only. Help content remains
-- database-backed and operator-editable; this migration gives every environment
-- the same reviewed baseline without creating a second documentation source.

-- Remove two empty articles that were created while the operator editor was
-- being tested. Match the exact global slugs so no legitimate guide is touched.
DELETE FROM public.help_articles
WHERE slug IN ('testing', 'testting');

WITH getting_started_category AS (
  SELECT id
  FROM public.help_categories
  WHERE slug = 'getting-started'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT getting_started_category.id,
       document.slug,
       document.title,
       document.excerpt,
       document.body,
       'published',
       document.seo_title,
       document.seo_description,
       document.position,
       now()
FROM getting_started_category
CROSS JOIN (VALUES
  (
    'create-your-storemink-store',
    'Create your StoreMink store',
    'Create a free StoreMink account, verify your email and phone, add your business address, choose a theme, and open your dashboard.',
    $article$<p>StoreMink guides you through one step at a time. You create the store on the Free plan first, so you do not need to enter payment details during signup.</p>
<h2>Before you begin</h2>
<ul><li>Use an email address and phone number that you can verify now.</li><li>Keep your complete business address ready, including state and PIN code.</li><li>Choose a short store name. StoreMink uses it to create your free StoreMink address.</li><li>Read and accept the Terms, Privacy Policy, and Acceptable Use Policy.</li></ul>
<h2>Create the account</h2>
<ol><li>Open <strong>storemink.com</strong> and select <strong>Create your store</strong>.</li><li>Enter your email address.</li><li>Create a password, or select <strong>Continue with Google</strong>.</li><li>If you used a password, enter the six-digit code sent to your email. The code expires after 10 minutes.</li><li>Verify your phone number with the SMS code.</li><li>Enter your first and last name.</li></ol>
<p>A Google account with a verified email skips only the email-code step. Phone verification is still required. Never share an email or phone code with anyone.</p>
<h2>Create the store</h2>
<ol><li>Enter the store name and check the suggested StoreMink address.</li><li>Add the complete business location. You can type every field even when map or location suggestions are unavailable.</li><li>Choose a starting theme. The theme gives you an editable starting design; it does not lock your future changes.</li><li>Select <strong>Create my free store</strong>.</li><li>Wait for StoreMink to open the new store dashboard.</li></ol>
<h2>If signup stops</h2>
<ul><li>Use <strong>Start signup again</strong> if the signed-in account was deleted or cannot be refreshed.</li><li>If an email is already registered, StoreMink may sign in to that account so you can continue safely.</li><li>Allow pop-ups for Google sign-in and complete the phone reCAPTCHA when asked.</li><li>Do not repeatedly request codes. Temporary sending and attempt limits protect the account.</li></ul>
<p>After the dashboard opens, follow <a href="/help/getting-started/complete-your-store-setup">Complete your store setup</a>.</p>$article$,
    'Create a free StoreMink store',
    'Create a StoreMink account, verify email and phone, add a business address, choose a theme, and open your free store dashboard.',
    1
  ),
  (
    'complete-your-store-setup',
    'Complete your store setup',
    'Use a simple setup order for products, branding, checkout, shipping, policies, notifications, and storefront checks before launch.',
    $article$<p>Your store is usable as soon as signup finishes, but a few setup checks prevent most first-order problems. Complete the jobs below in order and save each page before moving on.</p>
<h2>1. Confirm the store identity</h2>
<ol><li>Open <strong>Branding</strong>.</li><li>Check the store name, logo, colours, contact details, and business identity used on customer-facing material.</li><li>Open <strong>Settings</strong>, then <strong>Account</strong>, and confirm your own name and verified phone.</li></ol>
<h2>2. Add something to sell</h2>
<ol><li>Open <strong>Products</strong> and create the first product.</li><li>Add its price, images, variants, tax details, shipping measurements, and supplier barcode where they apply. StoreMink generates the permanent StoreMink SKU for you.</li><li>If you track stock, enter a sensible starting quantity and backorder choice.</li></ol>
<p>See <a href="/help/getting-started/add-your-first-product-and-check-the-storefront">Add your first product and check the storefront</a> for the quick workflow.</p>
<h2>3. Prepare the website</h2>
<ol><li>Open <strong>Website Builder</strong>.</li><li>Review the Home page, header, footer, menus, and contact links.</li><li>Preview desktop and mobile sizes.</li><li>Publish the page and site-wide changes when they are ready. Saving a draft does not publish it.</li></ol>
<h2>4. Prepare checkout and delivery</h2>
<ul><li>Choose the payment methods available on your plan. Cash on Delivery can work without connecting an online gateway.</li><li>Open <strong>Settings</strong>, then <strong>Shipping &amp; delivery</strong>, and configure the delivery charge and promise shown to customers.</li><li>Check the business, GST, tax, and invoice details used on orders and documents.</li><li>Confirm that at least one active location can fulfil online orders.</li></ul>
<h2>5. Prepare customer communication</h2>
<ol><li>Open <strong>Settings</strong>, then <strong>Notifications</strong>.</li><li>Review customer order messages and the team members who receive operational alerts.</li><li>Add or review the privacy, returns, shipping, and other policies that apply to your business.</li></ol>
<h2>Before calling the store ready</h2>
<p>Open <strong>My Store</strong> and check the complete shopping journey as a customer. Verify prices, stock, delivery information, policy links, contact details, and mobile layout. Features that require a higher plan remain unavailable until the plan is active; StoreMink does not delete existing data when a plan is lowered.</p>
<p>If a page or setting is missing, your dashboard role may not have permission to view it. Ask a superadmin before repeating setup or creating duplicate data.</p>$article$,
    'Complete your StoreMink store setup',
    'Prepare StoreMink products, branding, website, checkout, shipping, policies, notifications, and storefront checks before launch.',
    2
  ),
  (
    'understand-your-storemink-dashboard',
    'Understand your StoreMink dashboard',
    'Learn how dashboard navigation, search, permissions, location scope, store switching, and page errors work.',
    $article$<p>The StoreMink dashboard is the private workspace for running one store. What you see depends on your role, permissions, and assigned locations.</p>
<h2>Open the dashboard</h2>
<p>Sign in on your store address and open <strong>/dashboard</strong>. The top bar shows the current store and gives you a link to <strong>My Store</strong>. A custom domain has its own browser session, so the first visit there can ask you to sign in again.</p>
<h2>Use the navigation</h2>
<ul><li><strong>Workspace</strong> contains everyday work such as orders, products, customers, and analytics.</li><li><strong>Sell in person</strong> contains locations and Point of Sale tools when the store and plan support them.</li><li><strong>Storefront</strong> contains the Website Builder, blogs, branding, and media.</li><li><strong>Marketing</strong> contains coupons and coupon email campaigns.</li><li><strong>Settings</strong> contains account, payments, shipping, domains, notifications, policies, and other store controls.</li></ul>
<p>Some areas are nested under a related job. Open the parent item to see them. A link that your role cannot use is removed instead of leading to a page you cannot manage.</p>
<h2>Find a page quickly</h2>
<ol><li>Select the search box in the top bar, or press the keyboard shortcut shown inside it.</li><li>Type a page or job, such as Products, Returns, or Notifications.</li><li>Choose a result. Search includes only pages allowed by your current permissions.</li></ol>
<h2>Understand permissions and locations</h2>
<p>A role can grant <strong>View</strong>, <strong>Manage</strong>, both, or no access for each dashboard section. Manage includes the ability to change data. Location assignments can further limit orders, inventory, analytics, and other location-shaped data. For non-superadmins, leaving every location unticked means unrestricted access to all locations; it does not mean no access.</p>
<h2>If the dashboard looks wrong</h2>
<ul><li>If only some pages are missing, ask a superadmin to check your role.</li><li>If one shop is missing, ask a superadmin to check your location access.</li><li>If you are sent to <strong>Set password</strong>, finish the required first-login password change.</li><li>If the page reports a service problem, retry later. A database problem should not be treated as a permission decision.</li><li>Confirm the browser address belongs to the intended store before changing data.</li></ul>
<p>For personal details and security, see <a href="/help/account/update-your-account-profile-and-security">Update your account profile and security</a>.</p>$article$,
    'Understand the StoreMink dashboard',
    'Use StoreMink dashboard navigation and search, understand permissions and location scope, and resolve missing pages or access problems.',
    3
  ),
  (
    'add-your-first-product-and-check-the-storefront',
    'Add your first product and check the storefront',
    'Create a sellable product, add images and inventory, save it, and confirm what shoppers see on desktop and mobile.',
    $article$<p>A product needs clear customer information and a valid selling price before it is useful. Add one complete product first, check it on the storefront, and then use the same pattern for the rest of the catalogue.</p>
<h2>Create the product</h2>
<ol><li>From the dashboard, open <strong>Products</strong>.</li><li>Select <strong>Add product</strong>.</li><li>Enter a clear title and description.</li><li>Add the selling price. Cost per unit appears only when the store is on Pro and StoreMink has enabled gross-margin analytics; add it there when available.</li><li>Upload useful images and choose the appropriate category and colour information.</li><li>Add variants when customers need choices such as size or colour.</li><li>Save the product, note its permanent StoreMink SKU, and add an editable supplier barcode when your team uses one.</li></ol>
<h2>Set inventory behaviour</h2>
<ul><li>Turn on inventory tracking when StoreMink should limit sales to recorded stock.</li><li>Enter stock at the correct location and variant.</li><li>Set a low-stock threshold if you want an earlier warning.</li><li>Allow backorders only when the business can accept orders beyond current stock.</li></ul>
<p>Older carts are checked again at checkout. StoreMink can reduce or remove a cart line when live stock changed, and the final stock claim still prevents overselling.</p>
<h2>Check the customer view</h2>
<ol><li>Select <strong>My Store</strong>.</li><li>Open the Shop and select the new product.</li><li>Check the title, images, price, variant choices, stock message, quantity controls, delivery check, and Add to cart action.</li><li>Repeat the check at a narrow mobile width.</li></ol>
<h2>If the product is missing or cannot be bought</h2>
<ul><li>Confirm the product was saved and is available to the storefront.</li><li>Check that the selected variant exists and has a valid price.</li><li>Check live stock, inventory tracking, and backorder settings at the fulfilment location.</li><li>If a shopper kept an old cart open, ask them to refresh so it can reconcile with current stock.</li></ul>
<p>After the product works, continue with <a href="/help/getting-started/prepare-your-store-for-the-first-order">Prepare your store for the first order</a>.</p>$article$,
    'Add your first product in StoreMink',
    'Create a StoreMink product with images, price, variants, SKU and inventory, then verify the desktop and mobile storefront.',
    4
  ),
  (
    'prepare-your-store-for-the-first-order',
    'Prepare your store for the first order',
    'Check payment, tax, shipping, inventory, policies, notifications, and the customer journey before accepting orders.',
    $article$<p>Before sharing the store, check the parts that decide whether an order can be priced, paid, fulfilled, and explained to the customer. This is a readiness check, not a substitute for your own legal or tax advice.</p>
<h2>Check who can order</h2>
<ul><li>Open the published storefront, not only the Website Builder preview.</li><li>Confirm shoppers can sign in, add products, change quantities, and open checkout.</li><li>Check that sold-out and low-stock products show the intended message.</li><li>Use a real delivery PIN code to check availability and the delivery promise.</li></ul>
<h2>Check payment and tax</h2>
<ol><li>Confirm Cash on Delivery and any connected online payment method are configured as intended.</li><li>If using Razorpay, make sure the store connection is enabled and belongs to the correct business account.</li><li>Review GST details, tax classes, invoice identity, prefixes, and customer GSTIN handling.</li><li>Remember that online payments and some other capabilities depend on the active plan and platform availability.</li></ol>
<h2>Check fulfilment</h2>
<ul><li>Keep one active location able to fulfil online orders.</li><li>Confirm the business and pickup address is complete.</li><li>Review fixed, free, or live shipping settings and any free-delivery threshold.</li><li>If using Shiprocket, verify the connected account, synced pickup location, parcel measurements, and webhook status. Do not rely on merchant-account rates, booking, or webhook updates for customer parcels until a controlled live test succeeds in that account.</li><li>Check the published return and cancellation policies and the pickup choices customers can actually see.</li></ul>
<h2>Check communication and records</h2>
<ol><li>Open <strong>Settings</strong>, then <strong>Notifications</strong>.</li><li>Review customer order emails and team recipients.</li><li>Publish the store policies and make them reachable from navigation.</li><li>Confirm the business email and phone shown to customers are monitored.</li></ol>
<h2>Final checks</h2>
<p>Use the storefront as a customer on both phone and computer. If you place a real order to test an external payment, use an amount and method you are prepared to settle, then handle the order through the normal cancellation or refund workflow. Never mark a payment successful merely to make a test pass.</p>
<p>If checkout refuses the order, read the exact message first. Common causes are changed stock, a missing address, an unavailable shipping choice, a disabled payment channel, a plan restriction, or a payment still awaiting confirmation.</p>$article$,
    'Prepare StoreMink for the first order',
    'Check StoreMink payments, GST, shipping, inventory, policies, notifications, and the customer journey before accepting orders.',
    5
  ),
  (
    'troubleshoot-signup-login-and-store-access',
    'Troubleshoot signup, login, and store access',
    'Fix common email-code, phone-verification, Google sign-in, password, session, store-address, and dashboard-access problems.',
    $article$<p>Signup and login protect both the account and the store. Use the message on screen to choose the correct fix, and avoid creating a second account just to work around a temporary problem.</p>
<h2>The email code did not arrive</h2>
<ul><li>Check spam and confirm the address before requesting another code.</li><li>Use only the newest six-digit code. It expires after 10 minutes and wrong attempts are capped.</li><li>Wait if a temporary sending limit appears.</li><li>For a reserved test address in a non-production environment, an operator may need to read the test email log.</li></ul>
<h2>Phone verification does not start</h2>
<ul><li>Enter the full number with the correct country code.</li><li>Allow the invisible reCAPTCHA and disable a strict blocker temporarily.</li><li>Make sure the number can receive SMS.</li><li>Refresh and request one new code instead of entering several old codes.</li></ul>
<h2>Google sign-in does not open</h2>
<p>Allow pop-ups and make sure the current domain is authorised for StoreMink sign-in. A newly connected custom domain can take time to finish its sign-in setup. Email and password sign-in can still work while Google-domain authorisation is being retried.</p>
<h2>The password does not work</h2>
<ul><li>Use <strong>Forgot password</strong> from the store login page.</li><li>A Google-only account can use the same path to set a password.</li><li>An invited dashboard user must use the temporary password once and then create a new password.</li><li>If the account is suspended, a superadmin must restore access.</li></ul>
<h2>You signed in but see the wrong store or no access</h2>
<ul><li>Check the browser address. Each merchant dashboard belongs to its store host.</li><li>A verified custom domain uses a separate session from the StoreMink subdomain, so sign in once on the new host.</li><li>Ask a superadmin to confirm your dashboard profile, role, and location assignments.</li><li>If signup was interrupted, sign in at storemink.com and let the wizard resume. Use <strong>Start signup again</strong> only when the current identity cannot be recovered.</li></ul>
<h2>Get more help safely</h2>
<p>Ask <a href="/help/getting-started/use-storemink-help-assistant">Mink AI</a> with the page name and the exact message. Do not share passwords, one-time codes, payment secrets, or private customer data. Contact support when the issue needs account-specific investigation.</p>$article$,
    'Troubleshoot StoreMink signup and login',
    'Fix StoreMink email OTP, phone verification, Google sign-in, passwords, sessions, wrong-store access, roles, and location restrictions.',
    6
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

WITH account_category AS (
  SELECT id
  FROM public.help_categories
  WHERE slug = 'account'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT account_category.id,
       document.slug,
       document.title,
       document.excerpt,
       document.body,
       'published',
       document.seo_title,
       document.seo_description,
       document.position,
       now()
FROM account_category
CROSS JOIN (VALUES
  (
    'manage-your-storemink-plan-and-subscription',
    'Manage your StoreMink plan and subscription',
    'Compare live plan limits, choose monthly or yearly billing, change plans, understand timing, cancel, or resume a subscription.',
    $article$<p>The <strong>Plan &amp; billing</strong> page shows the store's effective plan, live prices, subscription status, AI allowance, invoices, and plans available to move to. Prices shown there are the amount StoreMink uses for the payment.</p>
<h2>Compare plans</h2>
<ol><li>Open <strong>Plan &amp; billing</strong>.</li><li>Select <strong>Upgrade plan</strong> or <strong>See upgrade options</strong>.</li><li>Choose monthly or yearly billing.</li><li>Compare the displayed product, staff, AI, domain, payment, campaign, analytics, and branding limits.</li><li>Choose a plan and review the exact amount before authorising Razorpay.</li></ol>
<p>StoreMink creates every new store on Free. AI-credit top-ups require Basic or Pro and are a separate one-time purchase.</p>
<h2>Understand when a change applies</h2>
<ul><li>A change that costs more applies now after the required prorated payment.</li><li>A cheaper or equal-cost change is scheduled for the end of the current paid cycle.</li><li>Changing between monthly and yearly is priced as a real billing change, even when the plan name stays the same.</li><li>Existing subscribers can keep an older price until they choose a change.</li></ul>
<h2>What happens when a limit becomes lower</h2>
<p>StoreMink does not delete products, staff, coupons, locations, or other existing data merely because a plan moved down. It can block creating new items or using a paid capability until usage is within the active limit or the plan is raised.</p>
<h2>Cancel or resume</h2>
<ol><li>Open the current subscription card.</li><li>Select <strong>Cancel subscription</strong> and read the confirmation.</li><li>If a paid cycle is active, the plan remains available until that cycle ends and then moves to Free.</li><li>Before the cycle ends, select <strong>Keep my plan</strong> to remove the scheduled cancellation.</li></ol>
<p>If no paid cycle has started, cancellation stops future payment without promising a period of paid access. Manual-renewal subscriptions do not show an automatic next charge.</p>
<h2>If the change does not complete</h2>
<ul><li>Only a staff member with billing management permission can authorise payment or change the subscription.</li><li>Resolve any open invoice shown at the top of the page.</li><li>Do not pay again when Razorpay captured money but StoreMink is still confirming it. Refresh and allow reconciliation first.</li><li>A halted or pending subscription may need its payment problem resolved before another change.</li></ul>
<p>See <a href="/help/account/view-and-pay-storemink-invoices">View and pay StoreMink invoices</a> for invoice steps.</p>$article$,
    'Manage StoreMink plans and subscriptions',
    'Compare StoreMink plans, choose monthly or yearly billing, understand immediate and scheduled changes, cancel, resume, and fix plan payments.',
    1
  ),
  (
    'view-and-pay-storemink-invoices',
    'View and pay StoreMink invoices',
    'Find subscription and AI-credit invoices, pay an amount due, understand processing status, and avoid duplicate payments.',
    $article$<p>StoreMink keeps subscription and AI-credit documents under <strong>Plan &amp; billing</strong>. An amount you currently owe appears above the rest of the page so it is not missed.</p>
<h2>Open invoice history</h2>
<ol><li>Open <strong>Plan &amp; billing</strong>.</li><li>Select <strong>View invoices</strong>.</li><li>Choose an invoice to review its reference, dates, line items, tax, total, and payment status.</li><li>Use the invoice view when you need a printable business document.</li></ol>
<h2>Pay an open subscription invoice</h2>
<ol><li>Return to <strong>Plan &amp; billing</strong>.</li><li>Find the amber message saying that an invoice is due.</li><li>Check the amount, service period, reference, and due date.</li><li>Select <strong>Pay now</strong>.</li><li>Complete the secure Razorpay payment and wait for StoreMink to confirm it.</li></ol>
<p>The button is available only to a staff member who can manage billing. If an invoice stays unpaid after its due date, the store can move to the Free plan until payment is settled.</p>
<h2>Understand common statuses</h2>
<ul><li><strong>Open</strong> means payment is due.</li><li><strong>Processing</strong> means a payment is already with the gateway. StoreMink does not offer a second Pay button.</li><li><strong>Paid</strong> means the invoice is settled.</li><li>An AI-credit invoice is a paid receipt for a separate one-time purchase; it is not subscription debt.</li></ul>
<h2>If payment was taken but the page did not confirm it</h2>
<p>Do not start another payment. Refresh the page and let StoreMink reconcile the existing gateway order. A confirmation problem is not proof that payment failed. Keep the Razorpay reference and contact support if the invoice remains unresolved.</p>
<h2>If the Pay button is unavailable</h2>
<ul><li>Ask a superadmin or a role with billing management access.</li><li>Wait when the invoice says payment is already processing.</li><li>Check that the browser allows the secure payment window.</li><li>Confirm the invoice belongs to the current store before sharing its reference with support.</li></ul>$article$,
    'View and pay StoreMink invoices',
    'Find StoreMink subscription and AI-credit invoices, pay open invoices securely, understand statuses, and avoid duplicate Razorpay payments.',
    2
  ),
  (
    'understand-ai-usage-and-credits',
    'Understand AI usage and credits',
    'Track the monthly AI allowance, buy non-expiring credits, read credit activity, and resolve delayed or blocked AI usage.',
    $article$<p>StoreMink AI can help with product copy, SEO, brand voice, coupon emails, and other supported writing jobs. Every generation uses the store's monthly plan allowance first, then its purchased credit balance.</p>
<h2>Check monthly usage</h2>
<ol><li>Open <strong>Plan &amp; billing</strong>.</li><li>Find <strong>AI usage this month</strong>.</li><li>Review the number used, the plan allowance, and the remaining amount.</li><li>Check the reset countdown. The monthly allowance resets at the start of the next UTC calendar month.</li></ol>
<p>The allowance depends on the effective plan and is enforced for the whole store, not separately for each staff member.</p>
<h2>How purchased credits work</h2>
<ul><li>Credits are used only after the monthly allowance runs out.</li><li>Purchased and granted credits do not expire.</li><li>Top-ups are available on Basic and Pro.</li><li>A credit top-up is a separate one-time Razorpay payment and receives its own paid invoice.</li><li>Credits belong to the store and are visible to staff with the required billing or AI access.</li></ul>
<h2>Buy credits</h2>
<ol><li>Under <strong>Top up credits</strong>, compare the current packs.</li><li>Select <strong>Buy now</strong> for the required pack.</li><li>Confirm the pack and amount in the secure payment window.</li><li>Wait for the page to refresh and show the new balance.</li></ol>
<h2>Read the activity</h2>
<p><strong>Recent credit activity</strong> shows purchases, operator grants, and generations that spent a credit. The current balance never goes below zero, and a payment reference cannot grant the same pack twice.</p>
<h2>If credits or usage look wrong</h2>
<ul><li>Refresh the page. A dropped payment callback is reconciled when the page is read again.</li><li>If payment was captured, do not buy the pack again while confirmation is pending.</li><li>Check that the store is on Basic or Pro before buying credits.</li><li>Ask a staff member with management permission when the purchase button is disabled.</li><li>An AI provider error and an allowance error are different. Read the message before changing the plan or buying credits.</li></ul>$article$,
    'Understand StoreMink AI usage and credits',
    'Track StoreMink AI allowance, buy non-expiring credit packs, review purchases and spends, and resolve delayed credit payments.',
    3
  ),
  (
    'update-your-account-profile-and-security',
    'Update your account profile and security',
    'Change your name, password, and verified phone number, and understand which login identity changes require StoreMink support.',
    $article$<p>Account settings apply to the signed-in dashboard user, not to every staff member or to the public store identity. Open <strong>Settings</strong>, then <strong>Account</strong>.</p>
<h2>Update your name</h2>
<ol><li>Open the <strong>Profile</strong> tab.</li><li>Edit your first name and optional last name.</li><li>Select <strong>Save changes</strong>.</li></ol>
<p>Your role and login email are shown for reference. The email is tied to the login and cannot be changed by you or a store superadmin from the dashboard. Contact StoreMink support when it must be corrected.</p>
<h2>Change your password</h2>
<ol><li>Open the <strong>Security</strong> tab.</li><li>Enter the current password.</li><li>Enter a new password of at least eight characters.</li><li>Enter it again and select <strong>Update password</strong>.</li></ol>
<p>Use a unique password that is hard to guess. A Google-only user who has no current password can use <strong>Forgot password</strong> on the login page to set one.</p>
<h2>Change your verified phone</h2>
<ol><li>On the <strong>Security</strong> tab, edit the phone number.</li><li>Choose the correct country code and request the SMS code.</li><li>Enter the code to link the number to the account.</li><li>Wait for the dashboard session to refresh with the verified phone.</li></ol>
<p>The browser uses an invisible reCAPTCHA before sending the code. Allow it to run, and never give the code to another person.</p>
<h2>What you cannot change here</h2>
<ul><li>Your dashboard role and permissions are managed under <strong>Roles &amp; permissions</strong> and <strong>Staff</strong>.</li><li>Your assigned store locations are managed by a superadmin.</li><li>The store's customer-facing name, contact details, logo, and business identity belong in Branding or the relevant business settings.</li></ul>
<h2>If saving fails</h2>
<ul><li>Confirm the current password before trying a password change again.</li><li>Use the full international phone number and allow SMS and reCAPTCHA.</li><li>Refresh after a successful phone verification if the old number remains visible.</li><li>If the signed-in account no longer belongs to this store, ask a superadmin to check the Staff list.</li></ul>$article$,
    'Update StoreMink account and security',
    'Update your StoreMink name, password, and verified phone; understand login email, role, location, and store identity controls.',
    4
  ),
  (
    'invite-and-manage-dashboard-staff',
    'Invite and manage dashboard staff',
    'Invite an admin, deliver the temporary login, assign initial access, change roles or locations, suspend access, or remove a user.',
    $article$<p>Dashboard staff are people who can work inside the merchant dashboard. They are different from shoppers in the Customers list. Only a superadmin can invite new dashboard users.</p>
<h2>Invite a user</h2>
<ol><li>Open <strong>Settings</strong>, then <strong>Staff</strong>.</li><li>Select <strong>Invite user</strong>.</li><li>Enter the first name, optional last name, and email address.</li><li>Choose <strong>Admin</strong> or <strong>Superadmin</strong>.</li><li>For a non-superadmin in a multi-location store, tick the shops they should see.</li><li>Select <strong>Send invite</strong>.</li></ol>
<p>StoreMink creates a secure temporary password and sends it to the email address when delivery is configured. The user signs in on the store dashboard and must set a new password on the first visit. Never forward the temporary password through an insecure public channel.</p>
<h2>Understand initial access</h2>
<ul><li>A superadmin has full, unrestricted dashboard and location access.</li><li>An Admin starts with the built-in member role and can later be moved to another saved role.</li><li>For a non-superadmin, ticking shops restricts location-shaped data to those shops.</li><li>Leaving every location unticked means access to every location. It does not mean access to none.</li></ul>
<h2>Change an existing user</h2>
<ol><li>Open the action menu beside the user.</li><li>Choose <strong>Change role</strong>, <strong>Locations</strong>, <strong>Suspend user</strong>, or <strong>Remove user</strong>.</li><li>Review the confirmation and save.</li></ol>
<p>Suspension removes access without deleting the profile. Removal is permanent. StoreMink does not let you manage your own row from that action menu, which prevents an owner from accidentally removing their current access.</p>
<h2>If the invite does not work</h2>
<ul><li>Check that no dashboard user already uses the email address.</li><li>Confirm the inviter is a superadmin and the plan has room for another staff account.</li><li>Review Email logs for the invite result. Sensitive invite bodies and temporary passwords are not stored in that log.</li><li>Ask the user to check spam and open the dashboard on the same store host named in the invitation.</li><li>If location assignment failed after account creation, the user can be unrestricted; review the Locations action immediately.</li></ul>
<p>For finer access, see <a href="/help/account/create-roles-permissions-and-location-access">Create roles, permissions, and location access</a>.</p>$article$,
    'Invite and manage StoreMink dashboard staff',
    'Invite StoreMink dashboard admins, assign roles and shops, deliver first-login credentials, suspend access, or remove a staff user.',
    5
  ),
  (
    'create-roles-permissions-and-location-access',
    'Create roles, permissions, and location access',
    'Create custom dashboard roles, choose View and Manage access, assign them to staff, and restrict non-superadmins to selected shops.',
    $article$<p>Roles decide which dashboard jobs a staff member can see or change. Location access separately decides which shops are included in location-shaped data.</p>
<h2>Create a role</h2>
<ol><li>Open <strong>Roles &amp; Permissions</strong>.</li><li>Select <strong>New role</strong>.</li><li>Enter a short name and useful description.</li><li>Choose a colour so the role is easy to recognise.</li><li>For each dashboard section, tick <strong>View</strong>, <strong>Manage</strong>, both, or neither.</li><li>Save the role.</li></ol>
<p>Granting Manage also grants View. Removing View removes Manage because a person cannot safely change a page they cannot open.</p>
<h2>System and custom roles</h2>
<ul><li><strong>Superadmin</strong> is a system role with full access. Its permissions and location scope cannot be narrowed.</li><li>Other system roles provide a safe starting point.</li><li>Custom roles can be edited or deleted. Reassign every user before deleting a role that is in use.</li></ul>
<h2>Assign a role</h2>
<ol><li>Open <strong>Settings</strong>, then <strong>Staff</strong>.</li><li>Open the action menu for the staff member.</li><li>Select <strong>Change role</strong>.</li><li>Choose the saved role and confirm.</li></ol>
<h2>Set location access</h2>
<ol><li>On the same user action menu, select <strong>Locations</strong>.</li><li>Tick every shop the person should see.</li><li>Save the change.</li></ol>
<p>The Locations action appears only when the store has more than one location and the user is not a superadmin. For non-superadmins, no shops ticked means unrestricted access to all shops. Supported lists and workflows use the assigned shops to narrow location data. If a restricted staff member can open an order or cancellation from a shop they were not assigned, treat that as an access problem: do not act on it, record the order reference, and contact StoreMink support.</p>
<h2>Troubleshoot access</h2>
<ul><li>If a page is missing, check the role's section permission.</li><li>If the page opens but actions are disabled, check whether the role has Manage, not only View.</li><li>If a shop is missing, check the user's location assignments.</li><li>If all shops appear unexpectedly, remember that an empty location selection means unrestricted.</li><li>After a role change, ask the user to refresh or sign in again if an older session still shows the previous navigation.</li></ul>$article$,
    'Create StoreMink roles and location access',
    'Create StoreMink dashboard roles, assign View and Manage permissions, apply roles to staff, and restrict access to selected locations.',
    6
  ),
  (
    'manage-store-and-personal-notifications',
    'Manage store and personal notifications',
    'Configure team and customer messages, channels, recipients, templates and digests, then set your own staff opt-outs.',
    $article$<p>StoreMink records important activity first, then sends notifications only for events and audiences that have a delivery rule. Team messages and customer messages are configured separately because they have different recipients and wording.</p>
<h2>Open notification settings</h2>
<ol><li>Open <strong>Settings</strong>, then <strong>Notifications</strong>.</li><li>Choose <strong>Customer notifications</strong> when you want to review what shoppers receive.</li><li>Choose <strong>Team notifications</strong> when you want to decide which staff are alerted.</li><li>Open <strong>All notifications</strong> to search or filter every event.</li></ol>
<h2>Configure one notification</h2>
<ol><li>Select the event, such as an order or fulfilment update.</li><li>Choose the <strong>Team</strong> or <strong>Customer</strong> audience.</li><li>Enable only the available delivery channels.</li><li>For team delivery, choose recipients or routing and a digest setting when offered.</li><li>Edit the permitted template fields and use only the variables shown on the page.</li><li>Preview or send a test email when available, then save.</li></ol>
<p>Customer routing identifies the shopper from the event. Team routing can target store staff. Some safety-critical events are always on and cannot be disabled. SMS also needs an active store connection and an approved DLT template whose text matches the registered template.</p>
<h2>Manage your own notifications</h2>
<ol><li>Open <strong>My notifications</strong>.</li><li>Turn your own in-app or email delivery on or off for configurable team events.</li><li>Save the preferences.</li></ol>
<p>Every dashboard user can manage their own opt-outs, even when they cannot change store-wide notification settings. A personal opt-out never redirects another person's message and does not stop required customer communication.</p>
<h2>If messages do not arrive</h2>
<ul><li>Review the delivery warning on the Notifications overview.</li><li>Check the audience, channel, recipient rule, personal opt-out, and event-specific template.</li><li>Open Email logs or SMS logs to see whether StoreMink tried to send it.</li><li>Confirm the customer or staff contact detail is valid.</li><li>For SMS, check the provider connection, DLT entity and template approval, variables, and Twilio balance. The current StoreMink log records only the initial send attempt, so inspect Twilio when final carrier delivery must be confirmed.</li></ul>
<p>See <a href="/help/account/use-activity-email-sms-and-failure-logs">Use activity, email, SMS, and failure logs</a> when delivery needs investigation.</p>$article$,
    'Manage StoreMink notifications',
    'Configure StoreMink team and customer notification channels, recipients, templates and digests, and manage personal staff opt-outs.',
    7
  ),
  (
    'use-activity-email-sms-and-failure-logs',
    'Use activity, email, SMS, and failure logs',
    'Find who changed something, inspect message send attempts, review import and export history, and investigate failed operations.',
    $article$<p>The Logs workspace keeps operational evidence in one place. All log pages use the same <strong>Activity</strong> permission, but each answers a different question.</p>
<h2>Choose the right log</h2>
<ul><li><strong>Activity</strong> shows what happened in the store, who did it, and when.</li><li><strong>Email logs</strong> show each initial send attempt and the stored message details when the mailer is not sensitive. Sent means the email provider accepted StoreMink's request; it does not prove inbox delivery, and a later bounce does not change that log row.</li><li><strong>SMS logs</strong> show each send attempt, its initial Twilio result, sender, body, segment count, and initial error. The segment count provides provider-cost context; this log does not prove a final carrier charge or handset delivery.</li><li><strong>Import logs</strong> show files brought in and row-level results.</li><li><strong>Export logs</strong> show files taken out and their row counts.</li><li><strong>Failures</strong> combines recent problems from supported payment, email, shipping, import, subscription, and other operational sources.</li></ul>
<h2>Investigate a change</h2>
<ol><li>Open <strong>Logs</strong>, then <strong>Activity</strong>.</li><li>Find the event around the time the change happened.</li><li>Read the actor, subject, location, and safe event details.</li><li>Use the related resource page to confirm the current state.</li></ol>
<p>The activity feed is an audit trail, not an undo button. Some events create staff or customer notifications; audit-only events remain in Activity without creating a badge.</p>
<h2>Investigate a message</h2>
<ol><li>Open <strong>Email logs</strong> or <strong>SMS logs</strong>.</li><li>Find the recipient and time.</li><li>Review the sent, skipped, failed, or initial provider result.</li><li>For an initial failure, correct the address, phone, connection, template, or provider issue before retrying the business action.</li></ol>
<p>Sensitive emails such as staff invitations record send-attempt metadata without storing the temporary password or full body. Do not repeat an email or SMS solely because the recipient has not seen it; confirm the provider state first so the person does not receive a duplicate.</p>
<h2>Investigate a failure</h2>
<ol><li>Open <strong>Failures</strong>.</li><li>Filter or locate the affected operation.</li><li>Read the source, store-safe reason, and whether manual review is required.</li><li>Follow the owning workflow. Do not repeat a payment or booking simply because its first response was unknown.</li></ol>
<h2>Import a CSV safely</h2>
<ol><li>Open <strong>Products</strong>, <strong>Categories</strong>, <strong>Inventory</strong>, or <strong>Coupons</strong>. These resources support both import and export; Orders is export-only.</li><li>Download or follow the current StoreMink column format and try a small file before changing many existing records.</li><li>Choose the import action, review the preview and matching behaviour, then start the job. A CSV can contain up to 50,000 rows and be up to 25 MB.</li><li>Wait for its final result before uploading the same file again.</li><li>Open <strong>Import logs</strong>, select the job, and review created, updated, skipped, and failed counts.</li><li>Correct the named column or value and import only the failed rows when possible.</li></ol>
<p>Keep identifiers such as SKU, slug, email, or order reference unchanged when StoreMink uses them to match existing records. Do not add formulas, scripts, passwords, gateway secrets, or unrelated private data to a file. StoreMink validates each chunk on the server and applies each row atomically. <strong>Finished with errors</strong> means valid rows succeeded, so blindly repeating the whole file can duplicate or overwrite work.</p>
<h2>Export and find a file</h2>
<ol><li>Open the resource page and apply the intended filters.</li><li>Choose Export.</li><li>Open <strong>Export logs</strong> to find the job status and row count.</li></ol>
<h2>Fix import or export problems</h2>
<ul><li>Check the file type, required headings, duplicate identifiers, dates, numbers, and values outside the allowed list.</li><li>Use the row-level error instead of guessing from the overall status.</li><li>Confirm your role can manage the resource. The logs permission does not bypass the source page's permission.</li><li>Do not retry a running or partial job until you know which rows already changed.</li><li>If processing stopped between chunks, keep the job reference and recorded state when contacting support.</li></ul>
<h2>Permissions and limits</h2>
<p>A user needs Activity access to read the store logs. Starting an import or export also requires the applicable source-page permission. Logs are scoped to the current store, but the current Activity, Email, SMS, and failure-log reads are not narrowed to the staff member's assigned locations and may expose evidence from other shops in that store. Grant Activity access only to staff who may review store-wide operational evidence. Retention differs by log type, so export evidence required for long-term business or legal records according to your policy.</p>$article$,
    'Use StoreMink activity and failure logs',
    'Use StoreMink activity, email, SMS, import, export, and failure logs to investigate changes, send attempts, and operational problems.',
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
