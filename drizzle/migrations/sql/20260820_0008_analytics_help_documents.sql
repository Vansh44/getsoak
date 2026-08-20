-- Expand the Analytics Help Centre category into a complete guide set.
-- Guides for shipped features are published. GA4 and Meta Pixel remain drafts
-- until the Pro merchant-pixel settings and consent controls are released.

WITH analytics_category AS (
  SELECT id
  FROM public.help_categories
  WHERE slug = 'analytics'
)
INSERT INTO public.help_articles AS existing
  (category_id, slug, title, excerpt, body, status, seo_title,
   seo_description, position, published_at)
SELECT analytics_category.id,
       document.slug,
       document.title,
       document.excerpt,
       document.body,
       document.status,
       document.seo_title,
       document.seo_description,
       document.position,
       CASE WHEN document.status = 'published' THEN now() ELSE NULL END
FROM analytics_category
CROSS JOIN (VALUES
  (
    'understand-analytics-dashboard',
    'Understand your Analytics dashboard',
    'Start here to learn where StoreMink analytics comes from, choose a date range, read cards, and open detailed reports.',
    $article$<p>StoreMink Analytics brings your store's sales, orders, products, customers, inventory, content activity, and Google Search performance into one dashboard. This guide explains the page at a high level. Follow the linked guides when you need a metric's exact calculation.</p>
<h2>Open Analytics</h2>
<ol><li>Sign in to your StoreMink operator dashboard.</li><li>Select <strong>Analytics</strong> in the left navigation.</li><li>Use the controls at the top to choose the period, comparison, and location you want to study.</li></ol>
<h2>What the dashboard contains</h2>
<ul><li><strong>Summary cards</strong> show one important number, such as Total sales, Orders, or Average order value.</li><li><strong>Charts</strong> show how a result changed over time or how it is split by product, channel, location, or payment method.</li><li><strong>Operational cards</strong> show recent orders, enquiries, blog approvals, and inventory movement.</li><li><strong>Google Search cards</strong> show how people found your storefront in Google Search.</li><li><strong>Detailed reports</strong> provide larger tables and CSV downloads for supported cards.</li></ul>
<h2>Choose a date range</h2>
<p>Select a preset period or enter custom start and end dates. StoreMink uses the <strong>business time zone</strong> selected in Settings, so a sale is placed in the calendar day that applies to your business. The comparison control can compare the selected period with its preceding period.</p>
<h2>Choose a location</h2>
<p>If you can access more than one location, use the location filter to view one location or the whole store. A staff member restricted to one location only receives data for that location. Google Search data describes the online storefront, so a physical-location filter does not change it.</p>
<h2>Open a report or export data</h2>
<p>Select a card's report link to open its detailed table. StoreMink carries the current date and location filters into the report. Select <strong>Export CSV</strong> when you need the data in a spreadsheet. See <a href="/help/analytics/analytics-reports-and-csv">Use detailed Analytics reports and CSV exports</a>.</p>
<h2>Customize your page</h2>
<p>Select <strong>Edit dashboard</strong> to add, remove, move, or resize cards. Your saved layout belongs to your staff account and does not rearrange the dashboard for other users. See <a href="/help/analytics/customize-analytics-dashboard">Customize your Analytics dashboard</a>.</p>
<h2>Choose the right guide</h2>
<ul><li><a href="/help/analytics/analytics-sales-and-orders">Understand sales and order analytics</a></li><li><a href="/help/analytics/analytics-customers-inventory-and-activity">Understand customer, inventory, and activity analytics</a></li><li><a href="/help/analytics/understand-google-search-analytics">Understand Google Search analytics</a></li><li><a href="/help/analytics/analytics-terms-and-data-sources">Analytics terms and data sources</a></li><li><a href="/help/analytics/analytics-troubleshooting">Troubleshoot Analytics</a></li></ul>
<h2>Advanced analytics and plans</h2>
<p>The core Analytics dashboard is available according to your StoreMink plan and the features enabled by StoreMink. Advanced integrations such as Google Analytics 4 and Meta Pixel are <strong>Pro plan</strong> features. Their setup guides remain unavailable to merchants until those connections are released.</p>$article$,
    'published',
    'Understand your StoreMink Analytics dashboard',
    'Learn how to use StoreMink Analytics, choose filters, understand cards, open reports, export data, and customize the dashboard.',
    1
  ),
  (
    'analytics-terms-and-data-sources',
    'Analytics terms and data sources',
    'A simple glossary for date ranges, comparisons, recognized orders, snapshots, StoreMink commerce data, Google Search data, GA4, and Meta Pixel.',
    $article$<p>Analytics tools can show different numbers because they answer different questions. Use this glossary to understand what StoreMink is measuring and where each result comes from.</p>
<h2>Filters and time</h2>
<h3>Date range</h3><p>The start and end dates included in a report. StoreMink applies the business time zone from Settings when it turns timestamps into calendar days.</p>
<h3>Comparison period</h3><p>An earlier period of the same length used to calculate whether a result increased or decreased. A dash can appear when there is no meaningful earlier value.</p>
<h3>Location scope</h3><p>The store locations the current user is allowed to see. Selecting a location changes order-shaped commerce metrics. It does not change online Google Search data.</p>
<h3>Current snapshot</h3><p>A value that describes the store now, not during the selected period. <strong>Total customers</strong> and <strong>Products listed</strong> are current snapshots, so they do not show a period comparison.</p>
<h2>Commerce terms</h2>
<h3>Recognized order</h3><p>An order StoreMink considers real commerce for analytics. It includes paid orders, Cash on Delivery orders, and completed or refunded Point of Sale orders. Cancelled orders and unfinished payment attempts are excluded.</p>
<h3>Completed refund</h3><p>Money that was actually refunded. StoreMink subtracts it on the refund settlement date, which can be later than the original order date.</p>
<h3>Merchandise value</h3><p>The total of product line amounts used by product and category reports. It is useful for ranking merchandise but is not the same as net store sales because order-level adjustments, taxes, and refunds are handled separately.</p>
<h2>Where data comes from</h2>
<table><thead><tr><th>Source</th><th>What it answers</th><th>Examples</th></tr></thead><tbody><tr><td>StoreMink commerce</td><td>What happened in your store</td><td>Sales, orders, units, products, customers, discounts, refunds, inventory</td></tr><tr><td>Google Search Console</td><td>How your pages appeared and were clicked in Google Search</td><td>Clicks, impressions, search CTR, average position, queries, landing pages</td></tr><tr><td>Google Analytics 4</td><td>How consenting visitors used the storefront</td><td>Visits, acquisition, pages, events, and journeys in Google's reporting</td></tr><tr><td>Meta Pixel</td><td>How consenting visitors interacted with the storefront for Meta advertising</td><td>Browser events used for ad measurement and audiences</td></tr></tbody></table>
<h2>Why two tools may disagree</h2>
<p>A Google Search click is not the same as a storefront visit, and a visit is not the same as an order. Time zones, consent choices, ad blockers, privacy filtering, delayed processing, refund dates, and different attribution rules can all change totals. Compare like with like: the same date range, time zone, event definition, and source.</p>
<h2>Are external IDs secret?</h2>
<p>A GA4 Measurement ID and a Meta Pixel ID identify where browser events should be sent. They are commonly visible in website code and are not passwords. You should still restrict access to the Google and Meta business accounts that can change the connected properties.</p>$article$,
    'published',
    'StoreMink Analytics terms and data sources',
    'Understand StoreMink analytics terminology, recognized orders, refunds, snapshots, commerce data, Search Console, GA4, and Meta Pixel.',
    2
  ),
  (
    'analytics-sales-and-orders',
    'Understand sales and order analytics',
    'Learn exactly what Total sales, Orders, Average order value, Units sold, sales breakdowns, discounts, returns, and refunds mean.',
    $article$<p>Sales cards use StoreMink order and refund records. They respect your selected date range, business time zone, and permitted location scope unless this guide says otherwise.</p>
<h2>Which orders are counted?</h2>
<p>StoreMink counts a <strong>recognized order</strong>: a paid order, a Cash on Delivery order, or a completed/refunded Point of Sale order. It excludes cancelled orders and unfinished payment attempts.</p>
<h2>Summary metrics</h2>
<h3>Total sales</h3><p>The sum of recognized order totals created in the selected period, minus completed refunds settled in that period. A refund can therefore reduce today's sales even when the original order was placed earlier.</p>
<h3>Orders</h3><p>The number of recognized orders created in the selected period. This is an order count, not a count of payment attempts or individual products.</p>
<h3>Average order value</h3><p><strong>Total sales divided by recognized orders.</strong> If there are no recognized orders, the value is zero.</p>
<h3>Units sold</h3><p>The total quantity of order items on recognized orders in the selected period.</p>
<h2>Sales charts and breakdowns</h2>
<h3>Total sales over time</h3><p>Net sales grouped into daily, weekly, or monthly points. StoreMink automatically chooses a sensible grouping for the length of the selected range and uses the business time zone.</p>
<h3>Sales by category and Top products</h3><p>These rank product-line merchandise value from recognized orders. Use them to understand what sold. Their totals do not have to equal Total sales because order-level discounts, taxes, and completed refunds are separate concepts.</p>
<h3>Sales by channel</h3><p>Splits sales between channels such as online and Point of Sale. Completed refunds are subtracted from the matching channel where StoreMink can identify it.</p>
<h3>Sales by location</h3><p>Splits recognized commerce by fulfilment or Point of Sale location. Online or older orders without a location appear in the appropriate unassigned/online group instead of being silently attached to a physical location.</p>
<h3>Sales by payment method</h3><p>Splits sales by the recorded payment method. Point of Sale payments can be itemized when an order used multiple tenders. Order-level summary rows marked as split are not double-counted.</p>
<h2>Discount impact</h2>
<p>Shows discounts recorded on orders and order lines. Coupon usage counts orders that have an applied coupon code. It helps explain promotion usage; it is not an advertising-attribution report.</p>
<h2>Returns and refunds</h2>
<ul><li><strong>Returns</strong> describe completed returned merchandise, including returned units and value.</li><li><strong>Refunds</strong> describe completed money movements back to customers.</li></ul>
<p>Do not add return value and refund value together as if they are separate losses: one customer case can create both records. Returns use the return completion date; refunds use the settlement date.</p>
<h2>Recent orders</h2>
<p>Shows the newest orders in the selected period, including statuses that may not yet qualify for recognized sales. This makes it an operational list, so it can contain an order that the sales total currently excludes.</p>
<h2>Common reasons totals look unexpected</h2>
<ul><li>The payment is still pending or the order was cancelled.</li><li>A refund settled inside the selected period for an older order.</li><li>The business time zone places a late-night order on a different day than your computer does.</li><li>A location filter or staff location restriction is active.</li><li>You are comparing product merchandise value with net Total sales.</li></ul>$article$,
    'published',
    'Understand StoreMink sales and order analytics',
    'Definitions and calculations for StoreMink Total sales, Orders, AOV, units, products, channels, locations, payments, discounts, returns, and refunds.',
    3
  ),
  (
    'analytics-customers-inventory-and-activity',
    'Understand customer, inventory, and activity analytics',
    'Learn how StoreMink measures customers, new versus returning buyers, inventory velocity, recent activity, enquiries, and blog approvals.',
    $article$<p>These cards combine current store snapshots, period-based commerce activity, and operational work. Read the label carefully because not every card is a sales metric.</p>
<h2>Current store snapshots</h2>
<h3>Total customers</h3><p>The current number of customer accounts in the store. It is not limited to people who ordered in the selected period. Store-wide customer totals are hidden from staff who are restricted to one location.</p>
<h3>Products listed</h3><p>The current number of published products. It is not a count of products sold during the selected period.</p>
<h2>New versus returning customers</h2>
<p>This card looks at recognized orders that are linked to customer accounts. A customer is <strong>new</strong> when their first accessible recognized order falls inside the selected period; otherwise they are <strong>returning</strong>. Guest checkouts without a customer account are excluded, so the customer count may be lower than the order count.</p>
<h2>Inventory velocity</h2>
<p>Ranks products by sale-related stock reductions connected to recognized orders in the selected period and location scope. It shows up to the leading products. Manual adjustments, transfers, and unrelated stock changes are not treated as sales velocity.</p>
<h2>Recent activity</h2>
<p>Combines the latest relevant order, enquiry, and blog activity in the selected period. It is designed as a work summary, not a financial total.</p>
<h2>Enquiries</h2>
<p>Summarizes customer enquiries by status and links to the enquiry workflow. The card only appears when your role can access enquiries.</p>
<h2>Blog approvals</h2>
<p>Shows blog submissions awaiting review and links to blog management. The card only appears when your role has the relevant content permission.</p>
<h2>Missing a card?</h2>
<p>A card may be unavailable because of your role, location restriction, plan, a StoreMink platform setting, or because it has been removed from your personal dashboard layout. Try <strong>Edit dashboard</strong>, or ask an account owner to check your permissions.</p>$article$,
    'published',
    'Understand StoreMink customer, inventory, and activity analytics',
    'Definitions for StoreMink customer snapshots, new and returning customers, inventory velocity, recent activity, enquiries, and blog approvals.',
    4
  ),
  (
    'understand-google-search-analytics',
    'Understand Google Search analytics',
    'Learn what clicks, impressions, search CTR, average position, queries, and landing pages mean and why Google Search data can be delayed.',
    $article$<p>Google Search cards show how your StoreMink storefront performed in Google Search. StoreMink securely manages the Search Console connection for supported storefront hosts, so you do <strong>not</strong> need to enter a personal Search Console property ID on the Analytics page.</p>
<h2>Search metrics</h2>
<h3>Google Search clicks</h3><p>The number of times someone clicked a Google Search result that led to your storefront.</p>
<h3>Google Search impressions</h3><p>The number of times a storefront result was shown in Google Search under Google's reporting rules.</p>
<h3>Search click-through rate</h3><p><strong>Clicks divided by impressions, multiplied by 100.</strong> It estimates how often an impression became a click.</p>
<h3>Average search position</h3><p>The impression-weighted average position reported by Google. A lower number generally means a result appeared nearer the top. It is an average across searches, pages, devices, and locations, not a guaranteed ranking seen by everyone.</p>
<h3>Google Search performance</h3><p>A time chart that plots clicks and impressions across the selected period. Use it to spot changes, then open the query or landing-page details to investigate what contributed to them.</p>
<h3>Top Google searches</h3><p>The search queries that produced the most clicks, then impressions, for the storefront in the selected range.</p>
<h3>Top search landing pages</h3><p>The storefront pages that received the most Google Search clicks, then impressions.</p>
<h2>Why data is delayed</h2>
<p>Google Search performance is not a live counter. StoreMink imports Google's available data on a schedule, and recent days are commonly incomplete for about two days. Search dates follow Google's Pacific Time reporting calendar, which can differ from your StoreMink business time zone.</p>
<h2>Dashboard states</h2>
<ul><li><strong>Not launched:</strong> the storefront is not ready for public Search reporting.</li><li><strong>Collecting:</strong> StoreMink is waiting for enough Google data to arrive.</li><li><strong>No visibility:</strong> the connection works but Google reported no measurable visibility for the selected range.</li><li><strong>Ready:</strong> current imported metrics are available.</li><li><strong>Delayed or error:</strong> StoreMink could not refresh the latest data. Previously imported data may remain visible with a warning.</li></ul>
<h2>Why query totals may not match overall totals</h2>
<p>Google can omit uncommon or sensitive search queries to protect privacy. The sum of visible query rows can therefore be smaller than the overall clicks or impressions shown in summary cards.</p>
<h2>Custom domains and domain changes</h2>
<p>Search history belongs to the storefront source that produced it. When a store moves between its StoreMink subdomain and a custom domain, old data remains historical and the new source starts collecting separately. This avoids mixing two hosts into a misleading trend.</p>
<h2>If no data appears</h2>
<ol><li>Confirm the storefront is publicly launched and its pages are indexable.</li><li>Choose a date range that ends at least a few days ago.</li><li>Remove any expectation that a physical-location filter changes Search data.</li><li>Wait for Google processing and the next StoreMink sync.</li><li>If a delayed/error message remains for more than 72 hours, contact StoreMink support with the store domain and screenshot.</li></ol>$article$,
    'published',
    'Understand Google Search analytics in StoreMink',
    'Understand Google Search clicks, impressions, CTR, position, queries, landing pages, reporting delays, privacy filtering, and domain changes.',
    5
  ),
  (
    'analytics-reports-and-csv',
    'Use detailed Analytics reports and CSV exports',
    'Open detailed reports, keep dashboard filters, and safely export up to 10,000 rows for Excel, Google Sheets, or another spreadsheet.',
    $article$<p>Detailed reports help you move from a dashboard summary to the rows behind it. StoreMink currently provides reports for <strong>Total sales</strong>, <strong>Sales over time</strong>, <strong>Top products</strong>, and <strong>Google Search queries</strong>.</p>
<h2>Open a detailed report</h2>
<ol><li>Open <strong>Analytics</strong>.</li><li>Choose the date range, comparison, and location you need.</li><li>Open a supported card's report link.</li></ol>
<p>The report keeps the dashboard filters. Commerce reports keep the permitted location scope. Google Search queries describe the online storefront and ignore the physical-location filter.</p>
<h2>Understand the on-screen table</h2>
<p>The page shows up to 250 rows so it remains fast and readable. Use the report summary and column headings to confirm you opened the correct period before exporting.</p>
<h2>Export a CSV file</h2>
<ol><li>Open the detailed report.</li><li>Select <strong>Export CSV</strong>.</li><li>Save the downloaded file.</li><li>Open it in Excel, Google Sheets, Numbers, or another spreadsheet application.</li></ol>
<p>An export can contain up to 10,000 rows. It uses the same validated store, permission, date, and location scope as the report. StoreMink includes spreadsheet-safe formatting to prevent text values from being interpreted as formulas.</p>
<h2>Check an export before sharing it</h2>
<ul><li>Confirm the date range and location in the file name or report context.</li><li>Keep currency values as numbers when creating totals.</li><li>Remember that product merchandise value and net Total sales answer different questions.</li><li>Treat search queries as potentially privacy-filtered by Google.</li><li>Do not share customer or business data with people who should not have dashboard access.</li></ul>
<h2>If the export is empty</h2>
<p>Return to the report and check whether it has rows for the same filters. Then broaden the date range, check the location, and confirm your role can access that entity. If the report itself is unavailable, StoreMink may have disabled drill-down reports or your plan may not include the feature.</p>$article$,
    'published',
    'Use StoreMink Analytics reports and CSV exports',
    'Open StoreMink detailed analytics reports and export safe CSV files with the correct date, location, and permission filters.',
    6
  ),
  (
    'customize-analytics-dashboard',
    'Customize your Analytics dashboard',
    'Add, remove, move, and resize Analytics cards, organize sections, save a personal layout, or reset to the StoreMink default.',
    $article$<p>You can arrange Analytics around the work you do most often. A saved layout is personal to your staff account; it does not change another user's dashboard or change anyone's data permissions.</p>
<h2>Enter editing mode</h2>
<ol><li>Open <strong>Analytics</strong>.</li><li>Select <strong>Edit dashboard</strong>.</li></ol>
<p>The normal dashboard navigation is hidden while editing so the card library and placement grid have enough space. The dashed grid shows exactly how much space each card will use.</p>
<h2>Add a card</h2>
<ol><li>Use Search in the card library, or browse its Sales, Customers, Inventory, Content, and Search groups.</li><li>Select a card name or its add control.</li><li>Place it in an available area of the grid.</li></ol>
<p>Only cards available to your role, plan, and enabled StoreMink features can be added.</p>
<h2>Move and resize cards</h2>
<ul><li>Drag a card by its handle to move it.</li><li>Use the card size control when more than one supported size is available.</li><li>Follow the highlighted grid area: it represents the complete space the card will occupy.</li></ul>
<p>StoreMink prevents overlapping layouts and keeps card sizes within supported bounds so the page remains usable on different screens.</p>
<h2>Remove a card</h2>
<p>Select the remove control on the card. This only removes it from your layout; it does not delete store data. You can add it again from the card library.</p>
<h2>Organize sections</h2>
<p>Add sections when you want to group cards by a job, such as Sales, Search, or Daily operations. Section order and card placement are saved with your personal layout.</p>
<h2>Save, cancel, or reset</h2>
<ul><li><strong>Save</strong> keeps the edited layout.</li><li><strong>Cancel</strong> leaves editing without keeping the current unsaved changes.</li><li><strong>Reset to default</strong> replaces your personal arrangement with StoreMink's default dashboard.</li></ul>
<h2>If a saved card disappears</h2>
<p>A platform feature can be disabled, a plan can change, or your permission/location scope can change. StoreMink hides unavailable cards even if an older personal layout contains their IDs. Re-enabling access makes eligible cards available again.</p>$article$,
    'published',
    'Customize your StoreMink Analytics dashboard',
    'Add, remove, move, resize, and organize StoreMink Analytics cards and save or reset your personal dashboard layout.',
    7
  ),
  (
    'analytics-troubleshooting',
    'Troubleshoot Analytics',
    'Resolve zero values, unexpected totals, missing cards, delayed Google Search data, unavailable reports, and slow or failed dashboard loads.',
    $article$<p>Most Analytics questions can be resolved by checking the source, date, time zone, location, order state, and user permission in that order.</p>
<h2>A sales value is zero</h2>
<ol><li>Choose a range that includes the order creation date.</li><li>Check the business time zone in Settings.</li><li>Remove or change the location filter.</li><li>Confirm the order is paid, Cash on Delivery, or completed/refunded Point of Sale.</li><li>Confirm the order was not cancelled.</li></ol>
<h2>Total sales is lower than expected</h2>
<p>Completed refunds are subtracted on their settlement date. Check whether the selected period contains refunds for older orders. Also confirm you are not comparing product merchandise value, gross processor payments, or a Google/Meta attribution report with StoreMink net Total sales.</p>
<h2>A customer or product card ignores the date range</h2>
<p><strong>Total customers</strong> and <strong>Products listed</strong> are current snapshots. They describe the store now and intentionally do not change with the date range or show a comparison delta.</p>
<h2>A card is missing</h2>
<ul><li>Open <strong>Edit dashboard</strong> and search the card library.</li><li>Check whether your role has permission for the underlying area.</li><li>Check whether your account is restricted to a location.</li><li>Check whether the feature is included in the store's plan.</li><li>Ask StoreMink support whether the analytics module is currently enabled.</li></ul>
<h2>A report or CSV export is unavailable</h2>
<p>Only Total sales, Sales over time, Top products, and Google Search queries currently have detailed reports. Reports and exports can also be disabled independently of the overview dashboard.</p>
<h2>Google Search shows collecting or no data</h2>
<p>Search performance is delayed and recent days can be incomplete. Use a range ending several days ago, confirm the storefront is publicly launched, and wait for the next scheduled import. Google can also hide rare queries, so visible query rows may not add up to the summary.</p>
<h2>The dashboard is slow in local development</h2>
<p>Local development can compile a route the first time it is opened. Wait for compilation to finish, then refresh once. Avoid running multiple development servers for the same project. In a deployed environment, report a repeated slow load with the store, route, selected filters, approximate time, and a screenshot.</p>
<h2>An error remains</h2>
<p>Refresh the page once and try a simpler date range. If the problem continues, contact StoreMink support with:</p><ul><li>the store domain;</li><li>the Analytics page or report name;</li><li>the selected date range and location;</li><li>the exact error message;</li><li>the time it happened and a screenshot.</li></ul>
<p>Do not send passwords, payment card details, Google account credentials, or Meta account credentials.</p>$article$,
    'published',
    'Troubleshoot StoreMink Analytics',
    'Fix zero or unexpected analytics, missing cards, unavailable reports, CSV issues, delayed Google Search data, and Analytics errors.',
    8
  ),
  (
    'connect-google-analytics-4',
    'Connect Google Analytics 4',
    'Create a GA4 property and web stream, copy the Measurement ID, connect a StoreMink Pro storefront, confirm consent, and test collection.',
    $article$<p><strong>Upcoming Pro feature:</strong> This guide is ready for the planned StoreMink GA4 connection, but the connection is not yet available to merchants. StoreMink will publish this article when the setting ships.</p>
<h2>What GA4 does</h2>
<p>Google Analytics 4 measures how consenting visitors use your storefront and reports that activity inside your Google Analytics account. It is separate from StoreMink commerce analytics and Google Search cards. You can use a StoreMink subdomain such as <strong>https://your-store.storemink.com</strong>, or your connected custom domain, as the web stream URL.</p>
<h2>Before you begin</h2>
<ul><li>A Google account.</li><li>Editor access to the correct Google Analytics account or property.</li><li>Your complete public storefront URL, beginning with <strong>https://</strong>.</li><li>A StoreMink Pro plan when the integration becomes available.</li></ul>
<h2>Step 1: Create or choose a GA4 property</h2>
<ol><li>Open <a href="https://analytics.google.com/">Google Analytics</a> and sign in.</li><li>Select <strong>Admin</strong>.</li><li>Create an Analytics account if the business does not already have one.</li><li>Select <strong>Create</strong>, then <strong>Property</strong>, or choose the existing property that should receive this store's data.</li><li>Enter a clear property name, select the store's reporting time zone and currency, and complete Google's setup questions.</li></ol>
<p>Use one clearly named property/stream per business arrangement. Do not connect the store to a test property that nobody monitors.</p>
<h2>Step 2: Create a Web data stream</h2>
<ol><li>In Admin, open <strong>Data streams</strong> for the property.</li><li>Select <strong>Add stream</strong>, then <strong>Web</strong>.</li><li>Enter the public StoreMink subdomain or custom-domain URL.</li><li>Enter a recognizable stream name, such as the store name plus “Storefront”.</li><li>Review Enhanced measurement, then select <strong>Create stream</strong>.</li></ol>
<h2>Step 3: Copy the Measurement ID</h2>
<ol><li>Open the Web stream details.</li><li>Find <strong>Measurement ID</strong>.</li><li>Copy the full ID. A GA4 web Measurement ID normally begins with <strong>G-</strong>.</li></ol>
<p>Copy only the ID, not Google's full script. The Measurement ID is not an account password, but only trusted staff should control the Google property.</p>
<h2>Step 4: Connect it in StoreMink</h2>
<p>After the integration is released:</p><ol><li>Open StoreMink <strong>Settings</strong>, then <strong>Analytics</strong>.</li><li>Open <strong>Google Analytics 4</strong>.</li><li>Paste the Measurement ID without extra spaces.</li><li>Enable the connection and select <strong>Save</strong>.</li></ol>
<p>Do not also paste a Google tag into theme code. Installing the same tag twice can duplicate events.</p>
<h2>Step 5: Check visitor consent</h2>
<p>StoreMink will load GA4 only after the visitor gives the applicable analytics consent. A visitor who declines can keep shopping, but their browser activity must not be sent through this integration. Configure the storefront consent notice before relying on GA4 totals.</p>
<h2>Step 6: Test collection</h2>
<ol><li>Open the published storefront in a private/incognito window.</li><li>Accept analytics consent.</li><li>Visit a few pages.</li><li>In Google Analytics, open <strong>Reports</strong>, then <strong>Realtime</strong>.</li><li>Confirm that the visit or events appear for the correct property.</li></ol>
<p>Initial Realtime data can take roughly 10–30 minutes. Standard reports commonly need 24–48 hours. For event debugging, use Google's Realtime or DebugView tools.</p>
<h2>If GA4 does not receive data</h2>
<ul><li>Confirm the ID is from the intended Web stream and has no spaces.</li><li>Confirm the setting is enabled and saved in StoreMink.</li><li>Accept analytics consent during the test.</li><li>Temporarily test without an ad blocker or privacy extension.</li><li>Check that the tag was not also installed manually.</li><li>Make sure you are watching the correct Google property and Realtime report.</li><li>Allow enough time for Google to process the first events.</li></ul>
<h2>Official Google instructions</h2>
<ul><li><a href="https://support.google.com/analytics/answer/9304153">Set up Analytics for a website</a></li><li><a href="https://support.google.com/analytics/answer/10201247">Confirm that Analytics is collecting data</a></li><li><a href="https://support.google.com/analytics/answer/9322688">Verify and troubleshoot events</a></li></ul>$article$,
    'draft',
    'Connect Google Analytics 4 to StoreMink',
    'Create a GA4 property and web stream, find the G- Measurement ID, connect a Pro StoreMink storefront, apply consent, and test Realtime data.',
    9
  ),
  (
    'connect-meta-pixel',
    'Connect a Meta Pixel',
    'Create a Meta web dataset, find its numeric Pixel ID, connect a StoreMink Pro storefront, apply marketing consent, and test browser events.',
    $article$<p><strong>Upcoming Pro feature:</strong> This guide is ready for the planned StoreMink Meta Pixel connection, but the connection is not yet available to merchants. StoreMink will publish this article when the setting ships.</p>
<h2>What Meta Pixel does</h2>
<p>Meta Pixel sends permitted browser events from the storefront to a Meta web dataset. Businesses commonly use those events for Meta advertising measurement and audiences. It is separate from StoreMink sales analytics and does not replace StoreMink order records.</p>
<h2>Before you begin</h2>
<ul><li>Access to the business in Meta Business tools and Events Manager.</li><li>Permission to create or manage the correct web dataset.</li><li>Your complete public storefront URL.</li><li>A StoreMink Pro plan when the integration becomes available.</li></ul>
<h2>Step 1: Create or choose a web dataset</h2>
<ol><li>Open <a href="https://business.facebook.com/events_manager2">Meta Events Manager</a>.</li><li>Select the correct business account.</li><li>Select <strong>Connect data</strong>.</li><li>Choose <strong>Web</strong>, then select <strong>Connect</strong>.</li><li>Enter a clear name for the dataset/pixel and complete Meta's prompts.</li><li>Enter the StoreMink subdomain or connected custom-domain URL when requested.</li></ol>
<p>Meta may use the term <strong>dataset ID</strong> in newer screens. For a web dataset created for Pixel events, that dataset ID is the same identifier used as the Pixel ID.</p>
<h2>Step 2: Copy the Pixel ID</h2>
<ol><li>In Events Manager, open the correct dataset.</li><li>Open its overview or settings.</li><li>Copy the numeric dataset/Pixel ID.</li></ol>
<p>Copy only the number, not an entire JavaScript snippet. The Pixel ID is not a Meta account password, but access to the business and dataset should be limited to trusted staff.</p>
<h2>Step 3: Connect it in StoreMink</h2>
<p>After the integration is released:</p><ol><li>Open StoreMink <strong>Settings</strong>, then <strong>Analytics</strong>.</li><li>Open <strong>Meta Pixel</strong>.</li><li>Paste the numeric Pixel ID without spaces.</li><li>Enable the connection and select <strong>Save</strong>.</li></ol>
<p>Do not also paste Meta's Pixel script into theme code. Installing it twice can create duplicate browser events. A basic Pixel connection does not automatically mean that Meta Conversions API server events are enabled; StoreMink will name that capability separately if it is introduced.</p>
<h2>Step 4: Check visitor consent</h2>
<p>StoreMink will load Meta Pixel only after the visitor gives the applicable marketing consent. A visitor who declines can continue shopping, but their browser must not send events through this integration. Configure the storefront consent notice before using the Pixel for advertising measurement.</p>
<h2>Step 5: Test the connection</h2>
<ol><li>In Events Manager, select the connected dataset and open <strong>Test events</strong>.</li><li>Open the published storefront in a private/incognito window.</li><li>Accept marketing consent.</li><li>Visit a page and perform the actions supported by the StoreMink integration.</li><li>Return to Test events and check that browser events arrive under the intended dataset.</li></ol>
<p>You can also use Meta's official Pixel Helper browser extension as a diagnostic aid. An ad blocker or browser privacy protection can intentionally stop Pixel requests.</p>
<h2>Using a StoreMink subdomain</h2>
<p>Basic browser tracking can use a URL such as <strong>https://your-store.storemink.com</strong>. However, a merchant does not own the parent <strong>storemink.com</strong> domain. If Meta asks the business to prove independent ownership of a domain for a particular feature, connect and verify a custom domain that the business owns.</p>
<h2>If Meta does not receive events</h2>
<ul><li>Confirm you copied the numeric ID from the intended dataset.</li><li>Confirm the StoreMink setting is enabled and saved.</li><li>Accept marketing consent during the test.</li><li>Test without an ad blocker or strict privacy extension.</li><li>Remove any duplicate manually installed Pixel code.</li><li>Confirm you have permission to view Test events for the dataset.</li><li>Make sure Events Manager is showing the same business and dataset you connected.</li></ul>
<h2>Official Meta instructions</h2>
<p><a href="https://www.facebook.com/help/messenger-app/952192354843755">Set up and install the Meta Pixel</a></p>$article$,
    'draft',
    'Connect a Meta Pixel to StoreMink',
    'Create a Meta web dataset, find the Pixel ID, connect a Pro StoreMink storefront, apply marketing consent, and verify Test events.',
    10
  )
) AS document(
  slug, title, excerpt, body, status, seo_title, seo_description, position
)
ON CONFLICT (slug) DO UPDATE
SET category_id = EXCLUDED.category_id,
    title = EXCLUDED.title,
    excerpt = EXCLUDED.excerpt,
    body = EXCLUDED.body,
    status = EXCLUDED.status,
    seo_title = EXCLUDED.seo_title,
    seo_description = EXCLUDED.seo_description,
    position = EXCLUDED.position,
    published_at = CASE
      WHEN EXCLUDED.status = 'published'
        THEN COALESCE(existing.published_at, EXCLUDED.published_at, now())
      ELSE NULL
    END,
    updated_at = now();
