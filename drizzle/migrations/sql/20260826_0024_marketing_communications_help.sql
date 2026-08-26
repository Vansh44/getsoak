-- Complete the merchant-facing Help Centre coverage for marketing, blogs,
-- customer communication, and India DLT-compliant SMS. These are forward-only
-- content rows; operators may refine them later in the Help console.

-- This slug appeared only in an unreleased draft of this migration and implied
-- final carrier delivery that StoreMink does not ingest. Remove it if that
-- draft was ever run manually before publishing the accurate send-attempt URL.
DELETE FROM public.help_articles
WHERE slug = 'read-sms-delivery-logs';

UPDATE public.help_categories AS category
SET title = taxonomy.title,
    description = taxonomy.description,
    icon = taxonomy.icon,
    position = taxonomy.position,
    updated_at = now()
FROM (VALUES
  ('getting-started', 'Getting started', 'Create your store, learn the dashboard, and prepare to welcome customers.', 'Rocket', 1),
  ('storefront', 'Setting up your store', 'Build pages, choose your look, manage navigation, media, policies, and your domain.', 'LayoutTemplate', 2),
  ('products', 'Products & inventory', 'Create products and variants, organize the catalog, import data, and keep stock accurate.', 'Package', 3),
  ('customers', 'Customers & enquiries', 'Understand customer profiles, groups, accounts, enquiries, and data access.', 'Users', 4),
  ('point-of-sale', 'Point of Sale', 'Set up registers, sell in store, manage tills, stock, pickups, shifts, returns, and receipts.', 'ScanLine', 5),
  ('payments', 'Payments, GST & COD', 'Take payments, connect Razorpay, configure tax, issue invoices, refunds, and store credit.', 'IndianRupee', 6),
  ('domains', 'Domains', 'Use your StoreMink address or connect, verify, and troubleshoot a custom domain.', 'Globe', 7),
  ('orders', 'Orders, locations & shipping', 'Manage orders, locations, cancellations, pickup, fulfilment, shipping, and delivery problems.', 'Truck', 8),
  ('marketing', 'Marketing, blogs & communication', 'Create coupons, send targeted offers, publish content, and configure customer messages.', 'Megaphone', 9),
  ('account', 'Account, staff & billing', 'Manage your plan, StoreMink invoices, account security, staff, permissions, notifications, and logs.', 'CreditCard', 10),
  ('analytics', 'Analytics & reports', 'Understand sales, customers, inventory, search visibility, conversion, margin, and reports.', 'ChartNoAxesCombined', 11)
) AS taxonomy(slug, title, description, icon, position)
WHERE category.slug = taxonomy.slug;

WITH marketing_category AS (
  SELECT id
  FROM public.help_categories
  WHERE slug = 'marketing'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT marketing_category.id,
       guide.slug,
       guide.title,
       guide.excerpt,
       guide.body,
       'published',
       guide.seo_title,
       guide.seo_description,
       guide.position,
       now()
FROM marketing_category
CROSS JOIN (VALUES
  (
    'create-and-manage-coupons',
    'Create and manage coupons',
    'Create percentage or fixed-value discount codes, pause them, edit them, and remove codes you no longer need.',
    $article$<p>Coupons are discount codes that shoppers enter in the cart. StoreMink checks every rule again at checkout, so changing the page or request cannot bypass the limits you set.</p>
<h2>Create a coupon</h2>
<ol><li>From the dashboard, open <strong>Marketing → Coupons</strong>.</li><li>Select <strong>New coupon</strong>.</li><li>Enter a short code, such as <strong>WELCOME10</strong>. Codes are not case-sensitive.</li><li>Choose <strong>Percentage</strong> or <strong>Fixed amount</strong>, then enter the value.</li><li>Add any minimum order, usage, date, visibility, or customer-group rules you need.</li><li>Choose <strong>Active</strong> and select <strong>Create coupon</strong>.</li></ol>
<h2>Edit, pause, or delete a code</h2>
<p>Open a coupon from the list to change its rules. Set its status to <strong>Disabled</strong> when you want to stop new use without deleting its history. Delete a coupon only when you no longer need the record; earlier orders keep the code and discount they already received.</p>
<h2>Plan limits</h2>
<p>The number of active coupons depends on the store plan. Disabled coupons do not become valid at checkout. Open <strong>Plan & billing</strong> for the current allowance and upgrade options.</p>
<h2>Before sharing the code</h2>
<ul><li>Test it in the storefront cart while signed in as the intended customer.</li><li>The current date-only coupon fields are stored at midnight UTC. A chosen end date can therefore expire at the start of that UTC date rather than the end of the store's business day. Account for that boundary and test both sides before sharing the code.</li><li>Confirm whether the code is meant for everyone or selected customer groups.</li><li>Make sure the discount cannot reduce an order below a payment-provider minimum.</li></ul>$article$,
    'Create and manage StoreMink coupons',
    'Create, edit, pause, test, and delete StoreMink percentage or fixed-value coupon codes with server-checked rules.',
    1
  ),
  (
    'set-coupon-rules-validity-and-usage-limits',
    'Set coupon rules, validity, and usage limits',
    'Control minimum spend, active dates, total uses, customer-group access, and the difference between an active and visible coupon.',
    $article$<p>A coupon can be active without being shown publicly. This lets you send a private code to a selected audience while StoreMink still validates it at checkout.</p>
<h2>Available rules</h2>
<ul><li><strong>Minimum order:</strong> the cart subtotal must reach this amount before the code applies. Use 0 for no minimum.</li><li><strong>Maximum uses:</strong> the total number of successful orders that may use the code. Use 0 for no total limit.</li><li><strong>Valid from and valid until:</strong> the date window when the code is accepted.</li><li><strong>Status:</strong> Active accepts a valid code; Disabled rejects it.</li><li><strong>Customer groups:</strong> only signed-in customers in at least one selected group can use a restricted code. No selected group means everyone.</li><li><strong>Show on Storefront:</strong> controls whether the cart suggests the code; it does not decide whether the code itself is valid.</li></ul>
<p><strong>Date boundary:</strong> the current date-only fields are stored at midnight UTC. The valid-until date can stop accepting the coupon at the start of that UTC date, not the end of the store's local business day. Test the exact boundary before publishing a timed campaign.</p>
<p><strong>Current group-targeting safeguard:</strong> do not use a customer-group restriction as the only boundary for a sensitive or private offer. After every group change, test the saved code as an intended member, a signed-in customer outside the group, and a guest. If an outsider can use it, disable the coupon immediately and contact StoreMink support.</p>
<h2>How StoreMink prevents overuse</h2>
<p>Usage is claimed atomically when an order is created. Two shoppers cannot both take the final allowed use. If checkout fails after the claim, StoreMink rolls the coupon claim back with the order cleanup.</p>
<h2>If a valid code is rejected</h2>
<ol><li>Check that the coupon is Active and within its date range.</li><li>Check the cart minimum before tax and shipping.</li><li>Confirm the signed-in customer belongs to an allowed group.</li><li>Check whether the maximum use count has been reached.</li><li>Refresh the cart after changing a coupon in the dashboard.</li></ol>$article$,
    'Set StoreMink coupon rules and limits',
    'Configure StoreMink coupon minimums, dates, usage limits, customer groups, status, and storefront visibility.',
    2
  ),
  (
    'show-and-target-coupons',
    'Show coupons in the cart and target customer groups',
    'Choose which active offers shoppers can discover and restrict a coupon to signed-in members of selected customer groups.',
    $article$<p>StoreMink separates coupon eligibility from coupon discovery. A code can work when typed but remain hidden from the cart, or it can be displayed as an offer to eligible shoppers.</p>
<h2>Show one coupon in the storefront</h2>
<ol><li>Open <strong>Marketing → Coupons</strong>.</li><li>Open the coupon.</li><li>Turn on <strong>Show on Storefront</strong>.</li><li>Save the coupon.</li></ol>
<p>The code still needs to be Active, within its date range, below its use limit, and valid for the current customer and cart.</p>
<h2>Show every active coupon</h2>
<p>The Marketing setting <strong>Show all coupons</strong> overrides each coupon visibility checkbox. Use it only when every active offer is meant to be discoverable. Private campaign codes should normally keep this setting off.</p>
<h2>Restrict a coupon to customer groups</h2>
<ol><li>Create the group under <strong>Customers → Groups</strong> and add members.</li><li>Open the coupon.</li><li>Select one or more groups under <strong>Restrict to user groups</strong>.</li><li>Save and test with a signed-in group member.</li></ol>
<p>A correctly saved group restriction rejects guests because StoreMink cannot prove their membership. Selecting more than one group means membership in any selected group is enough. The current selector and save path still need stricter tenant and atomic validation, so also test the saved code with a signed-in customer outside the group and a guest before sharing it. If the selector shows a group you do not recognize, do not select it; leave the page and contact StoreMink support.</p>
<h2>Good targeting practice</h2>
<ul><li>Use clear group names such as VIP, Wholesale, or First purchase follow-up.</li><li>Remove a customer from a group when the benefit should end.</li><li>Do not publish a private code in a banner or public blog post.</li></ul>$article$,
    'Show and target StoreMink coupons',
    'Control cart coupon visibility and restrict StoreMink discount codes to signed-in members of selected customer groups.',
    3
  ),
  (
    'send-a-coupon-email-campaign',
    'Send a coupon email campaign',
    'Email an offer to all registered customers, a customer group, or selected customers, preview it, and review the initial send result in Email logs.',
    $article$<p>Coupon email campaigns send one saved coupon to registered customer accounts with email addresses. They do not send to newsletter-only sign-ups, and availability depends on the current StoreMink plan.</p>
<h2>Prepare the coupon</h2>
<ol><li>Open <strong>Marketing → Coupons</strong>.</li><li>Confirm the code, value, validity dates, group rules, and Active status.</li><li>Select the coupon email action.</li></ol>
<h2>Choose an audience</h2>
<ul><li><strong>All customers</strong> includes registered customers who have an email.</li><li><strong>A user group</strong> includes group members who have an email.</li><li><strong>Specific customers</strong> lets you search and pick individual accounts.</li></ul>
<p>The composer shows how many selected customers have an email. Missing addresses are skipped rather than making the whole campaign fail.</p>
<h2>Write and preview the message</h2>
<ol><li>Write a subject and body. Use <strong>{{first_name}}</strong> for a personal greeting.</li><li>If available, select <strong>Generate with AI</strong> to draft from the saved brand voice, then review every word.</li><li>Check the live preview. StoreMink adds the coupon code, value, and validity below your copy.</li><li>Select <strong>Send email</strong>.</li></ol>
<h2>After sending</h2>
<p>Messages are queued and sent in the background, so you can leave the page. Campaign results and <strong>Logs → Email logs</strong> record StoreMink's initial send processing, not final inbox delivery. <strong>Sent</strong> means Resend accepted the initial request; it does not prove that the message reached the inbox or was read. A <strong>failed</strong> or <strong>skipped</strong> result means the initial send could not be completed or StoreMink did not make the provider request, for example because sending was unavailable or the address had already been suppressed. Read the available error or campaign count to understand that initial outcome.</p>
<p>A permanent bounce or spam complaint received later can suppress the address for future messages, but it does not rewrite the earlier Email log or campaign result. Contact StoreMink support when a provider-side delivery check is needed. Do not send the campaign again only because a recipient reports non-arrival; first rule out delay, spam filtering, a later bounce, and an already accepted request so customers do not receive duplicate mail.</p>$article$,
    'Send a StoreMink coupon email campaign',
    'Send and preview a StoreMink coupon campaign for registered customers, groups, or selected accounts and interpret initial Email log results without assuming inbox delivery.',
    4
  ),
  (
    'create-publish-and-feature-blog-posts',
    'Create, publish, and feature blog posts',
    'Write rich blog posts, add media and search details, save drafts, publish when ready, and feature important stories.',
    $article$<p>Blog posts help customers discover stories, guides, launches, and product education. A draft is visible only in the dashboard; publishing makes it available on the storefront blog.</p>
<h2>Create a post</h2>
<ol><li>Open <strong>Blogs</strong> and select <strong>New blog</strong>.</li><li>Enter the title, summary, author, cover image, categories, and tags.</li><li>Write the post with headings, links, lists, images, and other editor tools.</li><li>Add the search title and description.</li><li>Save the draft or publish it.</li></ol>
<h2>Drafts and autosave</h2>
<p>The editor can save work while you write, but you should still check the save state before closing. A draft does not appear to storefront visitors. Use the Drafts filter to find unfinished posts.</p>
<h2>Publish, unpublish, or feature</h2>
<ul><li><strong>Publish</strong> makes the current post public.</li><li><strong>Unpublish</strong> removes it from public pages without deleting the draft.</li><li><strong>Feature</strong> marks the post for storefront sections that display featured content.</li></ul>
<p>You can apply publish, feature, or delete actions to selected rows. Bulk deletion cannot be undone.</p>
<h2>Check the storefront result</h2>
<p>Open the post from the storefront, test every link, inspect the cover image on a phone, and confirm its categories and tags. If a Latest blogs section is used in the Website Builder, confirm the post appears under its configured rules.</p>$article$,
    'Create and publish StoreMink blog posts',
    'Create rich StoreMink blog posts, save drafts, publish or unpublish, feature content, and verify the storefront result.',
    5
  ),
  (
    'manage-blog-categories-and-tags',
    'Manage blog categories and tags',
    'Create, rename, and delete the shared category and tag choices used by blog editors, storefront filters, and related posts.',
    $article$<p>Categories are broad topics customers browse. Tags are more specific labels used for search and related-content matching. StoreMink keeps one shared list for every blog editor in the store.</p>
<h2>Open blog settings</h2>
<ol><li>Open <strong>Blogs</strong>.</li><li>Select <strong>Settings</strong>.</li><li>Use the <strong>Categories</strong> or <strong>Tags</strong> section.</li></ol>
<h2>Create or rename an item</h2>
<ol><li>Add a short, clear name.</li><li>Save it.</li><li>To rename it later, choose the edit action, enter the new name, and save.</li></ol>
<p>Renaming updates affected blog posts so the old plain-text label does not remain attached in hidden rows.</p>
<h2>Delete an item</h2>
<p>Deleting a category or tag removes that label from affected posts. It does not delete the posts. Check storefront filters and related-post behavior after removing a widely used label.</p>
<h2>Good organization</h2>
<ul><li>Keep the category list small and stable.</li><li>Use tags for product names, ingredients, occasions, or detailed themes.</li><li>Avoid near-duplicates such as Tips and Helpful tips.</li><li>Choose labels a customer would understand without knowing your internal team language.</li></ul>$article$,
    'Manage StoreMink blog categories and tags',
    'Create, rename, and delete StoreMink blog categories and tags and understand how changes update existing posts.',
    6
  ),
  (
    'allow-and-review-customer-blog-submissions',
    'Allow and review customer blog submissions',
    'Let signed-in customers write posts, decide whether approval is required, and approve, reject, or return a submission to draft.',
    $article$<p>Customer submissions are optional. When enabled, signed-in customers can write from the storefront blog and manage their own submissions.</p>
<h2>Turn submissions on</h2>
<ol><li>Open <strong>Blogs → Settings</strong>.</li><li>Turn on <strong>Customer submissions</strong>.</li><li>Choose whether new submissions require approval.</li><li>Save the settings.</li></ol>
<h2>What customers can do</h2>
<p>A signed-in customer can create a draft, choose only categories and tags that the store has defined, submit it, view its status under My submissions, and delete or return eligible work to draft.</p>
<h2>Review pending work</h2>
<ol><li>Open <strong>Blogs</strong> and select the <strong>Pending</strong> filter.</li><li>Open the submission and check the writing, media, links, categories, tags, and author details.</li><li>Approve it to publish, or reject it to remove the submission. The current rejection action does not collect or send a reason, so contact the author separately when an explanation is needed.</li></ol>
<p>When approval is not required, eligible customer posts can publish directly. Use this only when the store is comfortable moderating after publication.</p>
<h2>Safety and privacy</h2>
<ul><li>Remove private addresses, phone numbers, order details, or payment information from public copy.</li><li>Do not assume uploaded media belongs to the store; follow your content policy.</li><li>Unpublish harmful content before investigating it.</li><li>Use categories and tags from the dashboard list; unrecognized labels are rejected.</li></ul>$article$,
    'Review customer blog submissions in StoreMink',
    'Enable StoreMink customer blog submissions and approve, reject, publish, or return submitted content safely.',
    7
  ),
  (
    'understand-blog-comments-reactions-and-product-reviews',
    'Understand blog comments, reactions, and product reviews',
    'Understand what customers can post and the current limits of merchant moderation for comments, reactions, and reviews.',
    $article$<p>Storefront visitors can interact with published content according to the feature and sign-in rules. These interactions belong to the store, but the current dashboard does not provide one central moderation queue for every comment, reaction, and product review.</p>
<h2>Blog comments and reactions</h2>
<p>Signed-in customers can interact on supported blog pages. Reactions help show interest; comments add public text. If a post becomes unsuitable for discussion, unpublish the post while the store reviews the content.</p>
<h2>Product reviews</h2>
<p>Customers can submit reviews on supported product pages. Review activity can appear in a customer profile, but StoreMink does not currently provide a complete merchant review-moderation workspace. Do not promise customers that a review can be edited from the dashboard.</p>
<h2>If content is abusive or exposes private data</h2>
<ol><li>Record the storefront URL and take a screenshot.</li><li>Unpublish the affected blog post or product if leaving it public creates harm.</li><li>Contact StoreMink support with the store domain and exact content location.</li></ol>
<h2>Set expectations in store policies</h2>
<p>Explain what content is allowed, whether submissions may be removed, and how customers can report a problem. Never include passwords, OTPs, payment card details, or another customer's order information in a public post, comment, or review.</p>$article$,
    'StoreMink comments, reactions, and product reviews',
    'Understand StoreMink blog comments, reactions, product reviews, current moderation limits, and how to report unsafe content.',
    8
  ),
  (
    'connect-and-manage-twilio-sms',
    'Connect, pause, or disconnect Twilio SMS',
    'Connect your own Twilio account with the DLT sender details required for transactional SMS in India.',
    $article$<p>StoreMink sends SMS through the store's own Twilio account. For messages to Indian numbers, the business must first register its entity, six-letter transactional sender header, and message templates on an approved DLT portal.</p>
<p><strong>Controlled live verification required:</strong> Before relying on SMS for customers, send one message to a consenting number owned by the test team through the merchant's own Twilio and approved DLT setup. Confirm the StoreMink send-attempt log, Twilio acceptance, handset receipt, exact text, sender, and segment count. Keep customer SMS disabled until this succeeds.</p>
<h2>Before connecting</h2>
<ul><li>A Twilio Account SID beginning with <strong>AC</strong>.</li><li>The matching Twilio Auth Token.</li><li>A DLT sender header containing exactly six letters.</li><li>The DLT Principal Entity ID.</li><li>Approved DLT templates for each message you plan to send.</li></ul>
<h2>Connect SMS</h2>
<ol><li>Open <strong>Settings → Channels</strong>.</li><li>Choose <strong>Twilio SMS</strong> and select <strong>Connect</strong>.</li><li>Enter the Twilio and DLT details.</li><li>Verify and save the connection.</li><li>Open Notifications and mirror an approved template for each SMS event.</li></ol>
<h2>Pause or disconnect</h2>
<p>Pause when you need to stop new SMS while keeping the stored connection. Disconnect removes the saved Twilio credentials and DLT sender details; you will need the portal values again to reconnect.</p>
<h2>Important limitation</h2>
<p>StoreMink does not currently ingest inbound STOP replies automatically. Maintain lawful consent and suppression records for SMS outside this connection, and do not message a person who has withdrawn consent.</p>$article$,
    'Connect Twilio SMS to StoreMink',
    'Connect, pause, or disconnect StoreMink Twilio SMS with the six-letter sender header and Principal Entity ID required by DLT.',
    9
  ),
  (
    'set-up-dlt-approved-sms-templates',
    'Set up DLT-approved SMS templates',
    'Mirror an approved DLT template exactly, add its template ID, and map each positional variable to StoreMink notification data.',
    $article$<p>Register the SMS wording on the DLT portal before adding it to StoreMink. StoreMink mirrors that approved record; it does not register or change the portal template.</p>
<p><strong>Controlled live verification required:</strong> Before using a mirrored template for customer messages, send it once to a consenting number owned by the test team through the merchant's own Twilio account. Confirm StoreMink's initial log, Twilio acceptance, handset receipt, exact DLT text and variable order, sender, and segment count.</p>
<h2>Add a template to a notification</h2>
<ol><li>Open <strong>Settings → Notifications</strong>.</li><li>Open the event that should send SMS.</li><li>Find the SMS template section.</li><li>Enter the approved DLT template ID.</li><li>Paste the approved body exactly, using the StoreMink DLT variable marker at every approved variable position.</li><li>Map each position to an allowed event value.</li><li>Save and send a test when available.</li></ol>
<h2>Why exact wording matters</h2>
<p>Indian carriers compare the sent text with the registered body. Changed punctuation, extra words, a different variable count, or the wrong sender can be dropped even when Twilio accepted the API request.</p>
<h2>Variable order</h2>
<p>DLT variables are positional rather than named. The first marker must map to the first portal variable, the second to the second, and so on. StoreMink refuses a mapping whose number of values does not match the body.</p>
<h2>Editing and removal</h2>
<p>Changing the StoreMink copy does not change the DLT portal record. Register the new wording first, then update its ID and exact body. Removing the StoreMink template stops that event from using SMS but does not delete the portal registration.</p>$article$,
    'Set up DLT SMS templates in StoreMink',
    'Mirror an approved DLT SMS template in StoreMink with its template ID, exact body, and correctly ordered event variables.',
    10
  ),
  (
    'read-sms-send-attempt-logs',
    'Read SMS send-attempt logs',
    'Check each SMS send attempt, its sent, failed, or skipped state, segment count, and initial error before deciding what to do next.',
    $article$<p>Open <strong>Logs → SMS logs</strong> to review SMS send attempts made through the store connection. Use this log first when a customer says a text did not arrive, but remember that it records StoreMink's initial send result rather than confirming receipt on the phone.</p>
<p><strong>Controlled live verification required:</strong> Before relying on SMS for customers, complete a controlled send to a consenting number owned by the test team and confirm the StoreMink attempt, Twilio acceptance, handset receipt, exact text, sender, and segment count. This log alone is not that end-to-end proof.</p>
<h2>What the log shows</h2>
<ul><li>The notification event, recipient, sender header, message body, and attempt time.</li><li>A <strong>sent</strong>, <strong>failed</strong>, or <strong>skipped</strong> state.</li><li>The segment count used to understand provider cost.</li><li>The initial error recorded when StoreMink could not confirm a send, or the reason an attempt was skipped.</li></ul>
<p>When Twilio accepts the request, StoreMink stores the provider message SID internally for support and reconciliation, but the current SMS log screen does not display that SID or the historical DLT template ID.</p>
<h2>Understand the three states</h2>
<ul><li><strong>Sent</strong> means Twilio accepted the initial request and returned a provider SID. It does not confirm delivery to the customer's phone.</li><li><strong>Failed</strong> means Twilio rejected the initial request or StoreMink could not confirm its outcome. Read the recorded error before trying again.</li><li><strong>Skipped</strong> means StoreMink did not send the request, for example because the body or phone number was missing.</li></ul>
<h2>Why sent may still not arrive</h2>
<p>An Indian carrier can later drop a Twilio-accepted message for a DLT mismatch. StoreMink does not currently ingest later Twilio or carrier status updates, so this log remains at the initial result and cannot prove that the phone received the message. Compare the body and sender shown in the row with the currently configured template under Notifications and with the DLT portal; the row itself does not expose its historical template ID. Use the store's Twilio account when a provider-side check is needed.</p>
<h2>Before retrying</h2>
<ol><li>Open the failed log row.</li><li>Confirm the mobile number and consent.</li><li>Check the Twilio balance and connection status.</li><li>Compare the sent body with the DLT record.</li><li>Repeat the originating action only after fixing the cause and checking that another message will not create a duplicate.</li></ol>
<p>Repeated attempts can create duplicate customer messages and additional Twilio charges. A sent row may still reach the customer later, so do not send a second copy merely because StoreMink has no later carrier state.</p>$article$,
    'Read StoreMink SMS send-attempt logs',
    'Use StoreMink SMS logs to inspect sent, failed, and skipped attempts, message bodies, sender headers, segment counts, initial errors, and safe next steps.',
    11
  ),
  (
    'troubleshoot-coupons-blogs-email-and-sms',
    'Troubleshoot coupons, blogs, email, and SMS',
    'Resolve rejected discount codes, missing posts, customer submission issues, campaign send problems, and DLT SMS problems.',
    $article$<p>Start with the feature status and audience, then check the relevant log. Avoid repeating a send or changing several rules at once before you know which condition failed.</p>
<p><strong>Controlled live verification required:</strong> Do not make customer SMS operational until a controlled message to a consenting number owned by the test team has proved the merchant's Twilio and DLT setup end to end: StoreMink attempt, Twilio acceptance, handset receipt, exact text, sender, and segment count.</p>
<h2>A coupon is rejected</h2>
<ul><li>Check Active status, start and end dates, minimum order, and use count.</li><li>For a restricted code, sign in with a customer who belongs to an allowed group.</li><li>Refresh the cart after changing a coupon.</li><li>Check whether the store plan allows another active coupon.</li></ul>
<h2>A blog post is missing</h2>
<ul><li>Check whether it is Draft, Pending, Published, or unpublished.</li><li>Confirm its category and the filters used by the storefront section.</li><li>Publish the page or builder changes that display Latest blogs.</li><li>For a customer post, check whether approval is required.</li></ul>
<h2>A coupon email did not arrive</h2>
<ol><li>Open <strong>Logs → Email logs</strong> and confirm the selected customer has an email.</li><li>Read the initial result: <strong>sent</strong> means Resend accepted the request. A <strong>failed</strong> or <strong>skipped</strong> result means the initial send could not be completed or StoreMink did not make the provider request; read the available error or campaign count.</li><li>Do not treat a sent row as proof of inbox delivery. Check spam filtering or contact StoreMink support for a provider-side check before deciding whether to send again.</li><li>Remember that a later permanent bounce or complaint can suppress the address for future sends without changing the earlier Email log or campaign result. Do not retry a suppressed address. If the customer says the address was corrected and should receive mail again, contact StoreMink support before a future campaign.</li></ol>
<p>Do not resend only because the customer reports non-arrival. An accepted message may still be delayed or filtered, and repeating the campaign can create duplicate email if the first message arrives later.</p>
<h2>An SMS did not arrive</h2>
<ol><li>Open <strong>Logs → SMS logs</strong>.</li><li>Check whether the attempt is sent, failed, or skipped, and read any initial error.</li><li>Check the Twilio connection and balance.</li><li>Compare the sender and body shown in the row with the active entity ID and template configured under Notifications and with the DLT portal. The row does not display its historical template ID.</li><li>If the row is sent, remember that StoreMink has only Twilio's initial acceptance; check the store's Twilio account and avoid a second attempt until you have ruled out a delayed or silently dropped message.</li></ol>
<h2>When to contact support</h2>
<p>Send the store domain, page or event name, approximate time, log reference, and a screenshot. Do not send passwords, OTPs, Twilio Auth Tokens, payment card details, or private customer data.</p>$article$,
    'Troubleshoot StoreMink marketing and communication',
    'Fix StoreMink coupon, blog, campaign email, Twilio, DLT template, and SMS send-attempt problems without causing duplicates.',
    12
  )
) AS guide(slug, title, excerpt, body, seo_title, seo_description, position)
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
