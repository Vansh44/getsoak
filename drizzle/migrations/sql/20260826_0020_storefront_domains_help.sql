-- Publish merchant-facing Website Builder, storefront setup, and domain guides.
-- These guides describe only controls that are available in the shipped UI.

INSERT INTO public.help_categories AS existing
  (slug, title, description, icon, position)
VALUES
  ('storefront', 'Setting up your store',
   'Build pages, arrange sections, manage your brand, and publish your storefront.',
   'LayoutTemplate', 2),
  ('domains', 'Domains',
   'Use your StoreMink subdomain or connect, verify, and manage your own domain.',
   'Globe', 6)
ON CONFLICT (slug) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  updated_at = now();

WITH help_category AS (
  SELECT id, slug
  FROM public.help_categories
  WHERE slug IN ('storefront', 'domains')
), documents (
  category_slug, slug, title, excerpt, body, seo_title, seo_description, position
) AS (
  VALUES
  (
    'storefront',
    'use-the-storemink-website-builder',
    'Use the StoreMink Website Builder',
    'Open the builder, choose a page, make changes, preview your work, and publish it for customers.',
    $article$<p>The Website Builder is where you create the pages and shared layout that customers see on your online store. It opens in a new browser tab so you have more space to edit.</p>
<h2>Open the builder</h2>
<ol><li>From the StoreMink dashboard, select <strong>Website Builder</strong>.</li><li>Choose the homepage or another page from the page list.</li><li>Select a section in the preview to edit its content and design.</li><li>Watch the save status at the top of the builder. Draft changes save automatically.</li><li>Select <strong>Publish</strong> when the page is ready for customers.</li></ol>
<h2>Preview different screen sizes</h2>
<p>Use the desktop, tablet, and mobile preview buttons to check how the page responds. These buttons change the preview only; they do not publish separate versions.</p>
<h2>Use a computer or larger tablet to edit</h2>
<p>The builder needs a screen at least 768 pixels wide. On a smaller phone screen, StoreMink asks you to continue on a larger device. Your published storefront itself remains responsive on phones.</p>
<h2>Draft and published content are separate</h2>
<p>Autosave protects your working draft, but customers continue to see the last published version. Publish only after the preview looks correct. You can unpublish an ordinary page later without deleting its draft.</p>$article$,
    'How to use the StoreMink Website Builder',
    'Open StoreMink Website Builder, edit a page, use responsive previews, understand autosave, and publish storefront changes.',
    1
  ),
  (
    'storefront',
    'create-edit-publish-or-delete-a-store-page',
    'Create, edit, publish, or delete a store page',
    'Create a custom page, set its address and search details, edit the draft, and control whether it is public.',
    $article$<h2>Create a page</h2>
<ol><li>Open <strong>Website Builder</strong>.</li><li>In the page list, select <strong>New page</strong>.</li><li>Enter a clear page title and URL slug.</li><li>Select <strong>Create page</strong>.</li><li>Open <strong>Page settings</strong> in the inspector and add an SEO title and description when the page should appear in search results.</li><li>Add and edit the page sections.</li></ol>
<h2>Edit and publish</h2>
<ol><li>Select the page from the page list.</li><li>Edit its sections in the preview and inspector.</li><li>Wait for the draft to show as saved.</li><li>Preview desktop, tablet, and mobile layouts.</li><li>Select <strong>Publish</strong>.</li></ol>
<h2>Unpublish or delete</h2>
<p>Unpublish a page when you want to hide it but keep the draft. Delete it only when you no longer need the page; deletion cannot be undone. Remove menu links to a deleted or unpublished page so customers do not reach a missing-page screen.</p>
<h2>Keep the address stable</h2>
<p>Changing a published page's slug changes its public URL. Update links in your header, footer, campaigns, and external sites after changing it.</p>$article$,
    'Create and publish a StoreMink store page',
    'Create a custom storefront page, edit its draft and SEO details, publish or unpublish it, and understand deletion and URL changes.',
    2
  ),
  (
    'storefront',
    'edit-your-storefront-homepage',
    'Edit your storefront homepage',
    'Arrange the first page customers see, preview it on different devices, and publish a new homepage version.',
    $article$<p>The homepage is the first page at your store address. StoreMink keeps it as a special page, so it cannot be deleted like an ordinary custom page.</p>
<h2>Edit the homepage</h2>
<ol><li>Open <strong>Website Builder</strong>.</li><li>Select <strong>Home</strong> from the page list.</li><li>Add the sections that explain what you sell and help customers start shopping.</li><li>Edit the text, images, products, categories, spacing, colours, and layout in each section.</li><li>Drag sections into the order you want.</li><li>Preview the page at desktop, tablet, and mobile widths.</li><li>Select <strong>Publish</strong>.</li></ol>
<h2>Choose useful homepage content</h2>
<p>A simple homepage usually starts with a clear hero, then shows important products or categories, reasons to trust the store, and a final action. Use only the sections your business needs; a shorter page is often easier to scan.</p>
<h2>Remember the shared header and footer</h2>
<p>The header and footer are shared across the storefront. Changes to them are published with your builder publish action, so review those areas before publishing the homepage.</p>$article$,
    'Edit and publish your StoreMink homepage',
    'Edit the StoreMink storefront homepage, arrange sections, preview responsive layouts, and publish the shared header and footer safely.',
    3
  ),
  (
    'storefront',
    'add-and-arrange-storefront-sections',
    'Add and arrange storefront sections',
    'Choose the right content block, change its settings, reorder it, duplicate it, or remove it from a page.',
    $article$<h2>Add a section</h2>
<ol><li>Open a page in <strong>Website Builder</strong>.</li><li>Select <strong>Add section</strong>.</li><li>Choose a section type.</li><li>Enter its content and choose its layout and design settings.</li><li>Wait for autosave, then preview the result.</li></ol>
<h2>Available section types</h2>
<p>You can add a hero, hero carousel, featured products, shop by category, promotional banner, tile grid, media with text, gallery, testimonials, video, newsletter form, USP bar, ticker, FAQ accordion, latest blogs, rich text, or custom code.</p>
<h2>Arrange the page</h2>
<p>Drag sections into a new order. Duplicate a section when you want the same structure with different content. Delete a section only after checking that its content is not needed; Undo can restore a recent change while the editing session is open.</p>
<h2>Check selected content</h2>
<p>Product, category, and blog sections depend on published records. If a selected item is later unpublished or deleted, return to the builder and choose a replacement.</p>$article$,
    'Add and arrange StoreMink storefront sections',
    'Add, edit, reorder, duplicate, and remove StoreMink page sections including heroes, product grids, FAQs, blogs, rich text, and custom code.',
    4
  ),
  (
    'storefront',
    'edit-your-header-footer-and-navigation',
    'Edit your header, footer, and navigation',
    'Change the links and shared store chrome that customers use on every storefront page.',
    $article$<p>The header and footer now live inside the Website Builder. The old Navigation dashboard address opens the builder instead of a separate menu editor.</p>
<h2>Edit shared store chrome</h2>
<ol><li>Open <strong>Website Builder</strong>.</li><li>Select the header, announcement area, or footer in the preview.</li><li>Edit the menu links, labels, logo treatment, layout, and available contact or social details.</li><li>Check that every internal link points to a published page, product collection, or blog destination.</li><li>Preview the shared areas on desktop and mobile widths.</li><li>Select <strong>Publish</strong>.</li></ol>
<h2>Where contact and legal details come from</h2>
<p>Business contact details, social links, and core brand identity are managed in <strong>Branding</strong>. Store policies are managed in <strong>Settings → Policies</strong>. The builder decides how those details are presented.</p>
<h2>Publishing is shared</h2>
<p>Header and footer drafts save as you edit. A builder publish action publishes the current page and the latest shared chrome together, so review both before going live.</p>$article$,
    'Edit StoreMink header, footer, and navigation',
    'Edit storefront menus, header, footer, contact links, and shared layout in StoreMink Website Builder and publish the changes safely.',
    5
  ),
  (
    'storefront',
    'change-your-storefront-branding-and-layout',
    'Change your storefront branding and layout',
    'Set your identity and contact details, then control how the header, product cards, product page, cart, and footer look.',
    $article$<h2>Update business identity</h2>
<ol><li>From the dashboard, open <strong>Branding</strong>.</li><li>Add or replace the logo and choose the primary colour.</li><li>Review the business contact details, footer text, and social links.</li><li>Save your changes.</li></ol>
<p>Invoices and emails also use parts of this information, so keep it accurate rather than adding display-only wording.</p>
<h2>Choose storefront layout options</h2>
<ol><li>Open <strong>Website Builder</strong>.</li><li>Select the <strong>Brand</strong> row.</li><li>Choose the available header, product-card, product-detail, cart, and footer layout options.</li><li>Preview desktop, tablet, and mobile widths.</li><li>Publish the builder changes.</li></ol>
<h2>Understand the two screens</h2>
<p><strong>Branding</strong> stores your business identity, contact information, social links, and brand voice. The builder controls the visual presentation of the storefront. Update the source information in Branding and the layout in the builder.</p>$article$,
    'Change StoreMink storefront branding and layout',
    'Update your StoreMink logo, colours, contact details and social links, then choose header, product, cart and footer layouts.',
    6
  ),
  (
    'storefront',
    'create-or-edit-your-brand-voice',
    'Create or edit your brand voice',
    'Describe how your business should sound so StoreMink AI can draft more consistent product and campaign copy.',
    $article$<h2>Create a guided brand voice</h2>
<ol><li>Open <strong>Branding</strong>.</li><li>Find the brand voice area.</li><li>Answer the guided questions about the business, products, customers, tone, and words to use or avoid.</li><li>Generate the guide.</li><li>Read the result and correct anything that is not true or does not sound like your business.</li><li>Save it.</li></ol>
<h2>Write the guide yourself</h2>
<p>You can enter or edit the brand voice manually. Keep it practical: describe sentence style, level of formality, useful phrases, forbidden claims, and the facts AI must never invent.</p>
<h2>Where it is used</h2>
<p>StoreMink can use the saved voice when helping with product descriptions, SEO text, and coupon email copy. Generation uses your plan's monthly AI allowance or purchased credits. You remain responsible for reviewing every generated claim before publishing or sending it.</p>$article$,
    'Create a StoreMink brand voice for AI writing',
    'Create or edit a StoreMink brand voice, understand where AI uses it, review generated claims, and understand AI credit usage.',
    7
  ),
  (
    'storefront',
    'understand-builder-autosave-undo-and-editing-conflicts',
    'Understand autosave, undo, and editing conflicts',
    'Keep draft work safe, reverse recent changes, and choose what happens when another browser tab edits the same page.',
    $article$<h2>Watch the save status</h2>
<p>The builder saves draft changes automatically after a short pause. Wait for the saved state before closing the tab. Publishing is separate and always requires your action.</p>
<h2>Undo or redo a change</h2>
<p>Use <strong>Undo</strong> and <strong>Redo</strong> for recent changes in the current editing session. The restored draft is saved through the same autosave process.</p>
<h2>Resolve another-tab changes</h2>
<p>If another tab saved the same page, StoreMink stops the older tab from silently overwriting it. Choose the option that matches your situation:</p>
<ul><li><strong>Reload</strong> discards this tab's draft and loads the newest saved version.</li><li><strong>Copy my changes</strong> copies this tab's work so you can reload and paste it somewhere safe.</li><li><strong>Take over</strong> saves this tab as the new draft. Use it only after confirming the other editor's work is not needed.</li></ul>
<h2>Avoid preventable conflicts</h2>
<p>Edit a page in one tab at a time and tell teammates before taking over. A role with view-only builder access can preview but cannot save or publish changes.</p>$article$,
    'StoreMink builder autosave, undo, and conflict help',
    'Understand Website Builder autosave, draft publishing, undo and redo, and safely resolve changes made in another StoreMink browser tab.',
    8
  ),
  (
    'storefront',
    'add-safe-custom-code-to-a-page',
    'Add custom code to a storefront page',
    'Enable custom code, add HTML, CSS, or JavaScript in a sandboxed section, test it, and publish it safely.',
    $article$<h2>Enable custom code</h2>
<ol><li>Open <strong>Website Builder → Settings</strong>.</li><li>Turn on <strong>Allow custom code</strong>.</li><li>Save the setting.</li></ol>
<h2>Add a custom-code section</h2>
<ol><li>Open the page in Website Builder.</li><li>Select <strong>Add section → Custom code</strong>.</li><li>Enter the HTML, CSS, or JavaScript needed by the section.</li><li>Preview the result and check desktop and mobile widths.</li><li>Publish only after testing the storefront.</li></ol>
<h2>Security and size limits</h2>
<p>Custom code runs inside a sandboxed iframe, isolated from the rest of the store. It cannot use same-origin access to read StoreMink pages, customer sessions, or checkout data. Each HTML, CSS, or JavaScript string is limited to 64 KB.</p>
<h2>Know the limitations</h2>
<p>Custom code is best for an isolated visual or interactive block. A third-party script that expects full control of the page, cookies, checkout, or the top-level window may not work. Turning the store-wide setting off prevents custom-code sections from being published.</p>$article$,
    'Add sandboxed custom code to StoreMink pages',
    'Enable StoreMink custom code, add HTML CSS or JavaScript in a sandboxed iframe, understand the 64 KB limit, and test before publishing.',
    9
  ),
  (
    'storefront',
    'upload-and-manage-store-media',
    'Upload and manage store images',
    'Upload reusable images, copy their URLs, use them in store content, and remove unused files carefully.',
    $article$<h2>Upload a file</h2>
<ol><li>From the dashboard, open <strong>Media</strong>.</li><li>Select the upload control and choose a supported image.</li><li>Wait for the upload to finish.</li><li>Copy the media URL or select the asset from an editor that supports the media library.</li></ol>
<h2>How files are handled</h2>
<p>Image uploads are limited to 5 MB. The Media screen accepts JPEG, PNG, WebP, SVG, GIF, and AVIF images. JPEG, PNG, WebP, and SVG uploads are normally optimized and stored as WebP for efficient storefront delivery. GIF and AVIF files keep their original format to preserve animation or an already efficient encoding; if optimization of another validated non-SVG image fails, StoreMink keeps the original file instead.</p>
<h2>Delete with care</h2>
<p>Before deleting an asset, remove it from products, pages, branding, blog posts, or other content that still uses its URL. Deleting a library record does not automatically rewrite every place where the URL was pasted.</p>
<h2>If an upload fails</h2>
<p>Check the supported image type and 5 MB limit, keep the tab open until the upload completes, and try again on a stable connection. A broken SVG is refused rather than stored raw. Do not upload confidential documents; media URLs are intended for public storefront content.</p>$article$,
    'Upload and manage StoreMink store images',
    'Upload StoreMink images, understand the 5 MB limit and WebP optimization, copy URLs, and safely remove unused assets.',
    10
  ),
  (
    'storefront',
    'publish-store-terms-refund-shipping-and-privacy-policies',
    'Publish your store policies',
    'Add the Terms, Refund, Shipping, and Privacy wording shown to customers and know when an empty policy disappears.',
    $article$<p>Store policies explain the terms customers agree to when they shop or create an account. StoreMink provides the publishing controls, but your business is responsible for suitable wording and legal compliance.</p>
<h2>Edit a policy</h2>
<ol><li>Open <strong>Settings → Policies</strong>.</li><li>Choose Terms, Refund, Shipping, or Privacy.</li><li>Enter the current policy in clear plain text.</li><li>Save the changes.</li><li>Open the storefront and check the policy link.</li></ol>
<h2>Publish or unpublish</h2>
<p>Saving non-empty wording publishes that policy. Saving it empty unpublishes it. New stores do not currently receive ready-made policy wording, so review all four policies before accepting orders.</p>
<h2>Use a builder page for richer content</h2>
<p>The policy editor is intentionally plain. If you need images, complex layouts, or a longer guide, create a page in Website Builder and link to it from your menus. Keep the checkout-facing policy wording accurate as well.</p>
<h2>Get appropriate advice</h2>
<p>Refund, privacy, tax, shipping, and consumer rules vary by location and product. StoreMink cannot decide the right policy for your business; obtain qualified advice where needed.</p>$article$,
    'Publish StoreMink Terms Refund Shipping and Privacy policies',
    'Edit and publish StoreMink store policies, understand how empty policies are unpublished, and use Website Builder for richer legal pages.',
    11
  ),
  (
    'storefront',
    'add-a-newsletter-sign-up-form',
    'Add a newsletter sign-up form',
    'Place a consent-aware email form in a page or footer and understand the current subscriber-management limitation.',
    $article$<h2>Add the form</h2>
<ol><li>Open <strong>Website Builder</strong>.</li><li>Add a <strong>Newsletter</strong> section, or edit the newsletter area in the footer.</li><li>Write a clear reason to subscribe and adjust the available design settings.</li><li>Preview the form, then publish the builder changes.</li></ol>
<h2>What happens after submission</h2>
<p>StoreMink validates the address, records the subscription for this store, and stores the marketing consent granted through the form. Repeating the same address updates the existing subscription instead of creating duplicates.</p>
<h2>Current limitation</h2>
<p>The dashboard does not yet provide a subscriber list, export, or newsletter-campaign sender. Coupon email campaigns use registered customer accounts and do not automatically send to newsletter-form subscribers. Do not promise a follow-up campaign until you have a separate consent-compliant workflow.</p>
<h2>Respect consent</h2>
<p>Explain what the person is signing up for and follow applicable marketing and unsubscribe rules. Do not use a newsletter address for unrelated messages.</p>$article$,
    'Add a StoreMink newsletter signup form',
    'Add a consent-aware newsletter form to a StoreMink page or footer and understand the current subscriber list and campaign limitations.',
    12
  ),
  (
    'domains',
    'use-your-free-storemink-subdomain',
    'Use your free StoreMink subdomain',
    'Open and share the store address included with every StoreMink plan, and understand what happens after a custom domain goes live.',
    $article$<p>Every store receives an address such as <strong>your-store.storemink.com</strong>. It works without buying a domain or editing DNS and remains the recovery address for your store.</p>
<h2>Find and use the address</h2>
<ol><li>Open the StoreMink dashboard.</li><li>Select <strong>My Store</strong> to open the public storefront.</li><li>Copy the address from the browser and use it in tests, messages, or links.</li></ol>
<h2>When a custom domain is connected</h2>
<p>After a custom domain is fully verified, serving securely, and healthy, StoreMink redirects the subdomain to it with a permanent HTTP redirect. If entitlement or health later fails, StoreMink can stop that redirect and restore the subdomain as the working address.</p>
<h2>If the custom domain becomes unavailable</h2>
<p>If the Pro entitlement ends or StoreMink detects repeated domain-health failures, the subdomain becomes the working address again. Keep a record of it so you can always reach the store and dashboard.</p>
<h2>Search and analytics history</h2>
<p>A custom domain and a StoreMink subdomain are different web origins. Browser sessions and some search or analytics history do not automatically move between them.</p>$article$,
    'Use your free StoreMink store subdomain',
    'Find and share your StoreMink subdomain, understand custom-domain redirects, and know how the subdomain restores access after a domain problem.',
    1
  ),
  (
    'domains',
    'how-to-add-custom-domain',
    'Connect a custom domain',
    'Connect a domain you own, add the exact generated DNS records, wait for HTTPS, and move customers to your branded address.',
    $article$<p><strong>Custom domains are a Pro feature and are provisioned only for the production store.</strong> You need access to the DNS settings at the company where the domain is managed.</p>
<h2>Start the connection</h2>
<ol><li>From the dashboard, open <strong>Settings → Domain</strong>.</li><li>Enter the domain you own, without <strong>https://</strong> or a path.</li><li>Select <strong>Connect</strong>.</li><li>StoreMink creates the exact routing and certificate records for that domain.</li></ol>
<h2>Add every record shown</h2>
<ol><li>Open your DNS provider in another tab.</li><li>Add the displayed <strong>A</strong> record so the hostname points only to StoreMink's reserved address.</li><li>Add each displayed certificate <strong>CNAME</strong> exactly as shown.</li><li>If StoreMink shows both the root and <strong>www</strong> form, add records for both so visitors can use either address.</li><li>Remove conflicting A records that send the same hostname elsewhere.</li></ol>
<h2>Verify and wait for HTTPS</h2>
<p>Return to StoreMink and select <strong>Check now</strong>. DNS changes can take time to spread, and the managed TLS certificate can take longer after DNS is correct. You may safely close the page; StoreMink continues checking.</p>
<p>The primary domain goes live only when its certificate is active, DNS points exclusively to StoreMink, and the secure certificate mapping exists. StoreMink then redirects the old subdomain to the custom domain and starts Google ownership and sitemap coverage.</p>
<h2>Sign in and re-authorise tills on the new address</h2>
<p>A custom domain is a different browser origin. Dashboard users must sign in once on the new address. Every paired POS till must also be re-authorised once because its secure device and operator cookies cannot move from the StoreMink subdomain to another host. This does not remove the staff account, role, location access, sales, or the earlier device audit record.</p>$article$,
    'How to connect a custom domain to StoreMink',
    'Connect a Pro StoreMink custom domain, add generated A and certificate CNAME records, wait for managed TLS, and understand redirects and sign-in.',
    2
  ),
  (
    'domains',
    'add-custom-domain-dns-records',
    'Add the custom-domain DNS records',
    'Understand the A and certificate CNAME records StoreMink generates and avoid common root and www mistakes.',
    $article$<h2>Use the records shown in StoreMink</h2>
<p>Do not copy values from another store or an old screenshot. Open <strong>Settings → Domain</strong> and use the host, type, and value shown for this connection.</p>
<h2>Routing A records</h2>
<p>The A record sends visitors to StoreMink's reserved load-balancer address. The hostname must resolve only to that address. Remove extra A records for the same host or some visitors can be sent to the wrong server.</p>
<h2>Certificate CNAME records</h2>
<p>Each certificate CNAME proves control of one hostname and allows Google to issue HTTPS. Copy both the record name and target. Some DNS providers automatically append the domain name, so check their preview before saving.</p>
<h2>Root and www</h2>
<p>When you connect a root domain such as <strong>example.com</strong>, StoreMink can show separate records for <strong>example.com</strong> and <strong>www.example.com</strong>. Add both sets. A certificate for one hostname does not automatically secure the other.</p>
<h2>DNS provider features</h2>
<p>If the provider offers proxying, flattening, forwarding, or parking, use normal DNS-only records while verification is in progress. A provider may display <strong>@</strong> for the root host. Follow its documentation without changing the StoreMink target value.</p>$article$,
    'Add StoreMink custom-domain DNS records',
    'Add generated StoreMink A and certificate CNAME records, remove conflicting addresses, and correctly configure root and www hostnames.',
    3
  ),
  (
    'domains',
    'troubleshoot-custom-domain-verification-and-https',
    'Troubleshoot custom-domain verification and HTTPS',
    'Fix missing or conflicting DNS, CNAME, CAA, certificate, and rate-limit problems shown on the Domain page.',
    $article$<h2>Run a fresh check</h2>
<ol><li>Open <strong>Settings → Domain</strong>.</li><li>Compare every shown DNS record with your provider.</li><li>Correct any difference and wait for DNS to update.</li><li>Select <strong>Check now</strong>.</li></ol>
<h2>If the A record is wrong</h2>
<p>Update it to the address shown by StoreMink. Remove other A records for the same host. Multiple addresses can make the site work for one visitor and fail for another.</p>
<h2>If the certificate CNAME is missing</h2>
<p>Copy the exact generated name and target. Check whether your provider added the domain twice or removed part of the host. Root and www use separate records.</p>
<h2>If StoreMink reports CAA</h2>
<p>Your domain has a CAA rule that does not allow Google's certificate authority. Add the CAA value shown by StoreMink, such as <strong>0 issue &quot;pki.goog&quot;</strong>, or remove the blocking CAA rule after checking with whoever manages the domain.</p>
<h2>If certificate requests are rate-limited</h2>
<p>Stop changing or repeatedly reconnecting the domain. Correct the records, wait for the period shown by StoreMink, and check later. Recreating certificates during a rate limit can make the wait longer.</p>
<h2>When DNS is correct but HTTPS is still pending</h2>
<p>Managed certificate issuance can lag behind DNS. StoreMink can reset a stale certificate attempt when it is safe, but it will not do that for a real CAA block or rate limit. You can close the page while background checks continue.</p>$article$,
    'Fix StoreMink custom domain and HTTPS problems',
    'Troubleshoot custom-domain A records, certificate CNAMEs, root and www, CAA blocks, managed TLS delays, and certificate rate limits.',
    4
  ),
  (
    'domains',
    'change-or-disconnect-a-custom-domain',
    'Change or disconnect a custom domain',
    'Move to another domain or return to the StoreMink subdomain without losing store content, orders, or account access.',
    $article$<h2>Before changing the domain</h2>
<p>Record the current domain, update any campaigns or printed material that will need a new address, and make sure you can edit DNS for the replacement.</p>
<h2>Change to another domain</h2>
<ol><li>Open <strong>Settings → Domain</strong>.</li><li>Enter the new domain and save the change.</li><li>Add the new generated A and certificate CNAME records.</li><li>Select <strong>Check now</strong> and wait for the new certificate to become active.</li><li>Update links after the new address is live.</li></ol>
<p>After the change, StoreMink starts a best-effort cleanup of its managed certificate, secure mapping, sign-in authorisation, and Google search property for the old domain. Some control-plane cleanup happens asynchronously and can take time or need a retry. StoreMink cannot edit DNS at the old provider, so remove obsolete StoreMink records there yourself when they are no longer needed. If the old StoreMink-managed mapping, certificate, or Google search property still exists after allowing time for cleanup, contact support with the old domain.</p>
<h2>Disconnect and use the subdomain</h2>
<ol><li>Open the connected-domain card.</li><li>Select <strong>Disconnect</strong> and confirm.</li><li>Use the store's <strong>*.storemink.com</strong> address again.</li></ol>
<h2>What remains</h2>
<p>Disconnecting a domain does not delete products, pages, customers, orders, staff, or POS data. Browser sessions belong to each host, so staff may need to sign in on the address they use next. Search engines can take time to replace old URLs with the new canonical address.</p>$article$,
    'Change or disconnect a StoreMink custom domain',
    'Change a StoreMink custom domain, add new DNS, disconnect safely, return to the subdomain, and understand cleanup, login, and search effects.',
    5
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
