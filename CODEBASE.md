# StoreMink — Codebase Map

> **Read this file first before making any change. Keep it up to date:** whenever you
> add/remove/move routes, server actions, lib modules, SQL files, or change the
> architecture, update the relevant section here in the same commit.

## 1. What this project is

**StoreMink** (storemink.com) is a multi-tenant, no-code D2C SaaS platform — a
Shopify-style product. Anyone can sign up, create their own store, and start
selling within a day. Every store gets:

- A **storefront** on its own subdomain (`{slug}.storemink.com`) or a verified custom domain.
- A full **admin dashboard** (`/dashboard`) to manage products, orders-adjacent data, blogs, marketing, users, branding, and settings — all no-code.

The codebase began as **WholeSip** (a single D2C juice brand, store #1) and was
converted to multi-tenant in phases. It still exists as the fallback store
(`FALLBACK_STORE_ID = a0000000-0000-4000-8000-000000000001` in `lib/store/resolve.ts`),
so some naming (repo name `wholesip`, `brand/`) is legacy. The `--wholesip-*` CSS
tokens were renamed to `--sm-*` and `WHOLESIP_STORE_ID` to `FALLBACK_STORE_ID`.

## 2. Tech stack

| Layer     | Tech                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework | Next.js 16 (App Router, `--turbopack` dev) — **breaking-changes version; read `node_modules/next/dist/docs/` before writing code** (see AGENTS.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| UI        | React 19, Tailwind CSS v4, shadcn/ui (`components/ui/`), Base UI, lucide-react, sonner (toasts), recharts (charts), TipTap (rich-text editor), CodeMirror 6 (`@uiw/react-codemirror` — website-builder code editor, lazy-loaded)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Backend   | Supabase (Postgres + Auth + Storage + RLS), server actions in `app/actions/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Email     | Resend + nodemailer (`lib/email/`), Vercel cron `/api/cron/send-emails` (daily, `vercel.json`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AI        | Gemini (`lib/ai/gemini.ts`); per-store brand voice (`lib/ai/brand-voice.ts` + `store_brand_profiles`) with plan-capped usage metering (`lib/ai/quota.ts`); task prompts in `brand/tasks/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Testing   | Vitest + Testing Library + jsdom, coverage via v8 (`coverage/` is generated output — never edit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Browsers  | **`browserslist` in package.json is the stated floor: Chrome/Edge 111, Firefox 128, Safari/iOS 16.4.** Not a preference — Tailwind v4 depends on `@property` and `color-mix()` and does not work below it, so this records a constraint a dependency already imposed rather than inventing one. Two authored CSS features sit BELOW that floor and so are always available: `:has()` (Chrome 105+/Safari 15.4+/Firefox 121+) and container queries (Chrome 105+/Safari 16+/Firefox 110+), both used by the dashboard table compaction, which is nonetheless wrapped in `@supports selector(:has(+ *)) and (container-type: inline-size)` so the dependency is stated where it is used and stays graceful if the floor is ever lowered. **⚠ There is NO cross-browser test infrastructure** — vitest runs in jsdom, which renders nothing. Chrome is the only browser this has been exercised in |
| Deploy    | Vercel (current); **migrating to Google Cloud Run** (Dockerfile + cloudbuild.yaml, GCP Phase 4 — see docs/gcp-migration-phase4-cloud-run.md). CI on GitHub Actions (`.github/workflows/ci.yml`: lint → typecheck → test → prettier → build)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 3. Multi-tenancy architecture (the core concept)

Every request belongs to exactly one store, resolved from the **Host header**.

### Host routing — `proxy.ts` (edge middleware, runs on everything except `_next` statics & `/api`)

| Host                                                         | Behavior                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `help.storemink.com` / `help.localhost`                      | Rewritten to `/help/*`                                                                                            |
| `storemink.com`, `www.`, `app.`, `localhost`, `*.vercel.app` | **Platform** — all paths rewritten into `/platform/*` (landing, signup, platform login, platform admin dashboard) |
| `{slug}.storemink.com`, `{slug}.localhost`                   | **Store subdomain** — storefront + `/dashboard` + `/auth` served directly                                         |
| Anything else                                                | **Custom domain** — must have `settings.custom_domain_verified === true` to resolve                               |

`proxy.ts` also gates auth: `/dashboard` requires a valid **Firebase session
cookie** (`sm_session`; redirect to `/auth/login`), enforces
`force_password_reset` → `/auth/set-password`, and restricts `/dashboard/users`

- `/dashboard/media` to role `superadmin`. The `role`/`force_password_reset`
  custom claims + the uid are read straight from the verified session cookie (no
  DB query). Next.js 16 `proxy.ts` runs on the **Node runtime** by default, so it
  verifies the cookie with `firebase-admin` directly (no edge/`jose` workaround).
  Storefront paths skip the session check entirely (anonymous + cache-friendly).
  Paths with a file extension (public/ assets like `/themes/...webp`) pass
  through untouched on EVERY host — the platform/help rewrites would otherwise
  404 them.

### Tenant resolution — `lib/store/`

- `host.ts` — pure host classification (`parseHost`, `isPlatformHost`, `isHelpHost`, `cookieDomainForHost`). No Node imports; safe on edge. `ROOT_DOMAIN` from `NEXT_PUBLIC_ROOT_DOMAIN` (default `storemink.com`). Cookies are scoped to `.storemink.com` so a session spans platform + all store subdomains.
- `resolve.ts` — DB-backed store lookup, cached with `unstable_cache` (tag `STORE_TAG = "stores"`, 300 s revalidate). Three resolvers: `getCurrentStoreOrNull()` (honest — null when the host maps to no active store); `getCurrentStore()`/`getCurrentStoreId()` (never-null — fall back to WholeSip; for dashboard/actions/internal callers that must always have a store id); **`requireStorefrontStore()`/`requireStorefrontStoreId()`** (render-only — `notFound()` on an unknown host). **Storefront PAGES must use the `require…` variants** (the `(storefront)` layout guards too, but a layout `notFound()` does NOT abort concurrently-rendering child pages, so each content page guards itself — otherwise an unclaimed subdomain streams the WholeSip fallback content into its HTML). Unknown store host → root `app/not-found.tsx` ("store doesn't exist"); missing page within a real store → `app/(storefront)/not-found.tsx` ("page not found", with store chrome). **Call `revalidateTag(STORE_TAG)` after any store create/settings/domain change.**
- `brand.ts` — per-store branding (colors/logo) consumed by `app/(storefront)/components/brand-provider.tsx`.

**Rule: every DB read/write for store data must be scoped by `store_id`** (RLS also enforces this — see `supabase/multitenant_03_rls.sql`).

## 4. Directory structure

```
wholesip/
├── AGENTS.md / CLAUDE.md      # Agent instructions (CLAUDE.md just imports AGENTS.md)
├── CODEBASE.md                # ← this file
├── proxy.ts                   # Edge middleware: host routing + auth gates (see §3)
├── next.config.ts             # output:"standalone" (Cloud Run), image formats, brand/
│                              # file tracing, optimizePackageImports
├── Dockerfile / .dockerignore / cloudbuild.yaml  # ★ Cloud Run container (GCP Phase 4 —
│                              # see docs/gcp-migration-phase4-cloud-run.md). Multi-stage
│                              # standalone build; NEXT_PUBLIC_* are build args, secrets
│                              # runtime-only. Build linux/amd64 (Cloud Build or --platform).
├── vercel.json                # Crons: send-emails + plan-expiry (daily),
│                              # expire-pending-payments (daily on Hobby) — moving to
│                              # Cloud Scheduler at Cloud Run cutover (Phase 4)
├── vitest.config.ts / vitest.setup.ts / vitest.server-only-stub.ts
├── eslint.config.mjs / postcss.config.mjs / tsconfig.json / components.json
│
├── app/
│   ├── layout.tsx             # Root layout
│   ├── globals.css
│   ├── loading.tsx
│   ├── robots.ts / sitemap.ts
│   │
│   ├── (storefront)/          # ★ THE STORE WEBSITE (served on store hosts)
│   │   ├── layout.tsx         # Storefront shell: Header/Footer, BrandProvider, Auth+Cart providers
│   │   ├── page.tsx           # Store homepage = store_pages row with slug "" (the
│   │   │                      # "homepage sentinel"); reads published/preview sections
│   │   │                      # just like [pageSlug]. Edited in /dashboard/builder (§11)
│   │   ├── storefront-theme.css
│   │   ├── (pages)/           # Customer-facing pages:
│   │   │   ├── shop/          #   product listing + [slug] product detail (reviews, related)
│   │   │   ├── cart/          #   cart page (CartProvider-driven)
│   │   │   ├── checkout/      #   COD checkout (auth-gated client page → placeOrder) +
│   │   │   │                  #   success/ order-confirmation page. RESERVED slug.
│   │   │   ├── blogs/         #   blog listing, [slug] detail (comments/reactions),
│   │   │   │                  #   write/ (TipTap customer blog editor), my-submissions/
│   │   │   ├── enquiries/     #   enquiry form (tested)
│   │   │   ├── orders/        #   ★ the SHOPPER's order history (§22): list +
│   │   │   │                  #   [id] detail (status timeline, items, totals,
│   │   │   │                  #   invoice link). Double-locked: withUser (RLS
│   │   │   │                  #   customer_id = auth.uid()) AND host store id
│   │   │   ├── notifications/ #   ★ the SHOPPER's notification centre (§22) —
│   │   │   │                  #   the customer rows the fan-out has always
│   │   │   │                  #   written, finally rendered
│   │   │   ├── profile/       #   customer profile (personal info + address-book
│   │   │   │                  #   card + quick links to orders/notifications)
│   │   │   └── [pageSlug]/    #   ★ ALL content pages from store_pages (see §11): merchant
│   │   │                      #   custom pages AND the former hardcoded static pages
│   │   │                      #   (our-story, faqs, …) — retired in Phase 4b, now editable
│   │   │                      #   rows. Published path (cached) + ?preview=1 draft path
│   │   │                      #   (uncached, admin-gated). Only INTERACTIVE routes above
│   │   │                      #   stay in code + RESERVED (registry.ts + drift test).
│   │   └── components/
│   │       ├── auth/          # AuthModal + AuthProvider (customer auth context)
│   │       ├── cart/          # CartProvider, CartDrawer, CouponField
│   │       ├── header/ footer/  # nav from store_menus via MenuProvider (§11 menu builder)
│   │       ├── homepage/      # Shared per-section renderer (featured products,
│   │       │                  # blog carousel, promo banner, shop-by-category…)
│   │       ├── sections/      # ★ Generalized section renderer shared by homepage + pages:
│   │       │                  # page-section-renderer, custom-code-frame (sandboxed iframe),
│   │       │                  # custom-code-section, rich-text-section, hero-section,
│   │       │                  # usp-bar-section, ticker-section, tile-grid-section,
│   │       │                  # faq-accordion-section,
│   │       │                  # preview-bridge, draft-canvas (client-side instant
│   │       │                  # builder preview, §11), builder-overlay
│   │       ├── brand-provider.tsx   # Injects per-store branding CSS vars
│   │       ├── menu-provider.tsx    # Supplies per-store header/footer nav (store_menus)
│   │       ├── shop-card.tsx / share-buttons.tsx
│   │       ├── structured-data.tsx  # homepage Organization + WebSite JSON-LD
│   │       ├── json-ld.tsx          # generic <JsonLd> renderer (builders: lib/seo)
│   │       ├── quick-add-button.tsx # "+ Add" on product cards (theme layout.card
│   │       │                        # = "quick_add"; hidden by CSS otherwise)
│   │
│   ├── dashboard/             # ★ STORE ADMIN DASHBOARD (per-store, auth-gated)
│   │   ├── layout.tsx         # Sidebar + topbar shell (dashboard.css)
│   │   ├── page.tsx           # Overview: metrics, revenue chart, activity, inventory…
│   │   ├── analytics/         # ★ Performance dashboard (§20): data.ts (live per-store
│   │   │                      # aggregates), widgets.ts (widget registry + default
│   │   │                      # layout), dashboard-canvas.tsx (client: "Edit dashboard" —
│   │   │                      # drag-reorder, remove, add-section, localStorage layout)
│   │   ├── components/        # Dashboard widgets (metric-card, revenue-chart,
│   │   │                      # recent-orders-table, activity-feed, bulk-actions…) +
│   │   │                      # feature-toggles (shared settings-group card, convention #9)
│   │   │                      # ★ A wide list table (`dash-table-wide`) sets an
│   │   │                      # 800px floor, but opening the Mink AI panel leaves
│   │   │                      # the content region ~755px — so every list page
│   │   │                      # scrolled horizontally and columns were clipped.
│   │   │                      # FIX (dashboard.css, two layers): (1) a CONTAINER
│   │   │                      # query on the card — below 880px the floor drops to
│   │   │                      # 0 and cell padding goes 22px → 10px, which reclaims
│   │   │                      # ~150-190px (6 cols spend 264px on padding, 8 cols
│   │   │                      # 352px) and lets everything FIT rather than scroll.
│   │   │                      # A container query, not a media query: card width
│   │   │                      # depends on the panel, the resizable sidebar AND the
│   │   │                      # viewport, so a viewport breakpoint is wrong as soon
│   │   │                      # as any one of them moves. Enquiries/Customers set
│   │   │                      # their own wider floors LOWER in the file and must be
│   │   │                      # named explicitly or they win on source order.
│   │   │                      # (2) the row-actions column is pinned right
│   │   │                      # (`dash-col-actions` on the <th> AND its <td>) as a
│   │   │                      # backstop for widths even (1) can't fit. Opt-in, NOT
│   │   │                      # `:last-child`: the column is conditional on
│   │   │                      # canManage/canEdit, so for a view-only role the last
│   │   │                      # column is real data. No JS either way — sticky is
│   │   │                      # inert once the table fits.
│   │   │                      # ⚠ Order matters: the compact block must sit AFTER
│   │   │                      # the base `.dash-table th/td` padding rules or the
│   │   │                      # shorthand `padding` beats it at equal specificity.
│   │   ├── lib/               # access.ts, permissions.ts (role → allowed nav/actions;
│   │   │                      # ★ SECTIONS is grouped by JOB — Workspace / Sell in
│   │   │                      # person / Storefront / Marketing / Settings — and a
│   │   │                      # section may set `parent` to render NESTED under
│   │   │                      # another while keeping its own permission key. That
│   │   │                      # distinction is load-bearing: `children` are rendered
│   │   │                      # with NO can() check, so anything separately gated
│   │   │                      # (Categories, Colours, Inventory, Enquiries, and every
│   │   │                      # Settings area) must stay a section. foldNestedSections()
│   │   │                      # does the folding AFTER the permission filter, never
│   │   │                      # mutates the shared catalog, bubbles a nested badge up
│   │   │                      # to a parent that has none (Enquiries' unread count
│   │   │                      # reaching Customers — otherwise nesting would hide it),
│   │   │                      # and leaves an orphan top-level when its parent was
│   │   │                      # filtered out. Tested. ⚠ Sidebar badges are for counts
│   │   │                      # that DEMAND action and go away once handled. Orders
│   │   │                      # carried a hardcoded "12" and Inventory a permanent
│   │   │                      # low-stock total; both are gone — a number that never
│   │   │                      # moves teaches people to ignore the ones that do),
│   │   │                      # list-params.ts, use-row-selection.ts. ★ access.ts never
│   │   │                      # swallows a DB error into an access decision (the
│   │   │                      # resolve.ts rule): getViewerContext returns
│   │   │                      # `dbError: true` → layout shows an outage, NOT "no
│   │   │                      # access"; getManagerUserId THROWS rather than
│   │   │                      # returning a false "not authorized". Tested in
│   │   │                      # access.test.ts.
│   │   ├── products/          # CRUD; edit = full page [id]/ (Shopify-style, no modal)
│   │   ├── orders/            # Orders list (server-paginated) — reads order-actions
│   │   ├── categories/ colors/ blogs/ media/   # content management (media/ = the
│   │   │                      # per-store Media Library: confirm-first upload + grid +
│   │   │                      # view + copy-URL + delete (media_assets row + GCS object),
│   │   │                      # via app/actions/media-actions.ts)
│   │   │   └── blogs/settings/  # blog feature toggles + per-store categories/tags manager
│   │   │   (homepage editor RETIRED in Phase 4a — the homepage is now edited in builder/)
│   │   ├── navigation/        # ★ Menu builder (§11): edit header + footer nav (store_menus)
│   │   ├── builder/           # ★ Website Builder full-tab experience (see §11): pages list
│   │   │                      # (incl. the pinned Home = slug "") + live preview iframe +
│   │   │                      # per-section editing. builder-client, outline-panel,
│   │   │                      # inspector-panel, section-form + field-group (shared editor
│   │   │                      # forms), section-library + section-thumbs (visual add-section
│   │   │                      # picker), use-autosave, use-history (undo/redo),
│   │   │                      # use-builder-shortcuts, code-editor(+-lazy) (CodeMirror),
│   │   │                      # builder.css (tokenised on --dash-*)
│   │   │   └── settings/      # Website settings ("Website" registry group, e.g.
│   │   │                      # pages.customCode) — linked from the builder top bar
│   │   ├── marketing/coupons/ # coupon CRUD + coupon email campaigns
│   │   ├── enquiries/         # enquiry inbox + @modal detail
│   │   ├── users/             # customers + user_groups/ (segments)  [superadmin only]
│   │   ├── admins/ roles/     # staff invites + role management
│   │   ├── branding/          # per-store branding editor (logo, colors)
│   │   ├── billing/           # ★ Invoices & Billing (§17): tax config + tax-class
│   │   │                      # manager + invoice-template editor (billing.css)
│   │   ├── channels/          # ★ Channels (§18): connect the store's OWN Razorpay
│   │   │                      # gateway (verify & save, pause/resume, disconnect)
│   │   ├── ai/                # ★ AI usage (§16): monthly bar + credit balance +
│   │   │                      # ledger + buy-credit packs (platform Razorpay)
│   │   ├── orders/[id]/invoice/  # ★ printable invoice for one order (§17)
│   │   ├── activity/          # ★ Activity & audit trail (§22): the store's
│   │   │                      # activity_events feed — filters by category/date,
│   │   │                      # day-grouped. Fills the long-dead `activity` nav link
│   │   └── settings/          # account/ + domain/ + ★ notifications/ (§22 CONSOLE:
│   │                          # list → [key] detail with General + per-channel
│   │                          # tabs; me/ = personal opt-outs);
│   │                          # feature toggles live on their feature's own page
│   │                          # (e.g. blogs → blogs/settings — see convention #9)
│   │
│   ├── platform/              # ★ STOREMINK PLATFORM (served on storemink.com via rewrite)
│   │   ├── page.tsx           # Marketing landing page
│   │   ├── signup/            # ★ Store creation wizard (see §19): Shopify-style
│   │   │                      # step order — email → password (+ Continue with
│   │   │                      # Google) → phone OTP → name → store + location →
│   │   │                      # theme → plan (Razorpay autopay for paid plans).
│   │   │                      # Firebase: Google via signInWithPopup (no callback
│   │   │                      # route), phone via signInWithPhoneNumber.
│   │   ├── login/             # Platform-operator login — Firebase email-LINK sign-in
│   │   └── dashboard/         # Platform-admin console: stores-console, operators-console
│   │                          # (guarded by supabase/multitenant_07_platform_admins.sql)
│   │                          # (the OAuth callback route was removed in Phase 6 —
│   │                          # Google now uses signInWithPopup)
│   │
│   ├── api/auth/              # ★ Phase 6 session bridge: session/route.ts (ID token →
│   │                          # httpOnly Firebase session cookie), signout/route.ts (clear it)
│   ├── auth/                  # Store-host auth: login (email+pw + Google popup),
│   │                          # forgot/set/update-password (Firebase; callback route removed)
│   ├── help/                  # Help centre (served at help.storemink.com)
│   │
│   ├── actions/               # ★ ALL SERVER ACTIONS ("use server") — one file per domain:
│   │   │                      # product/category/color/coupon/coupon-email/blog/blog-social/
│   │   │                      # review/enquiry/customer/customer-profile/
│   │   │                      # account-settings/set-password/invite-user/user-management/
│   │   │                      # user-group/role actions  (homepage-actions RETIRED — §11)
│   │   ├── store-signup.ts    # Store onboarding (§19): checkStoreSlugAvailability,
│   │   │                      # createStore({name,template,firstName,lastName,
│   │   │                      # country,city}) — writes admins name + settings.
│   │   │                      # business location, returns {slug,storeId} —,
│   │   │                      # getSignupResumeInfo (resume wizard after Google
│   │   │                      # redirect / refreshed tab)
│   │   ├── store-branding.ts  # Per-store branding updates
│   │   ├── store-settings.ts  # Read/save per-store feature settings (see lib/settings)
│   │   ├── blog-taxonomy-actions.ts  # Per-store blog categories/tags CRUD (+ propagation into blogs)
│   │   ├── billing-actions.ts # ★ Invoices & tax (§17): tax-class CRUD + save billing/
│   │   │                      # invoice settings. Gated on `billing`, revalidates TAGS.billing.
│   │   ├── store-domain.ts    # Custom domain connect + DNS verification (Resend)
│   │   ├── page-actions.ts    # ★ Custom-page CRUD + draft/publish (see §11): createPage/
│   │   │                      # updatePageMeta/savePageDraft/publishPage/unpublishPage/
│   │   │                      # deletePage/ensureHomepage, gated builder, service-role
│   │   ├── menu-actions.ts    # ★ Per-store nav read/save (see §11 menu builder, store_menus)
│   │   ├── checkout-actions.ts # ★ placeOrder (COD + razorpay — §12/§18): re-prices from
│   │   │                      # DB, store-scoped by host, re-validates coupon, rate-limited,
│   │   │                      # SERVICE-ROLE writes (no customer INSERT policy — convention
│   │   │                      # #12); getCheckoutConfig + confirmOnlinePayment (HMAC) +
│   │   │                      # reconcileMyOrderPayment. Tested.
│   │   ├── payment-provider-actions.ts # ★ Channels (§18): get/save/enable/disconnect the
│   │   │                      # store's BYO Razorpay creds (verified, encrypted, plan-gated). Tested.
│   │   ├── ai-credit-actions.ts # ★ AI credits (§16): usage-page data + reconcile,
│   │   │                      # startCreditPurchase/confirmCreditPurchase (platform Razorpay).
│   │   ├── order-actions.ts   # ★ getOrders (paginated) + updateOrderStatus (allowlisted
│   │   │                      # status/payment_status, store-scoped). Tested.
│   │   ├── customer-order-actions.ts # ★ A shopper's OWN orders (§22):
│   │   │                      # getMyOrders/getMyOrder. withUser + host store —
│   │   │                      # RLS alone would show an order placed on a
│   │   │                      # DIFFERENT store while browsing this one.
│   │   ├── customer-notification-actions.ts # ★ The shopper's notification
│   │   │                      # centre (§22): list/unread/mark-read over the
│   │   │                      # same notifications table the staff bell uses,
│   │   │                      # scoped to recipient_type 'customer' + host store
│   │   ├── notification-actions.ts # ★ Notifications (§22): inbox + unread count
│   │   │                      # (the bell polls it), mark read/all-read/archive,
│   │   │                      # activity feed, preference get/save, pruneNotifications.
│   │   │                      # Scope = HOST-derived (store, or platform when
│   │   │                      # storemink.com) — never getCurrentStoreId()'s fallback.
│   │   ├── address-actions.ts # ★ Customer saved-address book (own-row RLS, tested):
│   │   │                      # getMyAddresses, saveAddress (checkout dedup+default),
│   │   │                      # upsertAddress (profile add/edit), setDefaultAddress,
│   │   │                      # deleteAddress. Prefills checkout + /profile address book.
│   │   ├── platform.ts        # Platform-admin actions
│   │   └── _test-helpers.ts   # Shared mocks for action tests (co-located *.test.ts)
│   │
│   └── api/
│       ├── cron/send-emails/  # Daily worker for BOTH outbound queues (Vercel
│       │                      # cron): coupon campaigns + notification emails
│       │                      # (§22). Self-chains while either has work left
│       ├── cron/plan-expiry/  # ★ Daily: flips expired timed plans → free (§15)
│       ├── cron/expire-pending-payments/ # ★ Hourly reaper for unpaid razorpay
│       │                      # orders: mark paid if captured, else cancel+restock (§18)
│       ├── og-image/          # OG image proxy (compresses Supabase images only)
│       ├── og/                # Dynamic branded OG card (ImageResponse; ?d=JSON
│       │                      # {title,subtitle,color}) — default share image for
│       │                      # homepage/custom pages/platform (lib/seo/og-card.ts)
│       └── upload/            # Image upload (sharp → WebP) → Google Cloud Storage
│           │                  # (GCS-only; requires GCS_BUCKET). Auth = Firebase session.
│           └── sign-video/    # v4 signed-URL minting for VIDEO uploads (≤50MB, GCS;
│                              # client PUTs DIRECTLY to storage — serverless routes
│                              # can't proxy large bodies)
│
├── lib/
│   ├── store/                 # ★ Tenancy (see §3): host.ts, resolve.ts, brand.ts
│   ├── notifications/         # ★ Event spine (§22): events.ts (the pure registry —
│   │                          # every event, its audiences + default channels),
│   │                          # render.ts (audience-aware copy, pure), record.ts
│   │                          # (emitEvent/recordEvent — the ONE write path, service
│   │                          # scope, deferred with after(), never throws),
│   │                          # recipients.ts (permission-derived routing),
│   │                          # digest.ts (clock-aligned send windows),
│   │                          # routing.ts (per-event recipient rules; NARROWS
│   │                          # the permission set, never widens),
│   │                          # channels.ts (email/web live; sms/push/whatsapp
│   │                          # declared but LOCKED — no provider), config.ts
│   │                          # (registry ← platform definition ← store
│   │                          # settings), variables.ts + template.ts (merchant
│   │                          # {{token}} copy, validated at save). Tested,
│   │                          # incl. coverage.test.ts — the CI guard that FAILS
│   │                          # if a registry event has no emitter anywhere.
│   ├── inventory/             # status.ts (the display-status source of truth, §13)
│   │                          # + ★ alerts.ts (§22: stockAlertFor — the pure
│   │                          # crossing rule behind inventory.low_stock/
│   │                          # out_of_stock — and reportStockChanges, the
│   │                          # deferred reader called from checkout + inventory
│   │                          # actions). Tested.
│   ├── settings/              # ★ Feature-settings framework (see convention #9):
│   │   ├── registry.ts        #   catalog: every per-store toggle (key, default, plan gate)
│   │   └── resolve.ts         #   getStoreSettings()/getStoreSetting() for the host store
│   ├── storage/               # ★ Google Cloud Storage media backend (GCS-only —
│   │                          # lib/supabase/ removed, Supabase fully out of code):
│   │                          # gcs.ts — gcsConfigured/gcsUploadObject/gcsSignUploadUrl/
│   │                          # gcsDeletePaths/gcsPublicUrl/gcsPathFromUrl (ADC or
│   │                          # GCP_SA_KEY; public bucket; lazy SDK import). uploads.ts —
│   │                          # client helpers (uploadImage POSTs /api/upload; uploadVideo
│   │                          # PUTs to a signed GCS URL). cleanup.ts — deleteStorageUrls/
│   │                          # extractMediaUrlsFromHtml orphan cleanup (legacy Supabase
│   │                          # URLs ignored). process-image.ts — shared validate+optimize
│   │                          # (sharp→WebP, SVG rasterize) used by BOTH /api/upload and
│   │                          # the media-library action. Tested.
│   ├── db/                    # ★ Cloud SQL data layer (GCP Phase 5, IN PROGRESS — NOT yet
│   │                          # the active path; app still on Supabase). client.ts: Drizzle
│   │                          # over pg Pool w/ the 2A tenancy model — withService (BYPASSRLS),
│   │                          # withUser({uid,email}) (SET LOCAL ROLE app_user + app.current_user_id
│   │                          # GUC → auth.uid() shim), withAnon (no GUC). Schema in drizzle/
│   │                          # (introspected). See docs/gcp-migration-phase5-6.md.
│   │                          # errors.ts: pg error helpers (isUniqueViolation etc).
│   │                          # Ported so far: colors, categories, enquiries (incl.
│   │                          # dashboard/enquiries/data.ts), reviews, blog-taxonomy,
│   │                          # coupons, blogs (actions + dashboard list + settings +
│   │                          # lib/blog-taxonomy.ts — fetchBlogTaxonomy(storeId), no
│   │                          # client param), addresses, billing, store-settings,
│   │                          # store-branding, pages/menus (page-actions +
│   │                          # menu-actions + lib/pages/preview.ts — builder write
│   │                          # side), brand-voice (+ lib/ai/brand-voice.ts +
│   │                          # lib/ai/quota.ts), store-domain, payment-provider,
│   │                          # customers (customer-actions + customer-profile +
│   │                          # dashboard/users/data.ts — customer_admin view; auth
│   │                          # admin ops stay on Supabase till Phase 6), user-groups
│   │                          # (+ dashboard data), roles (+ roles/admins pages),
│   │                          # account-settings + set-password + user-management +
│   │                          # invite-user (own-row admin updates → withUser,
│   │                          # superadmin guards → withService; auth createUser/
│   │                          # deleteUser/pw/session on Supabase till Ph6),
│   │                          # subscriptions, ai-credits, platform (operator
│   │                          # console; getPlatformViewer via getServerUser +
│   │                          # platform_admins email allowlist), store-signup,
│   │                          # blog-social (reactions/comments), coupon-email,
│   │                          # products (actions + dashboard
│   │                          # list/editor via products/columns.ts maps; sku/sku_no
│   │                          # trigger-owned → insert type asserted), orders
│   │                          # (order-actions.ts incl.
│   │                          # the cancel-restock claim + release_stock RPC), inventory
│   │                          # (incl. adjust_stock RPC via named-arg sql), and the FULL
│   │                          # storefront read path
│   │                          # (lib/store/resolve.ts, lib/storefront/queries.ts,
│   │                          # shop/[slug] + blogs/[slug] pages — all withAnon;
│   │                          # getBlog withUser for previews).
│   │                          # drizzle/schema.ts numeric cols use mode:'number'.
│   ├── auth/                  # ★ Identity Platform auth (GCP Phase 6 — Firebase):
│   │                          # server-user.ts — getServerUser() identity seam (the ONE
│   │                          # place server code reads the authed user; feeds withUser),
│   │                          # now verifies the Firebase SESSION COOKIE (no Supabase).
│   │                          # firebase-admin.ts (lazy Admin SDK), session-cookie.ts
│   │                          # (mint/verify + .storemink.com cookie), firebase-claims.ts
│   │                          # (role/force_password_reset custom claims — replaces the
│   │                          # custom_access_token_hook), firebase-users.ts (admin
│   │                          # create/delete/update + REST password reverify + reset link),
│   │                          # firebase-client.ts (Web SDK: establishSession → POST
│   │                          # /api/auth/session, endSession, secondary app for phone-only
│   │                          # verify). Delete an auth user does NOT cascade to the Cloud
│   │                          # SQL admins/users row — callers delete BOTH.
│   ├── storefront/            # queries.ts (cached storefront reads — getPublishedPage/
│   │                          # getPublishedPageSlugs, named columns only), tags.ts
│   │                          # (cache tags incl. TAGS.pages)
│   ├── sections/              # ★ Page-section registry (see §11): re-exports homepage
│   │                          # section-types + adds page helpers (PageSectionItem,
│   │                          # validateSections, RESERVED_PAGE_SLUGS, validatePageSlug),
│   │                          # resolve-data.ts (batched fetch, server) + map-data.ts
│   │                          # (the PURE per-section resolution — shared by the server
│   │                          # render AND the builder's client DraftCanvas). Tested.
│   ├── pages/                 # ★ preview.ts — uncached, cookie-authenticated draft loader
│   │                          # for the builder preview (getManagerUserId("builder") gate)
│   ├── seo/                   # ★ schema.ts — pure JSON-LD builders (productSchema/
│   │                          # articleSchema/breadcrumbSchema), tested. Rendered via the
│   │                          # (storefront) <JsonLd> component on product/blog pages.
│   │                          # Article/help publishers carry @id + url so they
│   │                          # resolve to the site's own #organization node.
│   │                          # og-card.ts — brandOgImageUrl() builds the /api/og URL
│   │                          # (single `d` param) for the branded default share card.
│   │                          # search-engines.ts — pingIndexNow() (Bing/Yandex —
│   │                          # NOT Google) + submitSitemapToGoogle() (Search
│   │                          # Console; the ONLY caller is store-signup). Both
│   │                          # best-effort; the Google path now logs via
│   │                          # observability instead of returning silently.
│   │                          # IndexNow key: public/<key>.txt.
│   │                          # ★ disallow.ts — the ONE list of non-indexable
│   │                          # storefront/platform paths, read by BOTH app/robots.ts
│   │                          # and app/sitemap.ts so a URL can never be blocked in
│   │                          # one and submitted in the other (/track-order was).
│   │                          # `exact` emits a `$` anchor so `/cart` doesn't also
│   │                          # block a merchant page slugged `cartography`. Tested.
│   ├── email/                 # sender, layout, campaign-worker, coupon-campaign,
│   │                          # trigger-worker, blog/enquiry notifications.
│   │                          # ★ notification-emails.ts (§22: single + digest
│   │                          # templates, pure/escaped) + notification-worker.ts
│   │                          # (claims notification_email_queue, GROUPS by
│   │                          # recipient into one digest, retries with backoff).
│   │                          # ★ send-batch.ts (per-message outcomes so one bad
│   │                          # address can't sink a batch), suppression.ts
│   │                          # (the global bounce/complaint list),
│   │                          # webhook-signature.ts (Svix verify, pure+tested),
│   │                          # trigger-worker.ts (the kick that makes "instant"
│   │                          # instant — PLATFORM_URL, not one env var).
│   │                          # ★ send.ts — THE choke point: every email leaves
│   │                          # through sendEmail() and lands in email_logs
│   │                          # (CI-guarded by send-coverage.test.ts);
│   │                          # mailers.ts — the mail-type catalog + which types
│   │                          # are redacted because they carry a credential
│   ├── homepage/section-types.ts  # Section schema (typed, tested) — shared by homepage AND
│   │                          # custom pages; 12 types incl. hero, tile_grid, usp_bar,
│   │                          # ticker, faq_accordion, rich_text + custom_code (see §11)
│   ├── menus.ts               # ★ Per-store nav (§11): StoreMenus types, DEFAULT_MENUS,
│   │                          # normalize/sanitize. Read cached via getStoreMenus.
│   ├── ai/gemini.ts           # Gemini/Vertex AI client for AI copy (dual backend, §7);
│   │                          # emits ai.generate telemetry (latency + tokens) via observability
│   ├── ai/credits.ts          # ★ AI credit pack catalog (pure — the one place to reprice)
│   ├── observability/         # ★ Structured logging for Google Cloud (GCP migration Phase 2):
│   │                          # logger.ts — logInfo/logWarn/logError emit Cloud Logging-
│   │                          # compatible JSON (severity+message) in prod, readable lines in
│   │                          # dev; edge-safe (console+JSON only, no deps). Auto-ingested by
│   │                          # Cloud Logging + Error Reporting once on Cloud Run (Phase 4).
│   │                          # First adopters: lib/ai/gemini.ts + proxy.ts 500 catch. Tested.
│   ├── payments/              # ★ Online payments (§18): crypto.ts (AES-256-GCM cred
│   │                          # encryption), razorpay.ts (server fetch client + HMAC verify,
│   │                          # tested), provider.ts (store/platform cred loaders),
│   │                          # razorpay-client.ts (client checkout.js loader + modal)
│   ├── billing/               # ★ Invoices & tax (§17): types.ts (BillingSettings/
│   │                          # TaxClass + row mappers + defaults), tax.ts (pure
│   │                          # inclusive/exclusive tax math, tested), invoice-data.ts
│   │                          # (server-only invoice loaders: by-store + own-order)
│   ├── pricing.ts / slug.ts / sanitize.ts / rate-limit.ts / og-image.ts
│   ├── blog-taxonomy.ts   # fetchBlogTaxonomy(): per-store blog categories/tags reader
│   ├── blog-reactions.ts / phone-labels.ts / use-otp-throttle.ts
│   ├── site.ts / utils.ts     # cn() etc.
│
├── components/
│   ├── ui/                    # shadcn/ui primitives (button, dialog, table, sidebar…)
│   ├── invoice/               # ★ Print-styled InvoiceDocument (server) + PrintButton
│   │                          # (client) + invoice.css (@media print isolation) — §17
│   └── customer-multiselect.tsx
├── hooks/use-mobile.ts
│
├── supabase/                  # ★ SQL — schema, migrations, RLS (run against Supabase manually/MCP)
│   ├── multitenant_01_schema.sql        # stores table + store_id columns (+ rollback)
│   ├── multitenant_03_rls.sql           # store-scoped RLS policies (+ rollback)
│   ├── multitenant_04_admin_views.sql / _05_count_rpcs.sql / _06_drop_store_defaults.sql
│   ├── multitenant_07_platform_admins.sql  # platform_admins table (+ rollback)
│   ├── *_table.sql            # blogs, coupons, enquiries, roles, users, user_groups,
│   │                          # product_reviews, email_campaigns, rate_limits, card_colors,
│   │                          # blog_comments/likes… (homepage_sections DEPRECATED — Phase 4a)
│   ├── orders_table.sql       # ★ orders + order_items (+ RLS + updated_at trigger). NO
│   │                          # customer INSERT policy by design — placeOrder writes with
│   │                          # the service role; customers/admins get SELECT/manage (convention #12).
│   ├── locations_04_reservations.sql  # ★ stock_reservations + hold/commit/release
│   │                          # RPCs; available = on_hand - reserved
│   ├── locations_03_fulfilment.sql  # ★ store_fulfilment_rules + products.online_stock
│   │                          # (sellable-online total, trigger-maintained)
│   ├── locations_02_admin_scope.sql  # ★ admin_locations — location scope for
│   │                          # dashboard admins (NO ROWS = unrestricted)
│   ├── locations_01_capabilities.sql  # ★ store_locations.capabilities (jsonb) —
│   │                          # what a location may DO; registry in lib/locations/
│   ├── pos_11_transfer_stock.sql  # ★ transfer_stock(): move stock between two of
│   │                          # a store's locations, atomically (one plpgsql txn)
│   ├── pos_10_shifts.sql      # ★ pos_shifts + pos_cash_movements + orders.shift_id
│   │                          # (one open shift per LOCATION, partial unique index)
│   ├── pos_09_register_layout.sql  # ★ pos_layouts: manager-arranged till grid
│   │                          # per location (no row = show the whole catalogue)
│   ├── pos_08_customer_order_store_scope.sql  # ★ store-scopes the CUSTOMER order
│   │                          # SELECT policies (were uid-only) + auth_customer_store_id()
│   ├── coupons_storefront_visibility.sql  # coupons.show_on_storefront flag (§storefront coupons)
│   ├── customer_addresses.sql # ★ saved shipping addresses (own-row RLS) — checkout book
│   ├── coupon_usage_rpc.sql   # ★ increment_/decrement_coupon_usage: atomic used_count
│   │                          # reserve/release (enforces max_uses under concurrency)
│   ├── blog_taxonomy.sql      # per-store blog_categories + blog_tags (+ RLS + seed)
│   ├── store_menus.sql        # ★ per-store header/footer nav (+ RLS + WholeSip seed) — §11
│   ├── notifications_01_schema.sql  # ★ the event spine (§22): activity_events
│   │                          # (append-only audit) + notifications (per-recipient
│   │                          # inbox, UNIQUE on event+recipient) + notification_
│   │                          # preferences (store defaults ← user overrides). READ-
│   │                          # ONLY RLS by design — every write is service-role
│   │                          # (no client can forge an audit row or push a bell)
│   ├── notifications_03_console.sql  # ★ §22 console: notification_definitions
│   │                          # (platform-global, operator-managed) +
│   │                          # notification_settings (per store: channels,
│   │                          # recipients, templates, digest, on/off)
│   ├── email_logs.sql         # ★ §22 Email Logs: every message sent, per store
│   │                          # (platform rows = store_id NULL). Service-role
│   │                          # only; bodies redacted for credential mailers
│   ├── notifications_07_routing_scope.sql # ★ notification_settings.routing_scope
│   │                          # — 'store' (default) | 'event_location'
│   ├── notifications_05_suppressions.sql # ★ §22 delivery: email_suppressions
│   │                          # (GLOBAL — no store_id, by design: a hard bounce
│   │                          # bounces for everyone and the shared sending
│   │                          # domain's reputation is the platform's) + the
│   │                          # failed-row index behind the delivery panel
│   ├── notifications_02_email_queue.sql  # ★ §22 email channel:
│   │                          # notification_email_queue + claim/requeue RPCs
│   │                          # (FOR UPDATE SKIP LOCKED, the email_campaigns
│   │                          # pattern). Worker-only: RLS on, NO policies
│   ├── media_assets.sql       # ★ per-store Media Library table (RLS is_store_admin; NOT
│   │                          # public — object URLs are public, the listing is admin-only)
│   ├── invoicing.sql          # ★ tax_classes + products.tax_class_id + order_items tax
│   │                          # cols + orders.tax_inclusive + store_billing_settings — §17
│   ├── plans_02_basic_and_expiry.sql # ★ starter→basic rename + plan_expires_at — §15
│   ├── ai_credits.sql         # ★ credit balances/ledger/purchases + add_ai_credits/
│   │                          # try_spend_ai_credit RPCs (service-role only) — §16
│   ├── payment_providers.sql  # ★ store_payment_providers (BYO Razorpay creds,
│   │                          # service-role only, app-layer encrypted secret) — §18
│   ├── payments_01_orders.sql # ★ orders.razorpay_order_id/payment_id + indexes — §18
│   ├── homepage_to_store_pages.sql  # Phase 4a data migration: homepage_sections → slug ""
│   ├── wholesip_static_pages_seed.sql  # Phase 4b: seed the 17 legacy static pages
│   │                          # (our-story, faqs, privacy-policy…) as published
│   │                          # store_pages rows for the WholeSip fallback store
│   ├── homepage_hero_seed.sql  # ★ WholeSip hero carousel as a leading custom_code section
│   │                          # on the homepage row (the "one-time hero seed" — §11). Idempotent,
│   │                          # keyed on a fixed section id. Regen: homepage_hero_seed.gen.py
│   ├── store_pages.sql        # ★ merchant custom pages (draft + published_sections jsonb;
│   │                          # RLS via is_store_admin; anon SELECT REVOKED then GRANTed on
│   │                          # named cols WITHOUT draft `sections` — see §11) (+ rollback)
│   ├── phase6_01_uid_columns_to_text.sql # ★ Phase 6: retype the 25 uid-holding columns
│   │                          # (admins.id/users.id + every created_by/updated_by/user_id/
│   │                          # customer_id/submitted_by/added_by/invited_by) uuid→text AND
│   │                          # the auth.uid() shim →text — Firebase uids are STRINGS, not
│   │                          # uuids. Entity PKs + store_id + platform_admins.invited_by
│   │                          # stay uuid. Drops/recreates 7 FKs + 25 policies + 2 admin
│   │                          # views. RUN AS postgres (owner of the tables + auth schema;
│   │                          # `app` can't). (+ rollback)
│   ├── phase6_02_adjust_stock_actor_text.sql # ★ Phase 6 follow-up: adjust_stock's
│   │                          # p_actor PARAMETER was still uuid (phase6_01 retyped the
│   │                          # created_by COLUMN but not the RPC arg) → every manual/bulk
│   │                          # stock edit failed "invalid input syntax for type uuid".
│   │                          # Drops the uuid overload, recreates p_actor text. RUN AS
│   │                          # postgres. (+ rollback)
│   ├── phase6_03_drop_custom_access_token_hook.sql # ★ Phase 6 follow-up: drops the dead
│   │                          # Supabase-era JWT hook (superseded by firebase-claims.ts;
│   │                          # never invoked, and stale after phase6_01) + its
│   │                          # supabase_auth_admin grants + admins RLS policy. RUN AS
│   │                          # postgres. (+ rollback embedded)
│   ├── platform_admin_01_order_policies.sql # ★ routes the orders/order_items
│   │                          # admin policies through is_store_admin() so platform
│   │                          # operators pass them (they inlined the admins lookup and
│   │                          # silently blanked the orders dashboard for operators —
│   │                          # convention #2). Ends with a guard that FAILS if any
│   │                          # policy still inlines `FROM admins`. RUN AS postgres.
│   │                          # Applied to staging + prod 2026-07-22. (+ rollback)
│   └── perf_*.sql             # index / RLS performance migrations
│
├── brand/tasks/               # AI copy TASK prompts (product-desc.md, seo-meta.md), read at
│                              # runtime by product actions + traced into the serverless bundle via
│                              # next.config.ts. brand.md + the file-based /product-desc & /seo-meta
│                              # skills were retired — brand voice is per-store in the DB (§16).
├── public/                    # Static assets (favicon, svgs)
└── coverage/                  # GENERATED test coverage report — do not edit
```

## 5. Key conventions & rules

1. **Tenancy first**: any new table gets a `store_id` column + RLS policy; any new
   query/action threads `getCurrentStoreId()`. Never leak data across stores.
2. **Server actions** live in `app/actions/<domain>-actions.ts` with a co-located
   `<domain>-actions.test.ts`. Use the right DB scope (`withUser` for user
   context, `withService` only when RLS must be bypassed and input is
   validated + explicitly store-scoped).
   **User-scoped queries carry the FULL identity (uid + email).**
   `withUser` (`lib/db/client.ts`) requires a `UserIdentity` — `email` is a
   REQUIRED (nullable) field, not an optional nicety, and the manager gate for
   dashboard actions is **`getManagerIdentity(section)`** (access.ts), which
   returns exactly that shape (`getManagerUserId` remains only for callers
   that never open a user scope). Why: the RLS helpers grant a StoreMink
   platform operator implicit superadmin on every store via
   `is_platform_admin()`, which matches `platform_admins` **by email** through
   `auth.email()` (the `app.current_user_email` GUC). A user scope opened with
   a uid alone leaves that GUC unset, so for an operator with no `admins` row
   every policy silently fails — reads come back EMPTY and writes affect zero
   rows with **no error** (this is how `/dashboard/orders` showed "No orders
   yet" for a store whose analytics page showed nine orders). The compiler now
   enforces the field; don't work around it by passing a made-up email. On the
   DB side, admin policies must delegate to `is_store_admin(store_id)` — never
   inline `FROM admins WHERE id = auth.uid()` (that recreates the operator
   blind spot; the two orders policies that did are fixed by
   `supabase/platform_admin_01_order_policies.sql`, which also FAILS if any
   policy reintroduces the inline pattern).
3. **Route groups**: `(storefront)` = customer site, `dashboard/` = store admin,
   `platform/` = StoreMink itself. Don't put platform pages in the storefront group —
   the proxy rewrite depends on this separation.
4. **Modals via intercepted routes**: dashboard list pages use the `@modal/(.)[id]`
   parallel-route pattern (enquiries, users). Follow it for quick-glance detail
   views. Products is the exception BY OWNER CHOICE: editing is a full page
   (`/dashboard/products/[id]`, Shopify-style — no interception; hover-prefetched
   rows + a `loading.tsx` skeleton keep it fast); only "New product" stays a
   dialog.
5. **Caching**: storefront reads use `unstable_cache` + tags (`lib/storefront/tags.ts`,
   `STORE_TAG`). After mutations, `revalidateTag`/`revalidatePath` accordingly.
6. **Styling**: Tailwind v4 + CSS modules for scoped styles + a few plain `.css`
   files per area (`dashboard.css`, `storefront-theme.css`, `platform.css`).
   Per-store theming = CSS variables injected by `brand-provider.tsx`.
7. **Next.js 16 caution**: APIs may differ from training data — check
   `node_modules/next/dist/docs/` before using unfamiliar APIs (AGENTS.md rule).
8. **Tests**: `npm run test` (vitest, coverage). CI also runs `lint`, `typecheck`,
   `prettier --check`, `build` — all must pass.
9. **Features are settings-based** (see §9): configurable behavior goes through
   `lib/settings/registry.ts` — add the setting there (key, label, default,
   `section` = the dashboard permission section that owns it, optional
   `minPlan`/`dependsOn`), read it via `getStoreSettings()` /
   `getStoreSetting()` from `lib/settings/resolve.ts`. Settings render on their
   OWNING FEATURE's settings page (blogs → `/dashboard/blogs/settings`) via
   `getStoreSettingsForEditor(group)` + `saveStoreSettings`, both gated per
   setting by `can(def.section, …)` — there is no central features page. Values
   live in `stores.settings.features` (jsonb); `saveStoreSettings` validates
   against the registry and busts `STORE_TAG`. Enforce settings **server-side**
   (in the action), not just in the UI. If RLS blocks a setting-dependent write
   (e.g. customers may only insert `pending_review` blogs), do the privileged
   step with the service-role client AFTER checking the setting — see
   direct-publish in `blog-actions.ts`. First consumers:
   `blogs.customerSubmissions`, `blogs.requireApproval` (rendered at
   `/dashboard/blogs/settings`) and `pages.customCode` (rendered at
   `/dashboard/builder/settings`); both pages share the
   `dashboard/components/feature-toggles.tsx` card. `marketing.showAllCoupons`
   (section `marketing`) is another consumer: when on, the storefront cart shows
   all active coupons; otherwise only those with `coupons.show_on_storefront`.
   **⚠ `stores.settings` (which holds `features`) is ANON-READABLE** — the
   "Read stores" RLS policy (`multitenant_03_rls.sql`) grants `SELECT` on every
   active store to `anon`, and the storefront reads it with the public client.
   So NEVER put a secret (API key, token, webhook secret) in `stores.settings`;
   it would be world-readable via PostgREST. Secrets belong in env, or in a
   separate column/table that is NOT granted to `anon` (mirror the `store_pages`
   draft-column pattern: revoke anon, grant only named non-sensitive columns).
10. **Blog categories & tags are per-store data**, not code: `blog_categories` /
    `blog_tags` tables (`supabase/blog_taxonomy.sql`), managed in
    `/dashboard/blogs/settings` via `blog-taxonomy-actions.ts`. Blogs store
    plain names in their `text[]` columns, so rename/delete propagates into
    affected blog rows; customer submissions are validated server-side against
    the store's lists. Editors read them via `fetchBlogTaxonomy`
    (dashboard) / `getBlogTaxonomyNames` (cached storefront,
    tag `TAGS.blogTaxonomy`).
11. **Website Builder — pages & custom code are per-store, dashboard-editable.**
    The storefront itself is a per-store artifact, not hardcoded: - **Section registry**: `lib/homepage/section-types.ts` is the single typed
    section schema (config types, `EMPTY_CONFIG`, `META`, `validateConfig`),
    shared by the homepage AND custom pages. Twelve block types: `hero`
    (banner/split/minimal variants — first-class hero, replaces the old
    custom_code hero hack; optional `video_url` plays muted/looping in place
    of the image with the image as poster), `hero_carousel` (auto-playing
    photo/video slideshow — `slides[]` of HeroSlide, dot + arrow nav,
    client-rendered `hero-carousel-section.tsx`), `featured_products`,
    `shop_by_category` (with a
    `display: circles|cards` tile-shape variant), `promo_banner`, `tile_grid`
    (linked colour/image tiles — offers, collections, 2-up mini banners),
    `usp_bar` (fixed icon catalog `USP_ICONS` + label strip), `ticker`
    (scrolling marquee — `messages[]` + speed + text theme; CSS-animated
    `ticker-section.tsx`, pauses on hover, static under reduced-motion),
    `faq_accordion`
    (expandable Q/A with optional category-filter pills; plain-text answers),
    `latest_blogs`, `rich_text` (inline sanitized HTML, SEO-friendly) and
    `custom_code` (merchant HTML/CSS/JS). Hero/tile/slide `background` fields
    are strict colours (`safeColor`) because they render into inline style
    attrs; `video_url` fields are `safeHref`-validated.
    `lib/sections/registry.ts` re-exports it and adds page-level helpers:
    `PageSectionItem`, `validateSections`, `RESERVED_PAGE_SLUGS`,
    `validatePageSlug`. - **Custom pages** live in `store_pages` (draft `sections` jsonb +
    `published_sections` snapshot; **publish = copy draft → published**). Served
    by `(pages)/[pageSlug]`; App Router matches static sibling dirs first, and
    every static (pages) dir slug is in `RESERVED_PAGE_SLUGS` (a drift unit test
    `fs.readdir`s the dir and asserts coverage). Published reads are cached
    (`getPublishedPage`, tag `TAGS.pages`, cached nulls for cheap 404s). - **Draft column is sealed from PostgREST**: anon `SELECT` is REVOKEd then
    GRANTed only on named columns WITHOUT `sections`, so drafts can never leak
    via the API — cached storefront queries therefore select named columns,
    never `*`. The builder + preview read drafts with the **service-role
    client** after an app-layer `getManagerUserId("builder")` check. - **Preview**: `?preview=1` + the admin's existing session cookie (dashboard
    and storefront share the host) → uncached `lib/pages/preview.ts` loader;
    unauthorized silently falls back to published. Preview renders `noindex` +
    a `PreviewBridge` client comp that `router.refresh()`es on postMessage from
    the builder. Two disjoint code paths (published cached / draft uncached) ⇒
    no cache poisoning. - **Sandboxed custom code**: merchant JS runs ONLY inside
    `custom-code-frame.tsx` — an iframe with `sandbox="allow-scripts
allow-popups"` + `srcDoc`, **never `allow-same-origin`**: the session cookie
    is `Domain=.storemink.com`, so same-origin inline JS could ride a visitor's
    session to make authenticated requests (the Firebase `sm_session` cookie is
    httpOnly, but same-origin scripts still send it automatically). Auto-height via ResizeObserver →
    `postMessage`, parent clamps 40–4000px. `</script`/`</style` escaped in
    merchant strings; each string capped 64 KB. `rich_text` is the inline/SEO
    counterpart: sanitized at save AND render via `lib/sanitize.ts` (blog trust
    model). Custom-code availability is gated by the `pages.customCode` setting
    (registry, section `builder`), enforced **server-side** in `page-actions.ts`
    (all sections — homepage + custom pages — now save through it); admins
    toggle it at `/dashboard/builder/settings`. - **Builder v3 UI** at `/dashboard/builder` (permission section `builder`,
    group Content; sidebar link opens a new tab; `fixed inset-0` overlay at
    `z-index:40`, below the shared `z-50` dialog layer; all chrome tokenised
    on the dashboard `--dash-*` vars via `--b-*` aliases in `builder.css`).
    Framer/Shopify-style canvas editing: LEFT `outline-panel.tsx`
    (page-switcher dropdown, Header/Footer rows → `/dashboard/navigation`,
    dnd-kit-sortable section outline; collapsible to a 52px icon rail —
    `is-left-collapsed` sets `--b-left`, persisted in localStorage); CENTER
    preview iframe (`/{slug}?preview=1`, viewport toggles) that is **REUSED
    across page switches** (`contentWindow.location.replace` + a translucent
    veil until load/`sm-preview-ready` — never keyed/remounted, no blank
    flash) with the **click-to-edit canvas overlay**
    (`app/(storefront)/components/sections/builder-overlay.tsx` — measured
    hit-layer, NOT event delegation, because sandboxed custom_code iframes
    swallow clicks; MutationObserver+ResizeObserver re-scan survives DOM
    replacement; postMessage protocol sm-select / sm-hover / sm-add-at
    {afterId} / sm-visible / sm-highlight / sm-scroll-to, extending
    sm-preview-refresh/ready); RIGHT `inspector-panel.tsx` (sticky
    header+tabs, only the body scrolls; tabs: Content = shared
    `section-form.tsx` forms folded into `field-group.tsx` disclosures;
    Style = preset chips + per-section `style`
    {background,padding_y,width,anchor} applied by `section-shell.tsx` —
    strict color validation because it renders into an inline style attr;
    Advanced = anchor/duplicate/delete; an idle state with a shortcut
    cheatsheet when nothing is selected). Page settings (title/slug/SEO/
    delete) moved to a topbar-triggered z-50 dialog (`PageSettingsForm`).
    **Instant preview**: preview mode renders sections CLIENT-side in
    `draft-canvas.tsx` — the builder posts `sm-draft {sections}` on every
    mutation (rAF-throttled; ~500ms for custom_code so the sandbox doesn't
    remount per keystroke) and the canvas re-renders with
    `lib/sections/map-data.ts` (the pure resolver, fed full dataset
    snapshots server-passed at preview load) — edits paint in <100ms with
    zero RSC round-trips; `sm-preview-refresh` (router.refresh) remains only
    for publish + slug renames. **Add-section library**
    (`section-library.tsx`): a left slide-over with search (label/
    description/`keywords` in `SECTION_TYPE_META`, which also gained
    `category`), grouped SVG mini-preview cards (`section-thumbs.tsx`),
    ↑/↓/Enter keyboard nav. **Undo/redo** (`use-history.ts`): pre-mutation
    snapshots recorded in `setSections`, 50-entry cap, 800ms coalescing per
    section for typing bursts; undo/redo re-save through the autosave chain.
    **Shortcuts** (`use-builder-shortcuts.ts`): ⌘Z/⇧⌘Z/⌘Y, ⌘S save-now, Esc
    (close library → deselect), ↑/↓ outline nav, ⌘D duplicate, ⌫ delete
    (confirm dialog); suspended while dialogs are open; never intercepts
    inside CodeMirror/TipTap. **Autosave** (`use-autosave.ts`: 350ms debounce
    for content, immediate for structural ops, single-flight latest-wins
    chain, stale-tab token from `savePageDraft`'s returned `updated_at`,
    beforeunload while dirty). The stale-tab block now offers three ways out:
    reload (their version), copy-my-changes (sections → clipboard JSON), or
    take-over (`unblock()` — re-pulls a fresh token, local sections win).
    Validation is split: `validateConfig/validateSections` take a mode —
    "draft" skips completeness (autosave never fails mid-edit), "publish" is
    strict (publishPage + applyTheme). Publish stays explicit, with its own
    token guard. custom_code edits in a wide dialog hosting the lazy
    CodeMirror editors (`code-editor-lazy.tsx`). **Responsive**: ≥1200px
    3-panel; 768–1199px the inspector becomes a fixed right sheet (z-45,
    slides in on selection); <768px a "needs a larger screen" notice. - **Homepage (Phase 4a, done)**: the storefront homepage is the `store_pages`
    row with slug `""` (the "homepage sentinel"). `app/(storefront)/page.tsx`
    reads it (published + `?preview=1` draft) exactly like `[pageSlug]`. It's
    pinned first in the builder as "Home" (`ensureHomepage` creates it on demand;
    `listPages` hides it; slug immutable, not deletable). The old WholeSip hero
    is now a `custom_code` section. Retired: `homepage_sections` reads,
    `homepage-actions.ts`, `/dashboard/homepage`, `Hero.jsx` (the
    `homepage_sections` table is kept, deprecated, as migration rollback). - **Static pages (Phase 4b, done)**: the 17 former hardcoded content pages
    (our-story, faqs, …) are seeded as `store_pages` rows (new stores via the
    theme at signup; the legacy WholeSip fallback store via
    `wholesip_static_pages_seed.sql`) and their route dirs deleted, so
    `[pageSlug]` serves them; `RESERVED_PAGE_SLUGS` now reserves only
    the INTERACTIVE routes that stay in code (blogs, cart, enquiries, profile,
    shop) + system routes. - **★ Header & footer are BUILDER content (`store_chrome`)**: the site-wide
    chrome is edited INSIDE `/dashboard/builder`, as two pinned rows in the
    outline that open the normal inspector — not a link out.
    `/dashboard/navigation` now REDIRECTS there; its permission key survives via
    `hiddenInNav` so saved roles keep their grant.
    **Why:** one footer drew from FOUR places — link columns in `store_menus` (a
    separate dashboard page), logo/social/legal name in `stores.settings.brand`
    (another), the builder, and hardcoded JSX for the newsletter and contact
    blocks. The two halves also had different safety models: a page edit sat in
    draft until Publish, while `saveStoreMenus` wrote straight to LIVE — on the
    chrome that appears on every page of the store.
    `supabase/builder_01_store_chrome.sql` gives chrome the exact `store_pages`
    contract: one row per store, `draft` + `published` jsonb, anon SELECT
    revoked and re-granted WITHOUT `draft`. `lib/chrome/types.ts` is the pure
    schema — `normalizeChrome` (reads) fills defaults so a storefront is never
    unnavigable, `sanitizeChromeForSave` (writes) preserves an explicit empty so
    deleting your last footer column is an edit that actually sticks.
    `app/actions/chrome-actions.ts` = saveChromeDraft / publishChrome /
    revertChromeDraft, and **Publish publishes BOTH** page and chrome.
    ⚠ Three load-bearing details:
    (1) **A LAYOUT cannot read `searchParams`** (Next 16) and the storefront
    layout is what renders Header/Footer — so `?preview=1` arrives as an
    `x-sm-preview` header set in `proxy.ts`. It is a HINT, not authorisation:
    `getDraftChromeForPreview` runs the same `getManagerUserId("builder")` gate
    as the page-draft loader.
    (2) `getStoreChrome` falls back to `store_menus` when no chrome row exists,
    so THE DEPLOY IS ORDER-INDEPENDENT — without it, shipping before the
    migration ran would silently replace every merchant's navigation with the
    platform's stock links. Delete it when `store_menus` is dropped.
    (3) Every toggle DEFAULTS ON, matching what Header/Footer rendered before —
    a default that changes a live storefront is a migration bug wearing a config
    hat. Edits reach the preview by `sm-chrome` postMessage (`ChromeProvider`),
    and a fresh iframe announces `sm-chrome-ready` so the builder re-pushes the
    draft; without that a page switch shows published chrome under a draft
    outline.
    The builder also shows a **Brand** row (colour + logo) saved through
    `saveBrandAppearance` — a PATCH, deliberately: `saveStoreBranding` rebuilds
    the whole brand object from a FormData carrying every field, so calling it
    from a two-field panel would blank the merchant's email, social links and
    legal name. Contact/social/legal stay in `/dashboard/branding` because they
    are store IDENTITY (they print on invoices and go out in email), not a
    website decision. Pages list in an always-visible **rail** rather than a
    dropdown that overlaid the section outline you were about to edit, and
    `loadingDraft` starts TRUE when there is a page to auto-open so the first,
    pre-hydration paint says "Opening…" instead of "Select a page" — React
    state cannot fix that frame, only the initial value can. - **Themes (signup seeding)**: a theme is a DATA PACKAGE in `lib/themes/` —
    `meta.ts` (client-safe catalog for the signup picker: id/name/category/
    previewImage/demoSlug; the picker must NEVER import definitions),
    `definitions/basket.ts` (brand accents, **`design` skin**, pages incl. the
    homepage sentinel, menus, sample categories/products+variants — imagery
    bundled under `public/themes/{id}/`; **basket** is the grocery/F&B
    reference template with real Unsplash photography, per
    docs/vertical-templates-plan.md §9.1, and currently the only/default
    theme — the Arcade/Fresko placeholders were retired 2026-07-04),
    `apply.ts` `applyTheme(storeId, themeId,
    {publish, reset?})` — service-role, idempotent upserts keyed on
    (store_id, slug), best-effort per entity with an errors accumulator;
    `reset` refuses unless `stores.settings.demo === true`. `createStore`
    (signup) calls it with the picked template (published immediately; brand
    NAME preserved). v1 constraints CI-tested in `lib/themes/themes.test.ts`:
    non-id sources only, no latest_blogs, homepage present, strict publish
    validation, every referenced asset exists. **Demo stores**: one per theme
    (`demo-{id}` — the namespace is blocked at signup), seeded/reseeded via
    `seedDemoStore` (platform superadmin action) from the Themes panel on the
    platform stores console; the signup picker's Preview opens
    `https://demo-{id}.{ROOT_DOMAIN}`. - **Theme DESIGN engine (the visual "skin")**: a theme controls the FULL
    design system, not just one accent. `ThemeDesign` (`lib/themes/types.ts`) =
    `palette` (all 14 `--sm-*` colour tokens + `onAccent`/`onInk`/
    `shadowRgb`/`success`/`error`/`star`/`highlight` semantic tokens), `fonts`
    (`body`/`display`, pointing at next/font variables loaded in
    `app/layout.tsx` — Inter/Fraunces/Space Grotesk/Plus Jakarta alongside the
    legacy Outfit/Roboto/Stick), and `shape` (`card`/`control`/`sm`/`pill`
    radii). `designToCssVars(design, brandPrimary)` flattens it to a CSS-var map
    the `(storefront)` layout writes **inline on `.storefront-root`** — inline
    specificity beats the globals.css `:root` defaults, so the whole storefront
    re-skins with zero per-component wiring. Fonts re-point the existing
    `--font-outfit`/`--font-stick-no-bills` slots, so all 64 font call-sites
    switch with no find-replace. **Defaults = WholeSip**: the `:root` token
    values in `globals.css` ARE the WholeSip look, and a store with no real
    `settings.template` (the WholeSip fallback, legacy stores) gets only
    `--brand-primary` — untouched. Storefront component CSS is fully
    tokenised (no raw hex; darks→`ink`, mids→`ink-soft`, faints→`ink-faint`,
    on-dark whites→`on-ink`/`on-accent`, panels→`surface`, shadows→
    `rgba(var(--sm-shadow-rgb), α)`, radii→shape tokens) so palette +
    shape reach every surface (header, footer, auth modal, shop cards + badges,
    profile/enquiry forms, blog + write-blog editor). CI-guards in
    `themes.test.ts` assert each theme ships a complete, injectable design.
    **Layout variants** (`ThemeDesign.layout`, all optional — absent = classic
    WholeSip chrome): `header: "market"` renders a solid brand-coloured header
    bar with a prominent search box (colours via `--sm-header-bg`/`--sm-header-fg`
    from `designToCssVars`; activated by the `sm-header-market` class the
    storefront layout puts on `.storefront-root`); `card: "quick_add"` shows an
    inline "+ Add" to-cart button on product cards (`quick-add-button.tsx`,
    class `sm-card-quickadd`; multi-variant products fall through to the detail
    page). The header search is FUNCTIONAL on all variants — it submits to
    `/shop?q=`, and the shop grid filters by name/description/category
    (`shop-client.tsx`, synced to the deep link).
    `storefront: "grocery"` is the deepest variant: it swaps the shared
    product cards, the product-detail page and the cart for a distinct
    premium grocery layout, so a store on such a theme looks NOTHING like the
    classic WholeSip storefront. Product cards restyle via the
    `sm-storefront-grocery` root class (CSS-only, in `storefront-theme.css`,
    doubled-class specificity over the per-grid rules). The PDP and cart
    branch to ENTIRELY SEPARATE markup + classes (`grocery-product-detail.tsx`
    / `gpdp-*` in shop.css; `grocery-cart.tsx` / `gcart-*` in cart.css) — the
    page servers read the flag via `lib/store/storefront-layout.ts`
    (`getStorefrontLayout`) and pass a `grocery` prop to the client
    components; the grocery shop listing swaps in a clean neutral header. (The
    classic shop hero is now brand-aware — store name + tagline, not hardcoded
    WholeSip — and the old hardcoded promo ticker was removed; a ticker is a
    builder section type now, §11.)
    All of this is GATED, so the WholeSip fallback and any classic theme keep
    today's shared layout untouched. (Basket is the first grocery theme.)
    Design derives from the theme id at RENDER time (no DB column), so no reseed
    is needed when a theme's skin changes. - **Phase 4d (not built, by design)**: nothing pending — homepage, static
    pages, and menus are all migrated. config/site.ts, brand.md and the
    file-based AI skills are deleted, and the shop hero is brand-aware. The
    `--wholesip-*` CSS token namespace (→ `--sm-*`) and `WHOLESIP_STORE_ID` (→
    `FALLBACK_STORE_ID`) are now renamed too; only the repo name `wholesip` and
    the `brand/` dir remain as legacy WholeSip naming.

12. **Checkout & orders security model (COD).** A signed-in shopper places an
    order from `/checkout`; `placeOrder` (`app/actions/checkout-actions.ts`) is
    the trust boundary and layers its defenses in order:
    - **Auth**: `getServerUser()` (the identity seam — verifies the Firebase
      session cookie) — anonymous is rejected. **Rate limit**:
      `rateLimit("checkout:{userId}")` (Postgres, cross-instance, fails open)
      throttles spam/double-submit.
    - **Input validation**: line-item count, per-line integer quantity, and all
      required address fields are validated server-side (the form's `required`
      attr is only a UX hint); stored address values are trimmed + length-capped.
    - **Never trust client prices**: item prices are re-read from `products`/
      `product_variants` **scoped to the host store** (`getCurrentStoreId()` +
      `.eq("store_id", …)`), so another store's product can't be smuggled in and
      the client's claimed price/total is ignored. Coupons are re-validated via
      `validateCoupon` (min-order/date/usage/group checks) and the discount is
      recomputed + rounded to match the cart. A coupon use is then **reserved
      atomically BEFORE the order is created** via the `increment_coupon_usage`
      RPC (`supabase/coupon_usage_rpc.sql`) — a single conditional UPDATE that
      returns false when `max_uses` is already hit, so the cap can never be
      exceeded under concurrent checkouts. The reservation is released
      (`decrement_coupon_usage`) if the order then fails to persist; a transient
      RPC error fails open (never blocks a sale over the counter).
    - **Service-role writes**: `orders`/`order_items` have **no customer INSERT
      RLS policy** by design; the writes run with `createAdminClient()` (service
      role) _after_ all the above validation. Customers get RLS `SELECT` on their
      own orders; store admins get `FOR ALL`. On an items-insert failure the
      order row is deleted (best-effort rollback — no cross-statement txn over
      PostgREST). **If you ever move checkout off the service-role client, add a
      customer INSERT policy first** (see the note in `orders_table.sql`).
    - **Customer order reads are store-scoped in the DB**
      (`supabase/pos_08_customer_order_store_scope.sql`). The customer SELECT
      policies on `orders`/`order_items` were `customer_id = auth.uid()` with
      NO store predicate — and a Firebase uid is global, so any order anywhere
      carrying that uid was readable. They now also require
      `store_id = auth_customer_store_id()` (a SECURITY DEFINER helper; a uid
      maps to exactly one store because `users.id` is the PK, so no request
      context is needed). This is defence in depth for the rule above — **an
      unvalidated `customer_id` write is what makes it exploitable**, which is
      exactly the bug `placePosSale` had (§22). The migration ends with a guard
      that FAILS if any policy on those tables keys off `customer_id` without
      the store scope.
    - **Dashboard reads/writes**: `order-actions.ts` gates on
      `getManagerIdentity("orders")`, scopes every query by `store_id`, paginates
      `getOrders`, and allowlists `status`/`payment_status` in `updateOrderStatus`.
      Reads/writes run under **`withUser(admin)` with the FULL identity** (uid +
      email) — see the "user-scoped queries carry the full identity" rule in
      convention #2 for why the email is load-bearing.
    - **Checkout UX**: the `/checkout` page opens the auth modal IN PLACE when
      signed out (no redirect) so a signed-in shopper lands straight on the form.
      Saved addresses (`address-actions.ts` + `supabase/customer_addresses.sql`,
      own-row RLS) prefill the default and are picked from cards so the address
      isn't retyped each order.

13. **Inventory System**. Per-store stock tracking. Products and variants have `track_inventory` (bool), `stock` (int), `low_stock_threshold` (int), `allow_backorder` (bool), and `sku` (text, products only). Stock edits go through `supabase/inventory_rpc.sql` (`reserve_stock`, `release_stock`, `adjust_stock`) to ensure atomic correctness and generate an append-only ledger in the `stock_movements` table. `lib/inventory/status.ts` is the SINGLE source of truth for turning stock fields into a display status (`isSoldOut`/`lowStockLeft`/`inventoryStatus` + product-level aggregation) — shared by the dashboard list, its optimistic UI, and the storefront so the per-SKU threshold override and the store-wide default (`inventory.lowStockThreshold`) resolve identically everywhere. The storefront reads these fields to display 'Sold Out' or 'Only X left!' badges on product cards and detail pages (the store default is resolved per request in the shop/product pages + section resolver and threaded down as `storeLowStockThreshold`), and the quick-add button disables itself for out-of-stock items. Checkout (`checkout-actions.ts`) creates the order row **before** calling `reserve_stock` per line (the `stock_movements.order_id` FK requires the order to exist first), and rolls back stock→order→coupon in reverse on any failure. Each order carries a `stock_status` (`none`/`reserved`/`released`) tracking its reservation lifecycle: checkout sets `reserved`; `order-actions.ts` restocks on cancellation by atomically claiming the `reserved`→`released` transition (a single conditional UPDATE), so cancellation restocks **exactly once** and never touches legacy orders (`none`) — reinstating a cancelled order does NOT auto re-reserve. Store admins manage inventory at `/dashboard/inventory` (list view, history drawer, bulk adjustments) and settings at `/dashboard/inventory/settings`. **Cart-side enforcement (layered defense above the DB guarantee).** `reserve_stock` makes overselling impossible at order time, but the cart must not let a shopper pile quantity past stock in the first place. `lib/inventory/status.ts` adds `cartLineMax(snapshot, ceiling=99)` — the camelCase cart counterpart of `maxPurchasable` — and a `CartStockSnapshot` shape. Every `CartItem` (`CartProvider`) carries an optional `{trackInventory, stock, allowBackorder}` snapshot captured at add time (all optional, so older persisted carts parse as untracked/unlimited); `addItem` and `setQuantity` clamp centrally to `cartLineMax`, so ONE choke-point caps every surface: the quick-add button (`quick-add-button.tsx`, toasts at the cap), the PDP quantity selector + Buy Now (`product-detail-client.tsx`), and all three cart steppers (`CartDrawer.tsx`, classic `cart-client.tsx`, `grocery-cart.tsx`) — each disables "+" and shows a "Max available: N" hint at the cap. **Stale carts are reconciled at checkout**: `getCartStock(lines)` (`checkout-actions.ts`, service-role, store-scoped, uncached) re-reads live per-line stock and marks vanished products/variants `exists:false`; `CartProvider.reconcileStock(updates)` refreshes each line's snapshot, clamps over-stock quantities, drops sold-out/vanished lines, and returns a `{removed, reduced}` summary the `/checkout` page toasts on mount. If a reserve still fails at order time, `placeOrder` re-reads the SKU and returns the exact shortfall ("only N left" / "just sold out"), not a generic error.

14. **Human-readable identifiers (store_no / order_no / SKU).** Layered ON TOP
    of the internal UUID keys — the UUIDs stay the primary keys, foreign keys,
    and URL/lookup keys (access control is always UUID + `store_id` RLS); the
    codes are display + search values only, so a guessable/sequential number is
    never an IDOR vector. Compact grammar `<TYPE><STORE:4+><SEQ:4+>[V<VAR:2+>]<CHECK>`
    with a trailing Luhn (mod-10) check digit over the numeric payload, so every
    code self-validates offline: product SKU `SKU100100015`, variant SKU
    `SKU10010001V013`, order `ORD100110006`; the 4-digit store number is embedded
    in all of them (store `1001` → `SKU1001…`/`ORD1001…`), so everything for a
    store shares a core and is globally unique despite per-store sequences.
    `lib/identifiers.ts` (pure, tested) is the **client-display authority**
    (`luhnCheckDigit`/`isValidCode`/`formatSku`/`formatVariantSku`/`formatOrderRef`/
    `formatStoreCode`/`refKind`). **Generation is at the DB layer** so no insert
    path can produce a code-less row: `supabase/identifiers_01_schema.sql` adds
    `stores.store_no` (global `store_no_seq`, from 1000), `orders.order_no`/
    `order_ref`, `products.sku_no`, `product_variants.variant_no`, a per-store
    `store_counters` table (anon-revoked; a live counter leaks order volume) and
    atomic allocators (`next_order_no`/`next_product_no`/`next_variant_no` —
    single `UPDATE … RETURNING`, the `increment_coupon_usage` pattern);
    `identifiers_04_triggers.sql` adds permanent SQL formatters (`sm_luhn`/
    `sm_sku`/`sm_variant_sku`/`sm_order_ref`, mirror of `lib/identifiers.ts`,
    cross-checked by its tests) + BEFORE-INSERT triggers that fill the codes and
    a `nextval` default on `store_no`. `02_backfill` numbered existing rows by
    `created_at`; `03_constraints` locked `NOT NULL` + `UNIQUE` (store_no global;
    order_no + sku per-store). **SKUs are system-generated & locked** — the
    product editor shows them read-only and `product-actions.ts` never writes
    `sku`/`sku_no` (the trigger owns them, immutable once assigned — variant
    numbers are frozen so a reorder never renumbers a live SKU). `placeOrder`
    returns `orderRef` for the confirmation page; the dashboard orders list shows
    `order_ref` (UUID kept in a `title` tooltip). Order/product/store UUIDs and
    routes are UNCHANGED. Supersedes the "sku (text, products only)" note in #13.

15. **Plans (free / basic ₹500 / pro ₹1500) + timed grants.** `lib/plans.ts` is
    the single plan catalog (pure, tested): `PLAN_IDS`, `PLAN_RANK`,
    `normalizePlan`/`planAllows` (re-exported by `lib/settings/registry.ts`
    for its `minPlan` gates — the former "growth" AND "starter" ids are
    retired; `normalizePlan` aliases legacy `starter → basic`), display meta
    (`PLAN_META`: INR monthly/yearly pricing, taglines) and `PLAN_LIMITS`
    (product/staff/AI/coupon caps + customDomain/onlinePayments/
    emailCampaigns/removeBadge flags; `null` = unlimited; AI caps are
    **3 / 10 / 50 per month** — pro is metered too; enforce server-side in
    the owning action, soft-on-downgrade: never delete data, only block NEW
    rows past a cap). The platform landing page (`app/platform/page.tsx`)
    derives its pricing cards from `PLAN_META`/`PLAN_LIMITS` so it can never
    drift. `stores.plan` is CHECK-constrained to the three ids
    (`plans_02_basic_and_expiry.sql` renamed starter→basic) and paired with
    `stores.plan_source` (`comp`/`paid`/`trial` — an operator comp must never
    be overwritten by a future billing webhook); every change is recorded in
    the append-only `plan_events` audit table (service-role only, like
    `store_counters`) — schema in `supabase/plans_01_schema.sql`.
    **Timed plans:** `stores.plan_expires_at` (timestamptz, NULL = indefinite)
    bounds an operator grant. Enforcement is two-layered: (1) read-time —
    every gate resolves the plan via **`effectivePlan(store)`** (expired ⇒
    free; threaded through `lib/ai/quota.ts`, `lib/settings/resolve.ts`,
    `store-settings.ts`, checkout's gateway gate, credit purchases), and
    (2) durable — `/api/cron/plan-expiry` (daily, vercel.json,
    CRON_SECRET-protected) flips expired rows to free, clears the expiry,
    writes a `plan_events` row (source `system`) and busts `STORE_TAG`.
    The platform stores console sets plans via `setStorePlan`
    (`app/actions/platform.ts`, superadmin-only, tested): **any plan, any
    direction**, with a duration picker (1/3/6/12 months / custom date /
    indefinite). Merchant-facing subscription billing is a later phase.

16. **Per-store brand voice + AI quota.** Every AI copy feature (product
    description, SEO, coupon email, brand-voice setup) speaks in the STORE's
    voice: `lib/ai/brand-voice.ts` `getBrandSoulForStore(storeId)` reads
    `store_brand_profiles` (`supabase/brand_voice_01_schema.sql`; service-role
    only — a brand guide is internal content, so no anon/authenticated grants,
    the store_pages-draft pattern) and NEVER returns null — stores without a
    saved guide get a safe generic default folded from their name/tagline/blurb,
    so AI works out of the box. The legacy file-based `brand/brand.md` is retired
    AND DELETED (its content was seeded as the WholeSip store's row); only
    `brand/tasks/*` (task prompts — WHAT to write, not WHO speaks) stay platform
    assets in code.
    Merchants edit their voice at `/dashboard/branding` (section `branding`):
    five guided questions + "Generate with AI" (a fixed brand-strategist prompt
    composes the guide from the answers, review-before-save) + a free-form
    guide textarea — `app/actions/brand-voice-actions.ts` (tested). **AI quota
    (first live plan-limit enforcement):** `lib/ai/quota.ts` `consumeAiQuota`
    meters generations per store per calendar month against the EFFECTIVE
    plan's `aiGenerationsPerMonth` cap (3/10/50; null = unlimited, no
    metering) via the atomic `try_ai_generation` RPC + `ai_usage` table
    (single conditional UPDATE, the coupon-usage pattern; fails OPEN on
    transient errors). Called BEFORE Gemini in every AI action; blocked
    stores get a plan-aware message and the branding page shows "X of Y used
    this month".
    **AI credits (purchasable top-ups):** once the monthly allowance is
    spent, `consumeAiQuota` falls back to the store's credit balance
    (never-expiring integers) via `try_spend_ai_credit` — the expiring
    resource burns before the permanent one. Storage in
    `supabase/ai_credits.sql`: `ai_credit_balances` (one row/store, CHECK
    ≥ 0), append-only `ai_credit_ledger` (`purchase`/`grant`/`spend`; a
    UNIQUE partial index on purchase refs makes crediting idempotent per
    Razorpay payment id) and `ai_credit_purchases` (pending→paid/failed) —
    all SERVICE-ROLE ONLY. RPCs `add_ai_credits` (idempotent for purchases)
    - `try_spend_ai_credit` (single conditional UPDATE). Pack catalog in
      `lib/ai/credits.ts` (25/₹59, 60/₹129, 150/₹299 — the one place to
      reprice). Merchants see usage + balance + ledger and buy packs at
      **`/dashboard/ai`** (section `ai`, group Administration) —
      `app/actions/ai-credit-actions.ts`: `startCreditPurchase` (plan-gated
      basic+, server-side) → Razorpay modal on the **PLATFORM's own account**
      (env `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`; totally separate from a
      store's BYO gateway) → `confirmCreditPurchase` (HMAC verify → paid →
      `add_ai_credits`); dropped callbacks self-heal via reconcile-on-read on
      page load (no webhook in v1). Operators grant free credits from the
      stores console (`grantAiCredits`, superadmin-only, audited with the
      operator's email as the ledger ref) and see per-store AI used / credit
      balance / gateway state (batch-enriched `listAllStores`) plus a History
      drawer (`getStoreAudit`: plan_events + credit ledger).

17. **Invoices & tax (per-store, Shopify-style).** Managed at `/dashboard/billing`
    (permission section `billing`, group Administration). Storage in
    `supabase/invoicing.sql`: `tax_classes` (named rate buckets, public-read /
    admin-write RLS), `products.tax_class_id` (ON DELETE SET NULL), per-line tax
    snapshot on `order_items` (`tax_rate`/`tax_amount`/`tax_class_name`),
    `orders.tax_inclusive` (`orders.tax` already existed), and a single-row
    `store_billing_settings` (tax config + business identity + invoice template;
    **public-readable by design — everything here prints on the customer's
    invoice, so NEVER put a secret in it**). - **Tax model = classes per product**: a store defines tax classes (e.g. GST
    5/12/18%), assigns one per product (product editor → "Tax class"; products
    without one use `store_billing_settings.default_tax_class_id`), and toggles
    tax on/off + inclusive/exclusive store-wide. (Region-based CGST/SGST split
    is the deliberately-unbuilt heavier option.) - **Pure math** in `lib/billing/tax.ts` (`computeTax`, tested): discount is
    allocated across lines proportionally, then tax is computed on the
    discounted amount — EXCLUSIVE adds tax to the total, INCLUSIVE carves it
    out (total unchanged) and reports it. `lib/billing/types.ts` holds
    `BillingSettings`/`TaxClass` + row mappers + `DEFAULT_BILLING_SETTINGS`. - **Checkout** (`checkout-actions.ts`, convention #12): `placeOrder` reads the
    tax config authoritatively via `readTaxConfig` (uncached admin, store-scoped
    — an order must reflect config at order time), resolves each line's rate,
    computes tax, and snapshots `order.tax`/`order.tax_inclusive` + per-line tax.
    `getCartTaxRates(lines)` is the DISPLAY counterpart: it resolves the tax
    config + each line's authoritative price & rate WITHOUT quantity/discount
    (those depend only on the product SET), so the shared client hook
    `useCartTax` (`app/(storefront)/components/cart/useCartTax.ts`, used by the
    checkout summary AND the grocery cart) fetches it once per product-set
    change and recomputes the tax LOCALLY via the pure `computeTax` on every
    quantity/coupon edit — zero round-trips except on add/remove. Storefront
    reads use cached `getStoreBillingSettings` / `getStoreTaxClasses` (tag
    `TAGS.billing`). - **Invoices = printable HTML** (chosen over server PDF): `components/invoice/
InvoiceDocument` (server, presentational) + `invoice.css` (`@media print`
    isolates the sheet from all chrome) + `PrintInvoiceButton` (client
    `window.print()` → Save as PDF). Loaders in `lib/billing/invoice-data.ts`:
    `loadInvoiceByStore` (dashboard, service-role, store-scoped) and
    `loadInvoiceForCustomer` (own-order via cookie RLS; both return `storeId`).
    Routes: `/dashboard/orders/[id]/invoice` (linked from the orders list) and
    the customer `/checkout/invoice/[orderId]` (noindex; linked from the order-
    confirmation page; guards the host via `requireStorefrontStoreId()` and
    404s unless the order belongs to the host store). Access control is UUID +
    RLS/store-scope, never a guessable code. The invoice's Bill To/Ship To and
    tax column derive from the ORDER's snapshot (`tax_inclusive`, per-line
    `tax_rate`), never live settings — historical invoices are immutable.

18. **Online payments — BYO Razorpay per store (Channels).** A merchant
    connects their OWN Razorpay account at **`/dashboard/channels`** (section
    `channels`, group Administration); order money settles directly with them
    — the platform never touches order funds and takes no fee. - **Credentials** live in `store_payment_providers`
    (`supabase/payment_providers.sql`) — SERVICE-ROLE ONLY (**never** in
    anon-readable `stores.settings`, §5.9), with the key secret
    ADDITIONALLY encrypted at the app layer: `lib/payments/crypto.ts`
    (AES-256-GCM, env `PAYMENT_CRED_KEY` = 32-byte base64; rotation =
    offline decrypt/re-encrypt). The secret is WRITE-ONLY — no action ever
    returns it (`getChannelState` exposes only key id + enabled).
    `app/actions/payment-provider-actions.ts` (tested):
    `saveRazorpayCredentials` proves the pair against the Razorpay API
    before storing ("Verify & save"), `setRazorpayEnabled` (pause/resume),
    `disconnectRazorpay`. Plan gate `PLAN_LIMITS.onlinePayments` (basic+)
    is enforced server-side on save/enable AND re-checked at checkout —
    a lapsed plan silently reverts the storefront to COD-only without
    touching stored credentials. - **Razorpay client** `lib/payments/razorpay.ts` (server-only, plain
    fetch + basic auth, no SDK; pure helpers tested in
    `lib/payments/payments.test.ts`): `rzpCreateOrder`,
    `rzpFetchOrderPayments` (the reconciliation source of truth),
    `capturedPayment`, `validateCredentials`, `verifyCheckoutSignature`
    (HMAC-SHA256 of `order_id|payment_id`, constant-time compare).
    `lib/payments/provider.ts` loads decrypted store creds
    (`getStoreGateway`) and the platform's env creds
    (`getPlatformRazorpayCreds` — AI credits only, §16).
    `lib/payments/razorpay-client.ts` is the CLIENT-side checkout.js
    loader + typed modal wrapper shared by the storefront checkout and the
    AI-credits buy panel. - **Checkout flow** (extends convention #12; `orders.razorpay_order_id`/
    `razorpay_payment_id` added by `supabase/payments_01_orders.sql`):
    `getCheckoutConfig()` tells the client whether to render the method
    selector (COD default | "Pay online"). `placeOrder(..., "razorpay")`
    runs the IDENTICAL validation/repricing/coupon/stock machinery, inserts
    the order (`payment_method: 'razorpay'`, `payment_status: 'pending'`),
    then creates the Razorpay Order for the **server-computed total**
    (paise) with `receipt = order_ref` — any failure there unwinds the full
    chain (stock → order → coupon) — and returns `{rzpOrderId, keyId,
amountPaise}` for the modal. `confirmOnlinePayment` verifies the HMAC
    with the store's decrypted secret and claims the pending→paid
    transition atomically (idempotent; owner + store scoped). A dismissed
    modal keeps the order retryable against the SAME Razorpay order
    ("Retry payment"; any cart/coupon change invalidates the retry). - **No merchant webhooks in v1 — reconcile-on-read:** the success page
    (`?pm=rzp`) fires `reconcileMyOrderPayment` (owner-gated, asks Razorpay
    directly), and the reaper `/api/cron/expire-pending-payments`
    (vercel.json, CRON_SECRET; DAILY on the Vercel Hobby plan, which caps
    crons at once/day — bump to hourly on Pro; it's only a backstop since the
    success page reconciles instantly) sweeps razorpay orders pending > 45 min:
    captured at Razorpay ⇒ mark paid (never lose a paid order); otherwise
    claim pending→failed, restock via the reserved→released conditional
    claim (exactly-once, order-actions pattern), release the coupon use,
    cancel the order. Refunds are out of scope v1 (merchant refunds from
    their own Razorpay dashboard).

19. **Signup wizard (Shopify-style, `app/platform/signup/page.tsx`).** One
    client wizard, one focused screen per step, with a progress stepper. Step
    order: **email → password (+ Continue with Google) → phone OTP → name →
    store + location → theme → plan**. Data model: names go to
    `admins.first_name`/`last_name`; the selling **location** (country + city)
    goes to `stores.settings.business` (anon-readable jsonb — non-secret, prints
    on invoices; convention #9). Country list in `lib/countries.ts` (pure,
    client-safe, India-first). - **Auth (Identity Platform, Phase 6)**: email/password via
    `createUserWithEmailAndPassword` (falls back to `signInWithEmailAndPassword`
    on `auth/email-already-in-use`); phone via `PhoneAuthProvider.verifyPhoneNumber`
    (invisible reCAPTCHA) + `updatePhoneNumber`. After each sign-in / phone link
    the client `establishSession()`s (POST the ID token → httpOnly cookie);
    `createStore` enforces `phoneConfirmed` server-side via `getServerUser`, so
    the wizard re-mints the cookie (`establishSession(forceRefresh)`) after phone
    verify. - **Google**: `signInWithPopup(GoogleAuthProvider)` — entirely
    client-side, NO OAuth callback route (removed in Phase 6). After the popup +
    establishSession, the wizard calls `getSignupResumeInfo` to resume at the
    right step (phone / name / dashboard); the same path recovers a refreshed tab
    from the session cookie. **Google users have NO password**, so the store-host
    login (`app/auth/login/login-form.tsx`) ALSO offers "Continue with Google"
    (signInWithPopup); a Google owner can set a password via "Forgot password?". - **Plan + payment**: the plan step reuses the existing merchant subscription
    flow (§ subscription-actions). Free finishes immediately; a paid plan
    (Basic/Pro, monthly/yearly) creates the store first (on free), then opens
    the Razorpay **autopay mandate** via `startSignupSubscription` /
    `confirmSignupSubscription` (`app/actions/subscription-actions.ts`). Those
    are signup-context wrappers: the store was just created on the PLATFORM
    host, so `getActingStoreId` can't resolve it — the caller passes the new
    store id and `assertStoreOwner` authorises them as its superadmin, then
    both delegate to the SAME `startPlanSubscriptionForStore` /
    `confirmSubscriptionForStore` cores the dashboard uses. An abandoned
    payment leaves a working Free store (upgrade later at `/dashboard/plans`).
    Runs on the PLATFORM's Razorpay account (env `RAZORPAY_KEY_ID` /
    `RAZORPAY_KEY_SECRET`).

20. **Analytics is a composable dashboard (`/dashboard/analytics`).** Every card
    is a WIDGET the merchant can remove, re-order, or add back — Shopify's
    "Edit dashboard". Three pieces: - `analytics/widgets.ts` — the registry (pure data, no JSX, importable from
    both server and client): `WidgetId`, per-widget `{title, description,
group, span}` (span = columns of the 4-wide desktop grid),
    `DEFAULT_LAYOUT`, plus `normalizeLayout` / `defaultLayoutFor`. Adding a
    widget = an entry here + a node in the page's `slots` map. - `analytics/page.tsx` — renders EVERY card server-side with the data
    already loaded and hands them to the canvas as `slots`. A widget the
    viewer lacks permission for is never put in the map, so it can't be
    re-added from the library either — **permission gating stays server-side**,
    the client only picks which of the allowed nodes to show. - `analytics/dashboard-canvas.tsx` (client) — owns edit mode: a dark
    contextual save bar (Cancel / Save / Reset to default), per-widget drag
    handle + remove, and the "Add section" popover library. Drag is dnd-kit
    (`rectSortingStrategy`); `useSortable` is only called by `SortableWidget`
    INSIDE the DndContext (read-only mode renders the plain `Widget`, no hook).
    Edits are a DRAFT (`draft: WidgetId[] | null`) — Cancel discards, Save
    commits. **Layout lives in localStorage, per store**
    (`sm.analytics.layout.v1.{storeId}`): it's a personal display preference,
    so it needs no table, no migration and no round trip, and a lost layout
    just falls back to the default. `readLayout`/`writeLayout` are the two
    functions to swap if it should ever follow a user across devices. First
    paint renders the DEFAULT layout and the saved one is applied in an
    effect (server/client hydration must agree). - **Visual language**: the page root `.dash-analytics` re-skins the shared
    `.dash-card` chrome into the quieter Shopify look (hairline borders,
    dotted-underline titles, monochrome bars/icons, colour reserved for trend
    direction) WITHOUT touching how cards look on any other dashboard page —
    all in the `/* Analytics (Shopify-style) */` block of `dashboard.css`.

21. **Help Centre (`help.storemink.com`) — platform-global, operator-managed
    docs (Shopify-style).** StoreMink's OWN product docs, NOT per-store data, so
    there is **no `store_id`** anywhere — the model mirrors `platform_admins` (a
    global, operator-managed table). Two tables in `supabase/help_centre.sql`
    (run as `postgres` via the Cloud SQL proxy, like every migration):
    `help_categories` + `help_articles` (sanitized HTML `body`, `status`
    draft/published, weighted **generated `search` tsvector** column + GIN index
    — the first real FTS in the codebase; plus `view_count`/`helpful_yes`/
    `helpful_no`). RLS: anon reads published only; writes gated on
    `is_platform_admin()`. Public feedback/view counters are narrow atomic
    `SECURITY DEFINER` RPCs (`help_article_view`, `help_article_vote`) so no
    write policy opens to anon (hardened to `search_path=''` +
    schema-qualified refs in `help_centre_02_rpc_search_path.sql`; the public
    `voteHelpArticle` action deliberately does NOT `revalidateTag` — an
    anon-triggerable global cache bust — so helpful counts are
    eventual-consistency). Drizzle tables added to `drizzle/schema.ts`
    (`helpCategories`, `helpArticles`; the generated `search` column is
    intentionally absent — search uses a raw `sql` predicate).
    - **Public site** (`app/help/*`, statically generated + ISR, fully
      crawlable): `/help` (search + category grid + popular). The category +
      article pages use a **3-pane docs layout** (`.hc-docs`): a fixed left
      **Topics tree** (`getHelpNavTree` → collapsible client `help-sidebar.tsx`,
      active category expanded/highlighted), the scrolling content, and a fixed
      right on-this-page TOC. `/help/[category]`,
      `/help/[category]/[slug]` (rendered body + breadcrumbs + on-this-page TOC +
      "was this helpful?" + related; **operator-only `?preview=1`** renders a
      draft via the uncached, `getPlatformViewer`-gated `lib/help/preview.ts` —
      non-operators fall through to published/404, so a leaked URL leaks
      nothing), `/help/search` (FTS, noindex). Reads via
      cached `lib/help/queries.ts` (`withAnon`, tag `TAGS.help`); types +
      mappers in `lib/help/types.ts`. SEO: per-page `generateMetadata` +
      canonical on `HELP_URL` (`lib/site.ts`), `helpArticleSchema` (TechArticle)
      - `breadcrumbSchema` JSON-LD, and a \*\*help-host branch in `app/sitemap.ts`
      - `app/robots.ts`\*\* (both were previously store-only). IndexNow pings on
        publish (prod only). The old static `app/help/page.tsx` (hardcoded topic
        cards) is retired.
    - **Management console** at **`/dashboard/help`** (platform host; nav entry
      in `app/platform/dashboard/(console)/layout.tsx`, `faq` icon), gated by
      `getPlatformViewer()`. `app/actions/help-actions.ts` holds public actions
      (`suggestHelpArticles`, `recordHelpArticleView`, `voteHelpArticle` — the
      two public counters are per-IP rate-limited via `lib/rate-limit`, since
      `view_count` drives both the Popular ordering and search ranking) and
      operator CRUD (articles + categories, publish/unpublish, reorder) under
      `withService` after the gate. **`deleteHelpCategory` refuses a non-empty
      category** (atomic `NOT EXISTS` guard on the DELETE — the conditional-write
      pattern): the FK is `ON DELETE SET NULL`, so deleting one would strand its
      articles with no category and therefore no URL. Storefront reads
      (`searchHelpArticles`/`getPopularHelpArticles`) inner-join the category so
      any legacy orphan stays invisible rather than showing an unlinkable hit.
      Plus **AI drafting** — `runHelpAiCommand`
      (Gemini via `lib/ai/gemini.ts`, a fixed technical-writer system prompt in
      `brand/tasks/help-article.md`; output sanitized) is one flexible command
      that both writes-from-scratch and edits current content per a
      natural-language instruction. The editor is a **full-screen takeover
      route** (`help/new` + `help/[id]`, Shopify-style — `fixed inset-0` over the
      dashboard chrome, not a modal), `article-editor.tsx`: a TipTap WYSIWYG
      adapted from the blog editor with an **AI chat composer** (one input drives
      `runHelpAiCommand`), image upload to the `help-articles/` GCS folder, and
      **tables** (`@tiptap/extension-table` TableKit — insert / add row / add
      column / delete). Console list chrome in
      `help-console.tsx` (rows link to the editor routes; the category manager
      stays a dialog) + `help-admin.css`. Body sanitized on write AND render
      (`sanitizeBlogContent` — which now also permits table `colspan`/`rowspan`
      - cell width so tables survive; the blog trust model).
    - **Production-only indexing**: the `SEARCH_INDEXABLE` gate already keeps
      staging/dev help pages `noindex` (help metadata sets robots noindex
      off-prod too); only `storemink.com` is ever crawled.

22. **Point of Sale (POS) — multi-location foundation (Phase 0, IN PROGRESS).**
    An omnichannel in-store register served at **`{slug}.storemink.com/pos`** (a
    SEPARATE app shell from `/dashboard`, own auth gate — NOT yet built; Phase 1+).
    Full technical design + phased plan: **`docs/pos-plan.md`** (authoritative).
    Pro-only; 2 locations included, extra locations ₹1,000/mo (billing is Phase 7,
    v1 GATES at 2). Work on branch `pos`. **Phase 0 (done) = the inventory
    location foundation, with ZERO changes to existing inventory/checkout code:**
    - **Multi-location inventory.** `store_locations` (per-store shops/warehouses;
      every store auto-gets one `is_default` "Main" location) +
      `inventory_levels` (the per-location source of truth: `on_hand`/`reserved`
      per (location, product, variant-or-null)). SQL: `supabase/pos_00_locations.sql`,
      `pos_01_inventory_levels.sql`, `pos_02_rpc_location.sql` (run as `postgres`,
      in order). `products.stock` / `product_variants.stock` become a
      **trigger-maintained AGGREGATE** = `SUM(on_hand)` across locations
      (`sync_stock_aggregate` trigger), so the storefront, `lib/inventory/status.ts`,
      shop pages and the current inventory dashboard read them UNCHANGED. New
      products/variants get a default-location level row via seed triggers; a
      migration guard FAILS if the aggregate ever drifts after backfill.
    - **RPCs gain a location.** `reserve_stock_at` / `release_stock_at` /
      `adjust_stock_at(p_location, …)` operate on `inventory_levels`; the OLD
      signatures (`reserve_stock`/`release_stock`/`adjust_stock`) are REPLACED with
      thin wrappers delegating to the store's default location
      (`pos_ensure_default_location`) — so `checkout-actions`, `order-actions` and
      `inventory-actions` keep working with NO code change. `stock_movements`
      gained `location_id`. This works because post-create stock writes ALREADY
      flow only through those RPCs (the product editor never writes stock).
    - **Plan + settings + enable flow.** `PLAN_LIMITS.posEnabled` (pro) +
      `posLocationsIncluded` (2) in `lib/plans.ts`. Setting `pos.enabled`
      (registry, section `pos`, `minPlan: pro`, `hidden` so it's driven by a
      dedicated control, not the generic editor — new `SettingDef.hidden` flag).
      New `pos` dashboard section (`permissions.ts`, group Workspace) rendered
      with a **three-state sidebar** in `app/dashboard/layout.tsx`: free/basic →
      "Included in Pro" (badge → `/dashboard/plans`); pro-not-enabled → "Enable
      POS"; enabled → Overview + Locations children. `lib/pos/locations.ts`
      (`getPosState`/`isPosEnabled`/`getStoreLocations`).
      `app/actions/pos-location-actions.ts` (`enablePos`/`disablePos` +
      location CRUD, gated `getManagerIdentity("pos")`, Pro-checked server-side,
      location-capped; tested). Dashboard pages: `app/dashboard/pos/` (overview +
      `locations/`).
    - **Phase 1 (done) = the `/pos` app shell + staff accounts + device
      authorization.** POS is served at **`{slug}.storemink.com/pos`** — a
      SEPARATE app shell from `/dashboard` (outside the `(storefront)` group, so
      it gets only the root layout + its own dark chrome).
      - **Staff have real accounts, created by invitation.** An admin adds a
        cashier/manager by **name + email + role + locations**
        (`inviteStaff`); the staff member gets an emailed link (Resend, the
        `inviteUser` pattern) to **`/pos/register?token=…`** and self-registers:
        **password (typed twice, must match) → phone OTP (Firebase Phone auth,
        the signup wizard's invisible-reCAPTCHA pattern) → their own 8-digit
        PIN (typed twice)**. That creates a Firebase account whose uid is stored
        on `pos_staff.user_id`, flips `status` invited→active, consumes the
        single-use token, and sets a **`cashier`/`manager` role claim** — which
        is what makes `proxy.ts` bounce them out of `/dashboard` to `/pos`. The
        admin NEVER sets or sees a PIN.
      - **Login at `/pos` is email + PIN or email + password** (two modes on one
        screen). PIN → `posLoginWithPin` (server-side scrypt verify → signed
        `pos_operator` cookie); password → Firebase `signInWithEmailAndPassword`
        - `establishSession` (the standard `sm_session`).
      - **Self-service reset** ("Forgot PIN or password?" on the login screen):
        `requestPosCredentialReset` mails a single-use, 1-hour link to
        `/pos/reset?token=…` (`reset_token`/`reset_expires_at`, added by
        `supabase/pos_04_staff_reset.sql`). It is **enumeration-safe** — always
        returns success and is rate-limited per IP AND per address, so only the
        inbox differs. The reset page offers two modes: a new 8-digit PIN
        (hashed server-side) or a new password (written to Identity Platform via
        `updateAuthUser` — the token, not a session, is the authorization). Only
        `active` staff can reset; someone still `invited` must use their
        invitation link. Both staff emails share `lib/pos/staff-email.ts`
        (branded Resend transport + dev console fallback + `posAbsoluteUrl`,
        which builds links from the REQUEST host so they work in local dev).
      - **`/pos/login`, `/pos/register` and `/pos/reset` are public** in
        `proxy.ts` (`POS_PUBLIC_PATHS`) — a new or locked-out staff member has
        no credential by definition, and the emailed token is the authorization.
      - **Hardening (`supabase/pos_05_device_hardening.sql`).** Four invariants
        the register depends on:
        1. **The operator cookie is never trusted for authorisation.**
           `resolvePosOperator` re-reads `pos_staff` on EVERY resolve (active,
           registered, still a POS role, still assigned to the device's
           location), so deactivating, deleting, demoting or unassigning a staff
           member ends their session at once instead of when the token lapses.
        2. **Device-token rotation + clone detection.** The `pos_device` cookie
           embeds a `nonce` matched against `pos_devices.token_nonce`, rotated on
           every operator sign-in. A cookie COPIED off a trusted device carries a
           retired nonce, so `getAuthorizedDevice` revokes the device and logs
           `device_clone_detected` (a signature alone can't catch a clone — the
           clone's signature is valid). A 2-minute `prev_nonce` grace window
           absorbs in-flight requests so a real shop is never locked out; devices
           enrolled before rotation adopt their presented nonce.
        3. **POS cookies are host-only and `SameSite=Strict`** — unlike
           `sm_session`, which spans `.storemink.com` by design. A register
           credential is never transmitted to other stores' subdomains, the
           platform apex, or the help centre.
        4. **Append-only audit trail** (`pos_audit_log`, admin-readable,
           service-role writes) for device authorized/revoked, clone detected,
           operator login + failed login, via `lib/pos/audit.ts` — always
           best-effort, so a logging failure can never block a sale. Surfaced on
           **`/dashboard/pos/devices`** (`listPosActivity`) next to a **Revoked
           devices** list showing WHY each died — without that, a clone-detected
           auto-revoke is an unexplainable outage.
           Pairing codes are additionally rate-limited **per store**, not just per
           IP, so a distributed attacker can't grind them, and
           `PLAN_LIMITS.posDevicesPerLocation` (pro: 5) caps authorized devices
           per location — enforced in `registerDevice` (the choke point both
           authorization paths funnel through) and pre-checked in
           `createPairingCode` so an admin isn't handed an unusable code.
        5. **Idle auto-lock** (`app/pos/idle-lock.tsx`): a PIN operator's
           register locks after `pos.idleLockMinutes` of inactivity (registry
           setting, default 10, edited at `/dashboard/pos/settings`) with a 20s
           countdown. Owners are exempt — this targets the
           walked-away-from-a-shared-till risk. It is a physical-presence
           measure, NOT an authorization boundary (a client bypass keeps the
           cookie until it expires); the server boundary remains the device gate
           - per-request `pos_staff` re-validation.
      - **Device authorization is the security boundary** (a cashier must not be
        able to sell from their personal phone). A browser becomes an authorized
        POS device when the **owner** either taps "Authorize this device" while
        signed in on it (`authorizeThisDevice`) or enters an
        authorization code generated in the dashboard (`createPairingCode` →
        `pairDevice`, single-use, 10-min TTL). It then holds a long-lived signed
        **`pos_device`** cookie `{deviceId,storeId,locationId}`. **Staff
        (cashier/manager) can ONLY resolve as an operator on an authorized,
        non-revoked device** (`lib/pos/devices.ts` `getAuthorizedDevice`, checked
        in `resolvePosOperator` for BOTH the PIN and password paths); owners are
        not device-restricted. Revoking a device kills its access (and any
        operator session — the operator token carries its `deviceId`) on the next
        request. Known limits: it's per-browser-profile, so clearing site data
        de-authorizes (owner re-authorizes in seconds).
      - Both POS cookies are HMAC-signed with **`POS_SESSION_SECRET`** and
        verified in the Node-runtime `proxy.ts` with NO DB call (verify returns
        null — never throws — when the secret is unset, so /pos degrades to the
        login gate instead of 500ing).
      - Modules: `lib/pos/session.ts` (sign/verify both cookies),
        `lib/pos/pin.ts` (scrypt, **exactly 8 digits**), `lib/pos/permissions.ts`
        (`posCan` — cashier=sell, manager=+refund/inventory/shift, owner=all),
        `lib/pos/devices.ts`, `lib/pos/operator.ts` (`resolvePosOperator`:
        owner → PIN operator → staff Firebase session). SQL:
        `supabase/pos_03_staff_devices.sql` — `pos_staff` (email, role,
        `user_id`, scrypt `pin_hash`, `status`, single-use `invite_token`),
        `pos_staff_locations` (managers are location-bound, auto-scoped at
        login), `pos_devices` (revocable), `pos_pairing_codes`. Actions:
        `pos-staff-actions.ts` (invite/resend/update/activate/delete +
        `getInviteInfo`/`completeStaffRegistration`) and `pos-auth-actions.ts`
        (`authorizeThisDevice`/`createPairingCode`/`listDevices`/`revokeDevice`;
        `pairDevice`/`posLoginWithPin`/`posLock`, rate-limited) — both tested,
        plus pure-module tests for session/pin/permissions. `/pos` routes:
        `layout.tsx` (store + Pro + pos.enabled gate), `page.tsx` (operator gate
        → register shell + the owner's "authorize this device" card),
        `login/` (email + PIN pad / password), `register/` (the 3-step
        self-registration wizard). Dashboard: `/dashboard/pos/staff` +
        `/dashboard/pos/devices`.
    - **Phase 2 (v1, done) = the register.** `app/actions/pos-sale-actions.ts`
      is the sell path's trust boundary and mirrors `placeOrder` (§12) step for
      step: operator resolved server-side, prices RE-READ from the DB, discount
      re-derived and capped (manager PIN above the cap via `verifyManagerPin`),
      tax recomputed, stock reserved atomically **at the register's location**
      (`reserve_stock_at`), service-role writes last, and a reverse rollback
      chain on any failure. `getRegisterConfig` opens the register;
      `placePosSale` rings it; `getPosReceipt` re-renders one.
      - **★ ONE total, shared by the screen and the sale** (`lib/pos/totals.ts`,
        pure + tested). `posTotals` owns subtotal → line markdowns → capped
        order discount → tax → total, and BOTH `placePosSale` and the sell
        screen call it. The screen used to quote the PRE-TAX subtotal ("tax is
        calculated on the server when the sale completes") while the server
        charged the tax-inclusive total: a ₹238 cart on a 5% class was quoted
        ₹238, rung up at ₹249.90, and ₹300 cash returned ₹50.10 instead of the
        ₹62 promised — and tendering the quoted ₹238 was refused as "the payment
        doesn't cover the total" by the same panel that said "Paid in full
        ₹238". Rates reach the client via `RegisterConfig.taxRates` (class id →
        rate) + `PosCatalogItem.taxClassId`, resolved with the store's
        `defaultTaxClassId` exactly as the server resolves it — no round trip,
        so the POS zero-network promise holds. Rates ride in the CONFIG, not the
        cached catalog, because the catalog persists in IndexedDB and a stale
        rate would misquote a customer; the catalog cache key now carries a
        `SCHEMA_VERSION` so an older CatalogItem shape is re-synced rather than
        served. Money is compared in PAISE (`coversTotal`/`changeDue`) — a
        rupee-float compare can refuse an exactly-covering payment.
      - **GST place of supply**: `lib/billing/gst.ts` — `splitGst` takes the tax
        AMOUNT (not the rate) so it can never disagree with `computeTax`'s
        rounding, and the halves re-sum exactly. Intra-state ⇒ CGST+SGST,
        inter-state ⇒ IGST; unknown data defaults to INTRA. Snapshotted per line
        (`order_items.tax_cgst/tax_sgst/tax_igst`).
      - **Thermal receipt**: `lib/pos/receipt.ts` (pure `buildReceiptModel` off
        the order snapshot) + `components/pos/thermal-receipt.tsx` + its CSS —
        a 80mm roll format, deliberately NOT the A4 invoice of §17.
      - **Barcode scanning, three engines behind one seam**
        (`lib/pos/barcode-camera.ts`): a hardware scanner is a keyboard, so the
        search input + its trailing Enter is the default and needs no
        permission; on mobile the camera uses the native `BarcodeDetector`, and
        `@zxing/browser` (lazy WASM) covers browsers without it. Merchants scan
        SUPPLIER barcodes — `products.barcode`/`product_variants.barcode`,
        entered in the product editor. StoreMink never prints its own.
      - **★ STICKY FOCUS IS FOR KEYBOARD DEVICES ONLY** — on a tablet it was
        the register's most-complained-about behaviour. Keeping the search box
        focused is what makes a scan land with zero clicks, so the register
        re-focused it on mount, on every cart change, and 80 ms after any blur.
        On an iPad that means **tap a product, get the software keyboard**: the
        tap blurs the box, focus is taken straight back, and iPadOS answers a
        programmatic focus by opening the keyboard over half the till — every
        single time. `isTouchPrimary()` (`lib/pos/keyboard-wedge.ts`,
        `(hover: none) and (pointer: coarse)`) switches it off there;
        `autoFocus` is gone for the same reason. The query pairs `hover: none`
        WITH coarse so a touchscreen laptop — which has a real keyboard — keeps
        the fast path. It reaches BEHAVIOUR only, never rendered markup: the
        SSR snapshot is `false`, so a placeholder or class keyed off it would
        be a hydration mismatch on the exact devices it targets.
      - **★ SO A SCAN MUST WORK WITH NOTHING FOCUSED.** Turning sticky focus
        off would otherwise cost an iPad + Bluetooth-scanner shop — a very
        ordinary setup — its scanner, silently. `createKeyboardWedge()` (pure,
        tested) is a document-level listener that reads a fast burst of
        characters ending in Enter, and it is enabled on ALL devices: on a
        desktop the box holds focus, so `isEditableTarget` hands every key to
        it and behaviour is byte-for-byte what it was. It **swallows the burst**
        (`preventDefault`) — after a tap the product tile is the focused
        element and both Space and Enter activate a focused button, so an
        unhandled scan would re-ring the TAPPED product instead of adding the
        scanned one. It is not a scanner-vs-human heuristic (a human can't type
        into an unfocused screen); the gap rule only stops stray keypresses
        minutes apart from joining into one nonsense code.
      - **Refocus is suppressed while ANY overlay is open** — tender, choices,
        camera, layout, **customer search and the receipt**. The last two were
        missing, and the customer panel `autoFocus`es its own search box: the
        register grabbed focus back 80 ms later, so attaching a customer was
        unusable on desktop too.
      - **★ Local catalog cache — the "<50 ms, zero network" promise
        (docs/pos-plan.md §10).** `lib/pos/catalog-index.ts` is the PURE
        matching core (`buildIndex`/`scanLocal`/`searchLocal`/
        `applyStockDeltas`); `catalog-store.ts` persists it to IndexedDB, keyed
        per **store+location** (stock is per-location and a browser can be
        shared); `use-catalog.ts` hydrates from that cache on mount, then syncs
        the full catalog in the background via `getCatalogSnapshot` (keyset
        paging over `products.id`, 300 products/page — pages stay stable while
        the catalog is edited, and a product's variants can't split at a seam).
        Measured in-browser: a scan resolves in **~0.001 ms** (Map hit) and a
        keystroke search in **1.4–5.3 ms** across 1k–20k SKUs, which is why the
        search is a plain linear scan rather than an inverted index that would
        need invalidating on every sync. Three rules keep it honest: a local
        MISS falls through to `lookupProducts` (a product created since the last
        sync must stay sellable); nothing cached is authoritative (the server
        re-prices and re-reserves, so staleness is a display bug at worst, never
        a wrong charge or an oversell); and **every IndexedDB call degrades to a
        no-op** when the API is missing or throws (private-mode Safari, kiosk
        profiles, quota) so the register just falls back to the server. Sales
        decrement the cache immediately (`applySold`); a 5-min interval
        re-syncs, and the header chip shows the cached count + a manual refresh.
      - **Customer attach + GSTIN + line discounts.** `searchPosCustomers`
        finds an EXISTING customer of the store (phone/name/email, 2-char
        floor, store-scoped) to attach to a sale; the register cannot CREATE
        one, because `users.id` IS the Firebase uid and `(phone, store_id)` is
        unique — a till-invented row would collide with, and break, that same
        person's later online signup. Walk-in capture needs a claim/merge
        story and belongs with the CRM phase. `placePosSale` **verifies the
        customer belongs to this store** before writing (without it a sale
        could be filed against another store's customer, who holds RLS SELECT
        on their own orders and would see a foreign order in their history)
        and **format-validates the GSTIN** (`isValidGstinFormat`, normalised
        upper-case) since it prints on the invoice. The GSTIN is independent
        of the attach — a business buyer needs no account to get it on the
        bill. **Per-line discounts** mark down ONE line (a damaged tin) as
        opposed to the whole sale: capped server-side at the line's own gross,
        counted toward the manager-approval cap together with the order-level
        discount (so a cashier can't stay under it by splitting the giveaway),
        and persisted in `order_items.line_discount`
        (`supabase/pos_07_line_discount.sql`) — `total` stays net of it, so
        existing readers are unaffected, and the thermal receipt prints
        "2 × ₹100 … ₹200 / Less −₹30 = ₹170" instead of arithmetic that
        doesn't add up. Recording it also makes markdowns auditable per
        cashier, which is the point of the cap.
      - **A register sale is a SALE — it emits like one.** `placePosSale` ends
        with `emitEvent("order.placed")` + `reportStockChanges` (§22
        notifications). Without them an in-store sale wrote an `orders` row and
        nothing else: no `/dashboard/activity` entry, no team alert, and no
        low/out-of-stock warning even when it emptied the shelf — the one
        channel physically in front of the merchant was the one they couldn't
        see. `customerId` is null for a walk-in, which the fan-out reads as "no
        customer audience" (right: they leave holding a receipt). NOTE the
        coverage guard can't catch this class of gap — it asserts a key is
        emitted SOMEWHERE, not that every path which should emit it does.
      - **CANCELLING A POS SALE RESTOCKS AT ITS OWN LOCATION.**
        `updateOrderStatus` returns `orders.location_id` with the
        reserved→released claim and calls `release_stock_at` when it's set. The
        plain `release_stock` wrapper delegates to the store's DEFAULT location
        (`pos_02_rpc_location.sql`), so cancelling an in-store sale used to hand
        the units to the wrong shop — the selling location never recovered its
        stock and the default gained one it never had, silently, compounding
        per cancellation. Online orders reserve against the default and keep the
        wrapper. Both branches are regression-tested.
      - **Sold-out last, and the manager-arranged grid.** Sold-out SKUs sink
        to the end of the register grid — `isOutOfStock` in
        `lib/pos/catalog-index.ts` is the ONE definition (the grid's disabled
        state and the ordering must agree), and `buildIndex` precomputes an
        `ordered` array so the empty-query slice can't fill the first screen
        with things nobody can sell. **`applyLayout`** then lets a manager or
        owner (`edit_layout` capability, so never a cashier) choose exactly
        which products the till shows and in what order — `/pos/sell` →
        "Edit layout" (`layout-editor.tsx`: searchable catalogue on the left,
        dnd-kit sortable grid on the right), stored per LOCATION in
        `pos_layouts` (`supabase/pos_09_register_layout.sql`,
        `app/actions/pos-layout-actions.ts`). Three rules: **no row = show the
        whole catalogue**, so the feature could not blank a register that
        predates it and a failed read degrades to everything rather than an
        empty till; the sold-out shift is computed at RENDER, never written
        back, so a restock returns a product to its chosen slot with no edit;
        and **search always spans the whole catalogue** — the layout decides
        what the IDLE grid shows, never what can be found and sold, or the
        products left off would be unsellable. Entries are not FK-checked, so
        a deleted product silently drops its tile; the header shows
        "12 of 20 products" once configured.
    - **Phase 3 (done) = shifts & cash reconciliation.** A shift is one
      accounting period for a location's cash drawer:
      `expected = float + net cash sales + paid-ins − payouts − drops`, and
      `variance = counted − expected` (negative = short). `lib/pos/shifts.ts`
      is the PURE math (tested); `app/actions/pos-shift-actions.ts` is the
      gate; `/pos/shift` is the screen, which shows the whole equation rather
      than just the answer — "expected ₹1,895" is only trustworthy if you can
      see what fed it.
      - **Per LOCATION, not per device.** Owners are not device-bound
        (`resolvePosOperator` resolves them with no device), so a per-device
        shift would have no home for an owner's cash sale. Every operator has a
        `locationId`. A store running several drawers per shop wants a
        `device_id` column and a wider partial unique index; nothing else
        changes.
      - **ONE open shift per location, enforced by a partial unique index** —
        not by application logic. Two managers tapping "Open" at the same
        moment cannot split a day's cash across two drawers; the loser gets a
        friendly "already open" rather than a raw constraint error. Closing
        claims the open→closed transition CONDITIONALLY (the order-cancellation
        pattern), so a second tap can't overwrite the first count.
      - **`orders.shift_id` is stamped at sale time**, not inferred from a time
        window — a sale rung a second before midnight must not land in
        tomorrow's drawer. If the drawer lookup fails the sale still completes
        and goes unattributed, which reconciliation surfaces rather than hides.
      - **★ Change is subtracted ONCE per order.** `placePosSale` writes the
        SALE's `change_due` onto EVERY cash tender row, so a sale settled with
        two cash tenders carries it twice. Summing would deduct it twice and
        report the drawer short by that amount every time — a small, consistent
        discrepancy that gets blamed on a cashier. `netCashFromSales` groups by
        order and takes the max; `totalsByMethod` delegates to it rather than
        re-implementing. Both directions are tested.
      - Settings (convention #9): `pos.requireOpenShift` (default **off** —
        turning it on can stop a till, so it stays the merchant's call) and
        `pos.cashVarianceTolerance` (a hand-counted drawer is never exact to
        the paise). Capabilities: `open_close_shift` to open/close,
        `cash_drop` to bank cash — a cashier sells INTO the drawer but cannot
        declare what was in it. A CLOSED shift reports the figures snapshotted
        at close, so an old Z-report can't drift when an order is later edited.
    - **Phase 4 (done) = inventory from the shop floor.** `/pos/inventory`
      (`app/actions/pos-inventory-actions.ts`, gated on `adjust_inventory`, so
      a cashier sells stock but never declares how much exists). Search or
      scan, then three actions per row: **receive/correct** a delta, **count**
      to an absolute figure, or **send** stock to another location. The
      location is ALWAYS the operator's session — the only location a caller
      may name is a transfer's destination, verified against the store here
      AND again inside the RPC.
      - **A count is stored as a DELTA, not an absolute write.** It goes
        through the same atomic `adjust_stock_at` and leaves the same ledger
        row as any other correction — and a sale rung while someone was
        counting the shelf isn't silently erased. A count that matches writes
        nothing, so confirming a figure doesn't litter the history.
      - **★ `transfer_stock` is ONE RPC because it touches TWO locations**
        (`supabase/pos_11_transfer_stock.sql`). The app has no cross-statement
        transaction over the pool — that's why placeOrder/placePosSale carry
        manual rollback chains — so doing this as two adjustments could
        decrement the source, fail to credit the destination, and the units
        would simply cease to exist on the store's books. A plpgsql body is
        one transaction, so both legs commit or neither does. The source
        decrement is CONDITIONAL on having the stock, so two managers moving
        the last 5 units can't both win. Writes paired `transfer_out` /
        `transfer_in` ledger rows so each location's history explains its own
        balance. **If `reserved` is ever brought into use, the guard must
        become `on_hand - reserved >= qty`** or a transfer will ship units
        already promised to an online order.
      - Adjustments feed `reportStockChanges`, so a manual correction to zero
        still fires the low/out-of-stock crossing (§22) rather than alerting
        nobody.
23. **Locations own capabilities; POS is one of them.** Locations used to live
    under Point of Sale. They don't: a warehouse is a location with POS
    switched off, and pickup/online-fulfilment/returns are storefront features
    that merely depend on a location. So **`/dashboard/locations`** is its own
    Workspace section (above Point of Sale), `/dashboard/pos/locations`
    redirects to it, and `pos-location-actions.ts` became
    `location-actions.ts`. Full design: `docs/locations-ia.md`; the phased
    build: `docs/inventory-fulfilment-roadmap.md`.
    - **`lib/locations/capabilities.ts` is a REGISTRY, not columns.** Six
      capabilities (`pos`, `online_fulfil`, `pickup`, `returns`,
      `receive_stock`, `transfer_stock`) with labels, `requires`, `minPlan` and
      per-type creation defaults, stored in `store_locations.capabilities`
      (jsonb, `locations_01_capabilities.sql`). Six boolean columns would make
      a seventh capability a migration plus a check to forget in every
      consumer; as jsonb it's one registry entry and `normalizeCapabilities()`
      gives existing rows a sensible value with no migration — the same trade
      `stores.settings.features` makes. **PUBLIC** — the storefront reads it to
      decide whether to offer pickup, so no secrets.
    - **`locationCan()` is the only read.** Three gates: the stored flag, every
      capability in `requires`, and the plan. `pickup`/`returns` require `pos`
      (someone has to hand the goods over) and are `minPlan: pro`.
      `applyCapability()` cascades a switch-off to dependants so the stored
      state can never disagree with what `locationCan` reports.
    - **Two rules enforced server-side** in `saveLocationCapabilities` — a
      disabled checkbox is not a permission: a capability whose dependency is
      off is stored off, and **the last location fulfilling online orders
      cannot be switched off** (the store would advertise products it has no
      way to ship, and every checkout would fail with no visible cause).
    - **The backfill is NOT the creation defaults.** A migration may not change
      what a live store does, so a capability describing EXISTING behaviour is
      backfilled ON (`online_fulfil` on the default location — the
      `reserve_stock` wrapper sends every online order there) and one
      introducing NEW behaviour is backfilled OFF (`pickup`, `returns`).
    - **Location CRUD no longer requires POS to be switched on** — only Pro. A
      warehouse that fulfils online orders needs no till. The sidebar entry is
      hidden until the store has 2+ locations or POS is on, so a
      single-location store never sees it.
    - **The desk view can now target a shop (Phase C).**
      `/dashboard/inventory` gained a location selector: **All locations** shows
      the cross-location total and is READ-ONLY (you cannot adjust a sum), while
      a specific shop is editable and routes every write through
      `adjust_stock_at`. Omitting the location keeps the compatibility wrapper,
      so a single-location store is untouched and never sees the selector.
      Three things had to move together or the page would lie: the list reads
      `inventory_levels.on_hand` at that shop instead of the `products.stock`
      aggregate; **`setStock` computes its delta against THAT shelf** (against
      the aggregate it would write a wildly wrong correction); and `bulkAdjust`
      does the same for its batch baseline, treating a shop that has never
      carried a SKU as zero rather than skipping it — which is the normal case
      when stocking a new shop. The selector is also scope-aware (§B2): a
      location-bound admin sees only their shops, and naming another one in the
      URL is refused server-side.
    - **Online orders are ROUTED to a location (Phase D).** Checkout used to
      call the `reserve_stock` wrapper, which always targets the store's
      DEFAULT location — so a store with stock in a second shop advertised it
      and then failed the order. `lib/fulfilment/resolve.ts` now picks a
      location and `placeOrder` reserves there and stamps `orders.location_id`,
      which also brings online orders inside the §B2 location scope.
      - **`lib/fulfilment/strategies.ts` is a REGISTRY** (roadmap §1.2), not a
        switch. v1 registers `priority`; `nearest`/`most_stock`/`cheapest` each
        become a file that registers itself, and checkout never learns their
        names. An unknown strategy id resolves to the default rather than
        stopping a store selling.
      - **Falling back is deliberate.** No rules row, no eligible location, or
        a failed query ⇒ null ⇒ the wrapper's default location, exactly as
        before. Routing must never be the reason a sale is refused. A store
        with one location short-circuits entirely.
      - **★ `products.online_stock` is what the STOREFRONT promises.**
        `products.stock` stays the all-locations total (the dashboard and POS
        want that); `online_stock` is the same sum restricted to locations with
        `online_fulfil` that are active. Both are maintained by the SAME
        `_recompute_stock_aggregate`, so there is one place stock totals are
        derived. A second trigger recomputes on a capability or `active`
        change — without it, enabling fulfilment at a shop would leave the
        website saying "out of stock" until something else touched that SKU.
        The migration's guard FAILS if `online_stock > stock`, which can only
        mean the capability filter is wrong.
    - **Stock can be HELD as well as sold (Phase E).**
      `supabase/locations_04_reservations.sql` puts
      `inventory_levels.reserved` to work — it had been carried since pos_01
      and never read — so **`available = on_hand − reserved`**, and every
      existing guard (`reserve_stock_at`, `transfer_stock`) now subtracts it.
      `stock_reservations` says WHOSE hold it is and when it lapses, which the
      bare counter cannot. `lib/inventory/reservations.ts` is the API:
      `holdStock` (reserved += qty, on_hand untouched — the goods are still on
      the shelf), `commitHold` (the sale happened), `releaseHold` (it didn't),
      `sweepExpiredHolds`. Purely ADDITIVE: nothing that existed changed
      behaviour, because a store with no holds has `reserved = 0` everywhere.
    - **Pick up in store (Phase F).** A shopper buys online and collects at a
      shop. `supabase/locations_05_pickup.sql` adds `fulfilment_type` /
      `pickup_location_id` / `pickup_status` / `pickup_expires_at` /
      `collected_at` / `collected_by` to `orders` — columns, not a side table,
      because a pickup IS an order (same money, items, invoice, history) and a
      side table would mean every order read either joins it or silently
      ignores a whole fulfilment mode. `lib/fulfilment/pickup.ts` decides
      where; `/pos/pickups` hands it over; the sweep rides on
      `/api/cron/expire-pending-payments`. Config:
      `fulfilment.offerPickup` + `fulfilment.pickupHoldDays` (section
      `locations`, rendered on Locations → Online fulfilment).
      - **A pickup HOLDS, it does not sell** — `placeOrder` calls `holdStock`
        instead of `reserve_stock_at`. Selling would empty the shelf on screen
        while the box is still physically on it, and the shop would reorder
        stock it already has. Handing over commits the holds; cancelling or
        expiring releases them.
      - **★ SO THE ORDER CARRIES `stock_status: 'none'`.** The cancel path's
        reserved→released claim RESTOCKS, and running it on a pickup would ADD
        units that never left — inflating that shop's count on every
        cancellation. `updateOrderStatus` releases the order's pickup holds
        instead, which is idempotent, so a second cancel is a no-op.
      - **A shop is offered only if it can actually serve the basket**:
        the `pickup` capability (which itself `requires` `pos` — someone has to
        hand the goods over — and is Pro), active, and enough **available**
        (`on_hand − reserved`) stock. Offering a shop whose last unit is
        already held for somebody else's collection is how two people are
        promised the same box. A short shop is still LISTED, flagged and
        disabled, rather than hidden — "not everything is in stock here" is
        information; a silently missing shop is confusing.
      - **The customer's choice OVERRIDES routing** (Phase D), and the chosen
        shop's name + address ride into the `order.placed` payload, so the
        confirmation tells them where to go instead of quoting a delivery
        address they never gave. Delivery orders are untouched — the pickup
        variables are only added when there IS a pickup.
      - **Expiry cancels, it does not refund.** `sweepExpiredPickups` claims
        awaiting/ready → expired per order, then releases the holds (that
        order, so a hand-over racing the sweep can't lose). Refunds wait for
        the returns machinery that records them (roadmap Phase G) — quietly
        moving money on a schedule ahead of that is not a thing to build.
      - **★ WHICH POSTCODES A SHOP COLLECTS TO** (`pickup_pincodes` text[],
        `locations_07`; pure rules in `lib/locations/pincodes.ts`). Merchant
        text in three forms — exact `400001`, prefix `400*`, range
        `400001-400104`. The prefix is what makes it usable: Mumbai is a
        hundred postcodes, and a merchant who can only type exact codes will
        type five and blame the feature. Parsed SERVER-side, and it validates
        what was TYPED rather than what survives stripping — strip-then-check
        turns `oops!!` into the perfectly valid-looking code `OOPS`. It **fails
        OPEN both ways**: no rules = everywhere (so the column changes nothing
        for an existing store — a migration may not change what a live store
        does) and an unknown postcode matches (a first-time shopper has typed
        no address). It decides what is OFFERED, never what is permitted:
        `placeOrder` still validates capability, store and stock and
        deliberately does NOT refuse on a postcode, because a merchant
        forgetting a suburb should cost them a listing, not a sale. Geography
        hides exactly ONE thing — the pickup toggle, when nothing serves them;
        within pickup, far shops sit behind "Collecting somewhere else?"
        rather than being dropped, since people collect near work or family
        and a delivery postcode is a guess at where they are, not a fact about
        where they will drive. That dependency is also why the chooser sits
        BELOW the address step. Rules are KEPT when pickup is switched off
        (inert, and retyping a hundred postcodes is a real cost).
      - **★ THE NUDGE IS A CLAIM, NOT A SCHEDULE.** `sweepPickupReminders`
        warns 24 hours out (`PICKUP_WARN_HOURS`, which must stay ≥ the cron
        interval or an order slips the whole window between two runs and
        expires unwarned) and claims `orders.pickup_warned_at` NULL → now() in
        the same conditional UPDATE it selects with
        (`locations_06_pickup_reminder.sql`). The cron is a HEARTBEAT — it
        re-reads the same rows every run — and `notifications`' UNIQUE on
        (event, recipient) cannot dedupe this because every emit creates a NEW
        event row. Without the claim, a merchant mails the same customer about
        the same box daily, which is how people learn to ignore their email.
        Reminders run AFTER the expiry sweep: an order that just lapsed is no
        longer awaiting collection, and telling someone to hurry and collect
        something already cancelled is worse than saying nothing.
    - **Not yet built:** returns/store credit (Phase 5), Twilio receipts (6),
      metered extra-location billing (7), omnichannel/BOPIS (8), offline
      outbox (9). See `docs/pos-plan.md`.

24. **Notifications & email — one event log, registry-driven fan-out, one way
    out.** **📖 Full guide: `docs/notifications.md`** (mental model, where each
    decision lives, how to add one, troubleshooting). This section restores the
    summary the POS merge overwrote.
    - **EVERY action emits an EVENT** into append-only `activity_events` — the
      audit trail, complete by construction, rendered at `/dashboard/activity`.
      Only events with a non-empty `audiences` entry FAN OUT into per-recipient
      `notifications` rows; `audiences: {}` is audit-only, which is how a busy
      store gets full history without 400 badges a day.
    - **ONE EVENT, TWO AUDIENCES.** "Order placed" tells the TEAM ("New order
      ORD10011027 · ₹1,240") and the CUSTOMER ("Thanks for your order") — same
      trigger, nothing else shared. Config is **per audience**
      (`notification_settings.channels`/`templates` keyed `{team, customer}`),
      because turning off team email must never stop a shopper's confirmation.
      That was a real bug; there is a regression test.
    - **Configuration resolves in THREE layers**, the settings-registry shape
      (convention #9): code registry (`lib/notifications/events.ts`) ←
      `notification_definitions` (operators) ← `notification_settings` (the
      merchant). An empty database behaves exactly like the code defaults.
      Console at **Settings → Notifications**, gated on the `notifications`
      section; personal opt-outs at `…/notifications/me`.
    - **EVERY registry entry HAS AN EMITTER — CI-enforced.**
      `lib/notifications/coverage.test.ts` fails unless each key is emitted from
      `app/`/`lib/` or listed in `PENDING` with the unbuilt feature it waits on.
      27 of 38 were dead before it existed. **Its limit:** it asserts a key is
      emitted SOMEWHERE, not that every path which should emit it does — which
      is how POS sales stayed silent (§22).
    - **`recordEvent` in crons/webhooks, `emitEvent` in server actions** —
      `after()` has nothing to defer onto once a cron response is sent.
    - **THRESHOLD EVENTS FIRE ON THE CROSSING, NOT THE STATE**, or a merchant
      gets one mail per sale and stops reading all of them: `stockAlertFor`
      (`lib/inventory/alerts.ts`), `aiWarnAt` (`lib/ai/quota.ts` — at 3 left
      AND at 0, because the FREE plan's whole cap IS 3 and a single trigger
      would have skipped the entire tier), `expiryWarnWindow` (`lib/plans.ts`,
      24-hour bands at 7 and 1 days out), `campaign.sent` (conditional → done
      claim), `customer.signed_up` (`xmax = 0`, so an upsert that only UPDATED
      isn't a signup). All pure and tested.
    - **A NEW MERCHANT GETS A WELCOME.** Store creation used to emit only
      `platform.store_created` — operators, in-app — so the person who had just
      finished signup received NOTHING: no confirmation, no store address, no
      next step. `createStore` now emits **`store.created`** as well
      (store-scoped, `store-admins`, BOTH channels, `configurable: false` —
      nobody can have turned it off before they had an account). The two are
      the same moment for different audiences, which is the §23 rule working as
      intended, not duplication. - **SOME COPY IS HAND-WRITTEN** (`BESPOKE` in default-templates.ts). The
      generated shape — intro, then a Reference/Who/When fact list — is right
      for a report and wrong for anything a person should feel something about;
      a welcome rendered as a fact list reads like a receipt for existing. Keep
      the map small: an event that only needs a better opening line belongs in
      `INTRO`. - **ONE SENDER PER MESSAGE.** Where a dedicated sender exists the registry
      entry is in-app only: `plan.changed` + `subscription.payment_failed`
      leave email to `lib/email/billing-emails.ts`. `plan.expiring` keeps its
      email — nothing else warns before a lapse.
    - **ROUTING HAS A LOCATION AXIS, AND IT IS A SCOPE NOT A MODE.**
      `RoutingRule` was `mode: permission | roles | admins` with no idea where
      anyone worked, so a manager bound to one shop was still emailed about
      every other one. `scope` (`store` | `event_location`) COMPOSES with all
      three modes — "people with the orders permission, AT this order's
      location" is a mode AND a scope, and making location a fourth mode would
      multiply the list every time another axis appears. It can only ever
      NARROW what the mode selected. Two rules keep it from black-holing mail:
      an event with **no** location is never narrowed by one (an online order
      before routing resolves a shop, a blog comment, a plan change), and
      **unrestricted staff still hear everything** — absence is not
      restriction, the same contract as `lib/locations/scope.ts`. Defaults to
      `store`, so nothing changes until a merchant switches an event over.
      `EmitEventInput.locationId` carries it; `placePosSale` passes the
      register's location and `placeOrder` the resolved fulfilment one.
      The console renders it as a second **Where** section in the same
      recipient popover (it composes with the mode, so it is a second
      question, not more entries in the first list), shown ONLY when the
      store has 2+ locations AND `EventDef.hasLocation` is set — a switch
      that would do nothing is worse than no switch.
    - **EVERY EMAIL LEAVES THROUGH `lib/email/send.ts`** (`sendEmail`), which
      sends AND logs, never throws into its caller, and records failures as
      readily as successes. There were EIGHT scattered `resend.emails.send`
      calls and none recorded anything. **`send-coverage.test.ts` fails if a
      ninth appears.** Batch workers can't use the single-message path without
      losing batching, so they call `sendEmailBatch` + `logEmail` explicitly.
    - **A BATCH ERROR IS NOT A VERDICT ON THE BATCH** (`lib/email/send-batch.ts`).
      Resend validates the whole request, so one bad recipient errors all 100 —
      and both workers used to mark all 100 failed, permanently in the campaign
      worker, which has no retry. It now re-sends a failed slice message by
      message so only the real culprit fails; three failures in a row is an
      outage, not a poison pill, so it stops probing.
    - **SENDING ≠ DELIVERY.** `/api/webhooks/resend` (Svix-verified,
      `RESEND_WEBHOOK_SECRET`) writes permanent bounces + complaints to
      **`email_suppressions`** — GLOBAL, no `store_id`, the one table here that
      isn't tenant-scoped, because a hard bounce bounces for everyone and the
      shared sending domain's reputation is the platform's. Only PERMANENT
      signals suppress; an unknown bounce sub-type is treated as soft. Both
      workers filter, failing OPEN. Failed rows surface in a panel on the
      notifications page (`getDeliveryHealth` + `retryFailedEmail`) that renders
      only when mail actually failed.
    - **"INSTANT" RESTS ON THE WORKER KICK.** The cron heartbeat is DAILY, so if
      `triggerEmailWorker` doesn't land, mail waits up to 24 h — silently.
      The origin is **the current request's host** (`getRequestOrigin()`), not a
      configured one: resolving it from env made a local dev order POST the kick
      to `https://staging.storemink.com`, telling another environment to drain a
      queue that wasn't ours. `PLATFORM_URL` remains the fallback for callers
      with no request scope (the cron chaining itself).
    - **EMAIL LOGS** at `/dashboard/activity/email-logs` (a child of Activity
      Logs, same `activity` permission): To / From / Type / Provider / Status /
      Sent at, filterable, with the body in a **sandboxed iframe** (no
      `allow-same-origin`, no `allow-scripts`). `supabase/email_logs.sql`,
      service-role only, pruned at 90 days. `lib/email/mailers.ts` is the
      mail-TYPE catalog and marks `password_reset`, `staff_invite`,
      `pos_staff_invite` and `pos_credential_reset` **sensitive** — their bodies
      carry a working credential and are not stored. **`operator_otp` is
      deliberately NOT redacted** (owner's decision, 2026-07-27): the code is
      stored in full so a sign-in that "never arrived" can be checked. It's
      platform mail (`store_id NULL`), so it only appears on the storemink.com
      console — but an operator can read another operator's live code. Flipping
      one flag reverses it; both behaviours are pinned by tests.
    - **VALUES ARE FORMATTED FOR READING** (`lib/notifications/format.ts`, pure
      - tested). Every value used to reach the email as `String(value)`, so an
        order confirmation read "Total 281.4 / Currency INR / Payment method cod /
        When 28/7/2026, 12:20:46 am" — four tells that nobody had looked at it,
        while the variable catalog had been advertising `sample: "₹1,240.00"` all
        along, so the console previewed something the send could never produce.
        `formatVariable` maps by variable NAME (`items` and `total` are both
        numbers; only one is a price): money → `₹281.40` via Intl with Indian
        grouping, `payment_method` → "Cash on delivery", `status` → title case,
        dates → "28 July 2026 at 5:50 am", `days_left` → "7 days". `link` passes
        through untouched — formatting would corrupt a URL. `HIDDEN_VARIABLES`
        drops `currency` from the summary: it rides on every amount, so its own
        row was the email saying it twice. `summariseItems` replaces the bare
        count with what was bought ("3 items · Amul Taaza Toned Milk (1 L), Tata
        Salt × 2"), capped at three names — the difference between a receipt and a
        log line. The CTA button is renderer chrome (`emailButton` from the
        notification's url), not editable copy, so a body can never end up with
        two of them.
    - **THE QUEUE ROW CARRIES `recipient_type`, AND THE WORKER MUST USE IT.**
      `renderNotificationEmail`'s `isTeam` defaults to TRUE and the worker never
      passed it, so EVERY email rendered as team mail: a shopper's order
      confirmation arrived with a "View in dashboard" button and a footer
      inviting them to "change what you get emailed about" — linking to a
      staff-only page they cannot open, about transactional mail that isn't
      switchable in the first place (the customer audience has no preference
      layer, by design). `isTeamRow` now derives it from the row, defaulting to
      TEAM only for non-customer types so an unknown type can't silently turn a
      receipt back into staff mail. `groupRows` keys on recipient_type too:
      one person can be BOTH (an owner ordering from their own store), and
      grouped without it their staff and customer rows shared one digest
      rendered with whichever sorted first. Regression-tested in both
      directions. - **THE ORDER SUMMARY IS RENDERER CHROME** (`lib/email/line-items.ts`,
      pure + tested). It cannot come through the merchant template system:
      template values are ESCAPED strings — that escaping is the XSS boundary —
      so a table would arrive as visible markup. It renders between the body and
      the CTA button, like the button itself. All `<table>` with inline styles
      and explicit widths, the only layout Outlook, Gmail clipping and a 320px
      phone agree on. Items + totals ladder, discounts shown NEGATIVE (bare,
      they read as another charge and the totals visibly stop adding up), capped
      at 20 rows with "+N more", names escaped, and `""` when there's nothing to
      show — the block is attached to every notification email and an empty
      frame on "Blog approved" would look broken. - **THE ITEMS RIDE THEIR OWN FIELD, NOT THE PAYLOAD.** `EmitEventInput.email`
      is display-only data for the email channel, snapshotted onto
      `notification_email_queue.line_items`
      (`supabase/notifications_06_email_items.sql`) at enqueue. It is separate
      from `payload` because that one is the AUDIT record — kept small and
      scalar on purpose (`sanitizePayload` drops objects and arrays) and read by
      the bell, the activity feed and merchant `{{tokens}}`. Snapshotting (like
      title/body/url) means the worker needs no joins and a receipt keeps the
      prices it was written with. `sanitizeSummary` bounds it: 50 items, capped
      names, coerced numbers. Emitted by `placeOrder` and `placePosSale`, so an
      in-store customer's emailed copy and their printed receipt agree line for
      line. - **The fact list and the table must not both carry the same thing.**
      `HAS_ORDER_SUMMARY` + `SUMMARY_OWNED` (default-templates.ts) drop items
      and every money row from the built-in copy for events that render a
      summary — printing "Total ₹343.00" directly above a table ending in
      ₹343.00 is what makes an email look auto-generated. The fact list keeps
      what the table doesn't: reference, payment method, when. The tokens stay
      declared, so a merchant who wants them can still use them. - **ONE GLOBAL EMAIL DESIGN** (`lib/email/shell.ts`): the same neutral
      palette for every store — white card, near-black text, one dark button.
      The storefront accent is deliberately unused: pushed into an email it must
      survive colour-managed clients and forced dark mode, and the failure mode
      is a customer receiving something that looks broken. Identity comes from
      the logo. Every email type routes through it.
    - **Email is a QUEUE, never an inline send** (`notification_email_queue`):
      the fan-out enqueues, `lib/email/notification-worker.ts` drains it from
      `/api/cron/send-emails`. A Resend round-trip must never sit on a
      checkout's code path. Retries back off (5/15/45 min, 3 attempts).
      **Digests** date each row to the END of its window (clock-aligned, so one
      window is one email); `DAILY_DIGEST_HOUR_UTC` is 23:00 because the cron
      heartbeat is 00:00 UTC — **move it if the cron moves.**

25. **Legal & consent — versioned policies, and consent as evidence.**
    - **TWO LAYERS, DIFFERENT HOMES.** StoreMink's OWN policies (Terms,
      Privacy, Acceptable Use) live in **`legal_documents`** — platform-global,
      no `store_id`, the `platform_admins`/`help_categories` model. A MERCHANT's
      own store policies are ordinary `store_pages` rows at the existing
      `terms`/`privacy-policy`/`refund-policy` slugs, written by a guided
      editor: the deliberate decision NOT to build a second CMS when the website
      builder already renders and versions pages.
    - **A VERSION AND A CHECKSUM, OR IT'S WORTHLESS.** "They accepted the terms"
      means nothing without "…which said THIS". Each version stores its exact
      body plus a sha256, and an acceptance references the version id. So a
      published row is **IMMUTABLE, enforced by a DB trigger** — a change is a
      new version, never an UPDATE — and published rows cannot be deleted
      because acceptances point at them. `legal_documents_current_key` (partial
      unique on `is_current`) guarantees "what must be accepted right now?" has
      exactly one answer per kind.
    - **CONSENT IS NEVER A CLIENT BOOLEAN.** A checkbox is a UI affordance:
      anyone can POST `accepted: true` and a form can be replayed. The row is
      written SERVER-SIDE by `recordSignupConsent` (`lib/legal/store.ts`) from
      the REQUEST's own IP and user agent, against the versions the server
      re-reads — the client never says which version it agreed to.
      `legal_acceptances` is **append-only, trigger-enforced**, service-role
      writes only; retracting consent is a future event, never an edit to the
      past. Idempotent on `(user_id, document_id)`, so the safety-net write in
      `createStore` (for a wizard resumed past the account step) is a no-op when
      the first one landed.
    - **CONTENT LIVES IN CODE, TRUTH LIVES IN THE DB.** `lib/legal/content.ts`
      holds v1 so it is reviewable in a diff; `scripts/seed-legal.ts` publishes
      it idempotently (the `ensureHomepage` pattern). Once published the DB row
      is authoritative and immutable — editing the file changes what the NEXT
      version says, never what anyone already accepted. `/legal/[slug]` renders
      the DB row with its version and effective date, because an acceptance
      references a version and the reader must see which one.
    - **THE TWO BOXES ARE DIFFERENT THINGS.** The mandatory tick names and links
      the actual documents and gates BOTH signup paths (email and Google start
      from the same screen). The optional product-updates box is unticked,
      gates nothing, and writes to `admins.marketing_opt_in` — a preference on
      the PERSON, kept apart from `legal_acceptances` because conflating a
      contract with a mailing preference is what makes a consent record
      arguable later.
    - **ONE BOX, EVERY REQUIRED DOCUMENT — AND THE LIST COMES FROM THE
      REGISTRY.** All three (Terms, Privacy, **Acceptable Use**) are
      `requiredAtSignup`, so all three get a real acceptance row. The AUP was
      briefly excluded on the theory that it rides along via the Terms clause
      "which forms part of these Terms" — but one tick box names every required
      document, so including it costs the merchant nothing: a third name in the
      sentence, not a third box. And it is the document you actually ENFORCE
      against when suspending a store, which is a bad thing to hold only by
      reference from another document. The signup sentence, the acceptance
      write and the re-acceptance gate all read `signupRequiredDocs()` —
      hardcoding the names in the UI is how a merchant ends up ticking a box
      for two documents while the server records three.
    - **FAIL OPEN ON THE GATE, LOUD ON THE WRITE.** `outstandingDocs` (the
      re-acceptance check) returns empty on a DB error — a hiccup must not lock
      every merchant behind a consent screen they cannot pass. But a consent
      write that finds no published documents logs an ERROR: an account created
      with no recorded agreement is exactly what this exists to prevent.
    - **⚠ THE POLICY TEXT IS NOT LAWYER-REVIEWED.** It covers the shields this
      product structurally needs — platform-not-seller, funds settling directly
      to merchants (§18), merchant-as-controller, "as is", liability capped at
      12 months' fees, merchant indemnity — and carries `⚠ REVIEW` markers on
      the clauses where wording most affects exposure. Get counsel on it before
      taking real money.
    - **EDITING A POLICY MEANS PUBLISHING A NEW VERSION.** There is no other
      way, and three things enforce it: the DB trigger rejects an UPDATE to a
      published body, `ensureLegalSeeded` skips a kind that already has a
      current version, and `publishLegalVersion` refuses a version that isn't
      strictly higher than the current one. Flow: edit the body in
      `lib/legal/content.ts`, bump its `version`, run
      `scripts/publish-legal.ts --publish`. The const is `LEGAL_CONTENT`, NOT
      `_V1` — someone writing v2 must not be editing something named for v1.
      **The retire and the insert are ONE transaction** (`withService` wraps in
      BEGIN/COMMIT): `legal_documents_current_key` allows one current row per
      kind, so insert-first violates it — and retire-first that dies before the
      insert would leave the policy with NO current version, which makes the
      signup screen nameless and `recordSignupConsent` log "no published
      documents" for every new account. Order is pinned by a test.
    - **THE PUBLISH SCRIPT IS DRY-RUN BY DEFAULT.** It cannot be undone and, with
      the gate live, it interrupts every merchant on their next dashboard load.
      It also **detects a body edited WITHOUT a version bump** by comparing the
      checksum — otherwise that edit silently does nothing and whoever made it
      believes the policy changed. (This is why `PublishedDoc` carries
      `checksum`.)
    - **THE RE-ACCEPTANCE GATE LIVES IN THE DASHBOARD LAYOUT, NOT `proxy.ts`.**
      The proxy reads its claims straight from the verified session cookie and
      does no DB query at all — that is its design — and "which documents has
      this user not accepted?" cannot be answered from a cookie. Claims can't
      carry it either: a claim set server-side doesn't reach an EXISTING session
      until the cookie is re-minted, which is precisely the population a v2 must
      reach. So the layout, which already resolves the viewer from the database,
      calls `outstandingDocs(ctx.userId)` and redirects to
      **`/auth/policy-update`** — under `/auth` because a route inside
      `/dashboard` would be wrapped by the same layout and redirect to itself
      forever, and because that is where the analogous `force_password_reset`
      screen already lives. The gate sits AFTER the outage and no-access
      branches: an unreachable database must never present as a consent demand.
      `getSignupDocsCached` (60s, tag `LEGAL_TAG`, busted on publish) keeps it
      to ONE indexed query per dashboard load; the consent WRITE path stays
      uncached, because recording an acceptance against a superseded version is
      the exact failure this feature exists to prevent.
      **`unstable_cache` THROWS ("Invariant: incrementalCache missing") when
      there is no render scope** — a server action, a route handler, a script.
      `outstandingDocs` is called from the layout (has one) AND from
      `acceptUpdatedPolicies` (does not), so the cached read is wrapped in a
      try/catch that falls through to the uncached query. The cache is an
      OPTIMISATION, never an input to correctness. Unguarded, the accept action
      rejected and the screen hung on "Saving…" forever — which is also why the
      client wraps the action in try/catch: **a thrown action inside
      `startTransition` leaves `pending` true permanently and surfaces
      nothing.** Both are regression-tested.
    - **THE GATE CATCHES INVITED STAFF TOO**, not just owners — they reach the
      dashboard through `/auth/set-password`, never the signup wizard, so they
      had agreed to nothing at all. The screen has a **"Sign out instead"**
      escape: someone who won't agree must be able to leave rather than be
      stuck on a screen with one button. And `acceptUpdatedPolicies` re-derives
      what is outstanding and VERIFIES the write stuck — `recordSignupConsent`
      swallows its errors by design, so without the re-check a failure would
      bounce the merchant back to the gate with no explanation.
    - **A STORE'S OWN POLICIES ARE ORDINARY PAGES.** Settings → Policies
      (`/dashboard/settings/policies`) edits Terms, Refund, Shipping and
      Privacy as `store_pages` rows at the slugs the footer ALREADY links to —
      so writing one fixes the dead link rather than adding a second address
      for the same document. The registry is `lib/legal/store-policies.ts`.
      Deliberately NOT the versioned/checksummed/immutable machinery of
      `legal_documents`: that exists so you can prove what a merchant agreed to
      years later, whereas a shop owner should be able to reword their returns
      policy on a Tuesday without a release process. Saving PUBLISHES — a
      draft-only refund policy is a broken link and an unreadable consent box —
      and emptying one unpublishes rather than leaving a blank page live.
      The editor is a plain TEXTAREA (`lib/legal/policy-text.ts`, pure +
      tested): merchants write prose, `plainToHtml` escapes it into `<p>`
      blocks. **`htmlToPlain` returns null for anything richer than paragraphs**
      and the card sends them to the builder instead — the same page can be
      edited there, and loading headings or lists into a textarea would destroy
      them on the next save. The prompts are PROMPTS, never pre-written prose:
      a generated policy nobody read looks authoritative and says things the
      merchant never agreed to.
    - **SHOPPER CONSENT: SIGNUP AND CHECKOUT.** The box is written server-side
      at the two moments that matter — `upsertCustomerProfile` on a genuine
      first insert (the same `xmax = 0` signal the signup event uses) and
      `placeOrder` AFTER the order is safely persisted (the shopper agreed by
      placing it; a consent write that could roll back a paid order would be
      the tail wagging the dog). Checkout names only Terms + Refund
      (`atCheckout` in the registry) — the privacy policy in a sentence about
      paying is noise. `recordStorePolicyConsent` re-reads the live text and
      HASHES it; the client never says which policy or which wording it agreed
      to. **The box renders only when the store has published something**: one
      naming documents nobody can read would manufacture a record of agreement
      to a blank page, so `PolicyConsent` returns null and the caller must not
      gate its button on a box that isn't there.
    - **AN ACCEPTANCE IS ANCHORED TO EXACTLY ONE THING**
      (`supabase/legal_02_store_consent.sql`): a platform `document_id`
      (immutable, versioned) or a `policy_slug` + `policy_checksum`, enforced by
      a CHECK — a row anchored to nothing records agreement to something
      unspecified, which is worth less than no row. The checksum, not a
      snapshot: 64 bytes answers "has this text changed since they agreed?",
      and if it hasn't, the live page IS the evidence. Store-policy rows get
      their OWN unique index `(user_id, store_id, policy_slug)` — the old
      `(user_id, document_id)` key silently stops working when document_id is
      NULL — and the append-only trigger gains one narrow exception so
      re-accepting a reworded policy refreshes the checksum instead of throwing.
      Identity (user/store/policy/actor) still can't change, and platform
      acceptances remain fully immutable.
    - **NOT YET BUILT:** consent at sign-in, an operator UI to publish v2 (the
      script is the tool today), and seeding starter policy pages at signup —
      until that lands, a new store's footer links to policy pages that do not
      exist yet.

## 6. Commands

```bash
npm run dev         # next dev --turbopack (test stores via {slug}.localhost:3000)
npm run dev:all     # ↑ dev + the Cloud SQL Auth Proxy together (concurrently) — one command
npm run db:proxy    # just the Cloud SQL Auth Proxy → staging DB on localhost:6543 (needs
                    #   `gcloud auth application-default login` once for ADC). Points at the
                    #   `storemink-prod-db` INSTANCE; local dev uses its `storemink_staging`
                    #   DATABASE (set DB_NAME=storemink_staging in .env — staging & prod are
                    #   two databases in one instance, see §7). Must be running (else
                    #   lookupStoreByHost → ECONNREFUSED/ECONNRESET). Runs with
                    #   `--run-connection-test` so an expired/reauth-needed ADC token kills the
                    #   proxy at startup (dev:all then `--kill-others-on-fail`s the dev server)
                    #   instead of listening and RESETTING every query — a silent proxy makes
                    #   the dashboard render "No access to this dashboard".
npm run build       # production build
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run test        # vitest run --coverage
npm run test:watch  # vitest watch
npm run format      # prettier --write
```

## 7. Environments / external services

- **Supabase** — **fully out of the codebase.** Postgres → Cloud SQL (Phase 5),
  Auth → Identity Platform (Phase 6), Storage `media` bucket → GCS (Phase 3, now
  GCS-only — the Supabase Storage fallback + `@supabase/*` deps + `lib/supabase/`
  were removed; uploads require `GCS_BUCKET`). No `SUPABASE_*` env is read anymore.
  Existing Supabase-hosted media URLs still serve (and are proxied by
  `api/og-image`) until the prod media backfill + Supabase-project deletion (see
  the cutover checklist). App-side password floor is 8 chars
  (`app/platform/signup/page.tsx`).
- **Identity Platform (Firebase Auth) — the auth provider (GCP Phase 6).** All
  auth goes through `lib/auth/*` (see §4). **ENV:**
  - **One Identity Platform project PER ENVIRONMENT, paired with that env's Cloud
    SQL DATABASE.** Staging and prod now share ONE Cloud SQL INSTANCE
    (`storemink-prod-db`) as two databases — `storemink_staging` (staging + local
    dev) and `storemink` (prod); there is no separate staging instance anymore.
    The project↔database pairing is still mandatory because `admins.id`/`users.id`
    in Cloud SQL ARE the Firebase uid — crossing them (e.g. the staging database +
    the prod project) makes `getServerUser` return uids with no matching row →
    everything reads as signed-out. So the `NEXT_PUBLIC_FIREBASE_*` (and server SA)
    values DIFFER per environment:
    | env | Cloud SQL database (`DB_NAME`, all in `storemink-prod-db`) | Firebase/IP project | keys |
    | ---------- | -------------------- | ------------------- | ----------- |
    | local dev | `storemink_staging` | **staging** project | staging |
    | staging | `storemink_staging` | **staging** project | staging |
    | production | `storemink` | **prod** project | prod |
    Local dev uses the STAGING project (its database holds staging-project uids).
    The web `apiKey` is NOT a secret — it's a public project id; separate projects
    are about ISOLATING test users/SMS from prod, not secrecy. The database is
    selected purely by `DB_NAME` (`lib/db/client.ts`), so a wrong `DB_NAME` on a
    shared instance is the one thing that would cross staging and prod — the
    deploy config guards this (see `docs/gcp-ci-cd.md`), and hardening to a
    restricted `app_staging` role is a documented pre-launch step.
  - **Server (Admin SDK)**: `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` +
    `FIREBASE_PRIVATE_KEY` (service account; `\n`-escaped key), OR Application
    Default Credentials (automatic on Cloud Run; locally set
    `GOOGLE_APPLICATION_CREDENTIALS` to a SA key file, or `GCP_PROJECT_ID` — either
    triggers the ADC path). `FIREBASE_API_KEY` (web API key) is ALSO read
    server-side for the change-password re-verify (the REST
    `accounts:signInWithPassword` call — the Admin SDK can't check a password).
  - **Client (Web SDK)**: `NEXT_PUBLIC_FIREBASE_API_KEY`, `_AUTH_DOMAIN`,
    `_PROJECT_ID`, `_STORAGE_BUCKET`, `_MESSAGING_SENDER_ID`, `_APP_ID` (the public
    Firebase web config — not secret).
  - **Console setup (Identity Platform, per project — NOT in code):**
    - **Providers**: enable **Email/Password**, **Email link (passwordless)** (the
      operator login uses it), **Google**, and **Phone**. Phone requires
      **reCAPTCHA** (the app uses an invisible `RecaptchaVerifier`) — this also
      covers the anti-abuse / SMS-pumping hardening (the old Supabase CAPTCHA item).
    - **Google**: a Google Cloud OAuth **Web** client; put its client id/secret on
      the Google provider. Sign-in uses `signInWithPopup` (no callback route), so
      no app redirect URIs go into Google — only Firebase's own auth handler does.
    - **Authorized domains** (Authentication → Settings): list every host the app
      runs on so popup + email-link work — `localhost`, `storemink.com`,
      `*.storemink.com` (+ the staging equivalents). Unlike Supabase there is NO
      per-path Redirect-URL matrix; popup / email-link just need the domain
      authorized. Cross-subdomain session cookies still span `.storemink.com`
      (set by `/api/auth/session`), so the signup→dashboard handoff works across
      subdomains on real domains (flaky on `localhost`, as before).
  - **User import**: bring existing Supabase users into Identity Platform
    preserving the same **uid** — `admin.auth().importUsers()` with the
    `auth.users` dump (bcrypt hashes carry over → no password resets). uids stay
    identical, so every `admins`/`users` FK + the `app.current_user_id` GUC keep
    working with zero remapping.
- **Vercel**: hosting + cron. Wildcard domain `*.storemink.com` → store subdomains.
- **Resend**: transactional email + custom-domain DNS verification. Delivery
  webhooks post to `/api/webhooks/resend` and need **`RESEND_WEBHOOK_SECRET`**
  (Svix signing secret) plus the endpoint registered in the Resend dashboard,
  subscribed to `email.bounced` + `email.complained` — without it bounces are
  never learned and dead addresses are mailed forever (§22).
- **Google Cloud Storage** (media, GCP migration Phase 3 — `lib/storage/gcs.ts`):
  when **`GCS_BUCKET`** is set, new image/video uploads go to that GCS bucket
  (public, uniform bucket-level access) and public URLs are
  `https://storage.googleapis.com/<bucket>/<path>`. Uploads are **GCS-only** now
  (require `GCS_BUCKET`; no Supabase fallback). Auth via ADC (Cloud Run default
  SA, or local `gcloud auth application-default login`); optional base64 SA JSON
  **`GCP_SA_KEY`** for hosts without ADC (Vercel) — and REQUIRED to sign video
  upload URLs off Cloud Run. Existing Supabase-hosted URLs keep serving; the
  OG-proxy (`api/og-image` SSRF allowlist), its gate (`lib/og-image.ts`) and
  `next.config.ts` image `remotePatterns` still recognise BOTH URL formats so
  legacy media renders until the backfill. Bucket needs CORS (PUT from the app
  origin) for direct video uploads. No bulk migration of existing objects yet (a
  pre-decommission backfill copies old objects + rewrites DB URLs).
- **Gemini / Vertex AI**: AI copy generation (`lib/ai/gemini.ts`, dual backend).
  **Backend precedence: the free Gemini Developer API key wins whenever one is
  set** — so **local + staging set `GEMINI_API_KEY`** (a Google AI Studio key,
  free) and their AI costs nothing; **production omits `GEMINI_API_KEY` and sets
  `GCP_PROJECT_ID`** so `callGemini` routes through **Vertex AI** via Application
  Default Credentials (ADC — no API key; automatic on Cloud Run) at
  **`GCP_LOCATION`** (default `global`). (An env with BOTH set prefers the free
  key.) Same request/response shape both ways; callers see the unchanged
  `{text,error}` contract. Vertex needs `google-auth-library` +
  `roles/aiplatform.user` on the runtime credentials (see
  `docs/gcp-migration-phase5-6.md`).
- **Razorpay** (§18, §16): two SEPARATE credential sets. Per-store BYO gateway
  creds live in the DB (`store_payment_providers`, encrypted with env
  **`PAYMENT_CRED_KEY`** — 32-byte base64; generate with
  `openssl rand -base64 32`). The PLATFORM's own account (AI-credit purchases
  only) is env **`RAZORPAY_KEY_ID`** / **`RAZORPAY_KEY_SECRET`**. Cron routes
  (`/api/cron/*`) require **`CRON_SECRET`** (Vercel Cron sends it as a Bearer
  header).
- **POS** (§22): the `/pos` device + operator cookies are HMAC-signed with env
  **`POS_SESSION_SECRET`** (any high-entropy string; `openssl rand -base64 32`).
  Required for the register to work; when unset, cookie VERIFY returns null
  (never throws) so /pos falls back to the login gate rather than 500ing.
  **That graceful degradation covers VERIFY only — MINTING a cookie cannot
  degrade**, so with the secret absent `authorizeThisDevice` / `pairDevice` /
  `posLoginWithPin` are dead. They now check `posSessionConfigured()` and return
  `POS_SECRET_MISSING_ERROR` instead of throwing a raw 500 (staging ran without
  the secret until 2026-07-27 — it was never added to `cloudbuild.yaml` — and
  every "Authorize this device" click 500'd). `registerDevice` also SIGNS BEFORE
  IT INSERTS: insert-then-sign left an orphan `pos_devices` row per failure, and
  those rows count against `PLAN_LIMITS.posDevicesPerLocation`, so a broken
  deployment eventually reported a bogus "already has 5 authorized devices".
  Deploy wiring is per-env (`_POS_SESSION_SECRET_SECRET` → the
  `POS_SESSION_SECRET_STAGING`/`_PROD` Secret Manager entries) — see
  `docs/gcp-ci-cd.md`.
- **Google Maps** (signup location step, §19): **`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`**
  — a Maps JavaScript API key from Google Cloud. Needs a billing account with a
  card even to stay inside the free allowance, and the key is public by nature
  (it ships to the browser), so restrict it by HTTP referrer to the app's hosts
  and enable only Maps JavaScript + Geocoding. **Entirely optional at runtime**:
  `app/platform/signup/location-picker.tsx` renders the map only when the key is
  set and falls back to the plain country/city form when it is missing, blocked,
  or rejected — location is a REQUIRED signup step, so the map must never be
  able to stop someone signing up. "Use my current location" is the browser's
  own Geolocation API: free, keyless, and works with the map switched off.
- **Search-engine indexing** (`lib/seo/search-engines.ts`; full runbook in
  `docs/seo-indexing.md`): only the **production apex** is indexable —
  `SEARCH_INDEXABLE` in `lib/store/host.ts` (`ROOT_DOMAIN === "storemink.com" &&
NEXT_PUBLIC_NOINDEX !== "1"`) is the single gate for `robots.ts` (non-prod →
  `Disallow: /`), `sitemap.ts` (non-prod → empty), AND both notify channels, so
  staging/previews are auto-`noindex`d and never ping (no per-deploy flag; staging
  runs as `NODE_ENV=production` on Cloud Run, so the old NODE*ENV guard was
  insufficient). IndexNow needs no account (public key file `public/<key>.txt`;
  `INDEXNOW_KEY` overrides it, `INDEXNOW_FORCE=1` pings off-prod). Google Search
  Console submission is DORMANT until `GOOGLE_SEARCH_CONSOLE_PROPERTY` (e.g.
  `sc-domain:storemink.com`) is set — auth is then the **runtime service account
  via ADC** (nothing to store; `cloudbuild.yaml` passes the property, prod trigger
  = `sc-domain:storemink.com`), or an explicit `GOOGLE_SEARCH_CONSOLE_CREDENTIALS`
  key JSON for non-GCP hosts. One-time human setup: verify `storemink.com` as a
  Search Console \_Domain property* (covers all `*.storemink.com`) and add the
  `storemink-run@…` SA as a property user. Custom-domain stores fall outside the
  property, so their Google submit no-ops (IndexNow + on-page canonicals cover them).
  **⚠ A STORE'S PUBLIC ORIGIN IS `storeOrigin(store)` (`lib/site.ts`) — NEVER
  `custom_domain ?? subdomain`.** The custom domain counts only once
  `settings.custom_domain_verified === true`, which is the same rule
  `lookupStoreByHost` (`lib/store/resolve.ts`) applies when deciding whether to
  SERVE on that domain — and the two silently disagreed. `saveCustomDomain`
  writes `custom_domain` while CLEARING the verified flag, so every merchant
  passes through a state where the store is served on its subdomain while every
  canonical, `og:url`, robots `Host:`, sitemap `<loc>` and IndexNow ping pointed
  at a domain we don't serve. Google follows the canonical, fails to fetch it,
  and drops the working subdomain URLs as "Alternate page with proper canonical
  tag" — total silent deindexing of a tenant. `getStoreUrl()` (and therefore the
  storefront `metadataBase`) routes through it; regression-tested in
  `lib/site.test.ts`. Related: a store-SHAPED host that resolves to NO store
  (unclaimed subdomain, suspended store, unseeded demo) now returns
  `Disallow: /` + an empty sitemap instead of falling through to the platform's,
  which had every parked subdomain advertising storemink.com's URLs as its own.
  **`app/sitemap.ts` emits NO fabricated `lastmod`** — a request-time value makes
  Google discard lastmod site-wide, including the values that are accurate — so
  each URL derives it from a real content timestamp or omits it, guarded by
  `app/sitemap.test.ts`. Products use **`products.content_updated_at`**
  (`supabase/seo_01_product_content_timestamp.sql`), a trigger-maintained column
  that moves only when a visitor-visible field changes: `updated_at` is bumped by
  `_recompute_stock_aggregate` on every sale, so it would claim a content change
  per purchase. Pages use `published_at`, not `updated_at`, which a BEFORE-UPDATE
  trigger + `savePageDraft`'s autosave advance while an UNPUBLISHED draft is
  edited.
- **A NEW STORE IS NOT INDEXABLE UNTIL ITS OWNER PUBLISHES SOMETHING**
  (`lib/store/launch.ts`). At creation a store is pure theme seed — the same
  homepage, ~17 content pages and sample catalogue as every other store on that
  template — and `createStore` used to submit exactly that to Google + IndexNow
  the moment it existed. Mass-submitting near-duplicate placeholder stores spends
  the whole `*.storemink.com` domain's reputation, and `robots.txt` cannot undo
  it (Disallow stops crawling, not indexing). `stores.settings.launched` gates
  `robots.ts` + `sitemap.ts`; `markStoreLaunched()` fires from `publishPage` and
  the product publish path, which is now also where the one-time
  `submitSitemapToGoogle` happens. **Absence of the flag means LAUNCHED** —
  pre-existing stores have no key and treating them as unlaunched would deindex
  live shops; `createStore` writes `launched: false` explicitly. Demo stores
  (`settings.demo`) stay permanently out. Theme SAMPLE products now seed as
  **drafts** (`applyTheme`'s `publishSampleProducts`, true only for demo stores):
  published, every store on a theme served the same product pages whose own copy
  says "replace it with your own".
  Full audit, fixes and the re-index cadence: `docs/seo-action-plan.md`.
- **StoreMink's own brand identity for schema lives in
  `lib/seo/brand-identity.ts`** — one Organization node (`sameAs` for the
  LinkedIn/YouTube/Instagram profiles, `contactPoint`, `address`) emitted from
  BOTH the apex and `help.storemink.com` under a single `@id`, plus the matching
  visible footer links. Two hand-written copies would drift, and a contradictory
  entity is worse than an absent one. **Only public profile URLs belong in
  `sameAs`** — never a `/admin/` dashboard URL.

## 8. Multi-tenant rollout status (as of 2026-07)

Phases 1–3c complete: schema + RLS + store resolution + signup journey +
per-store branding + platform admin console are live on branch `multi-tenant`.
Legacy WholeSip fallback remains until all traffic moves to real store hosts.

## 9. Product direction (owner's vision — keep in mind for every design decision)

- **storemink.com is the soul.** `storemink.com/dashboard` (platform operator
  console) sees _everything_: all features plus platform-only controls — Stores
  management (suspend/unsuspend, plan upgrade/downgrade), operators, etc.
  `{slug}.storemink.com/dashboard` sees only that store's own features/settings.
- **Everything must be settings-based.** Feature behavior is configured per
  store, not hardcoded. Canonical example — blogs: a store can toggle (a) whether
  customers may submit blogs at all, and (b) whether submissions need admin
  approval or publish directly, and it owns its blog categories/tags outright
  (convention #10). Every feature should be built with this kind of per-store
  configurability from the start. **The framework for this now exists**
  (`lib/settings/`, rendered on each feature's own settings page — blogs →
  `/dashboard/blogs/settings`; see convention #9), and blogs is the first
  consumer.
- **The website is dashboard-editable** (convention #11): the homepage, the
  former hardcoded static pages, and merchant-built custom pages are ALL per-store
  data (sections + custom HTML/CSS/JS) edited in the Website Builder
  (`/dashboard/builder`) with live preview and a draft → publish workflow;
  header/footer nav is per-store too (`/dashboard/navigation`). Merchant JS is
  sandbox-isolated. Phase 4 completed this fold-in — only genuinely interactive
  routes (shop, cart, blogs, enquiries, profile) remain in code.
- **Templates**: at signup the merchant picks a storefront template (filter by
  business category + free/paid, preview, plan-gated — e.g. "For STARTER and
  above"). Multiple visual templates are a planned core feature; today there is
  one storefront with per-store branding.
- **Checkout (COD, built)**: a signed-in shopper places a Cash-on-Delivery order
  from `/checkout` → `placeOrder` (`app/actions/checkout-actions.ts`), stored in
  `orders`/`order_items` (`supabase/orders_table.sql`) and listed at
  `/dashboard/orders`. See convention #12 for the checkout security model.
- **Deliberately later phases** (not built yet, by choice): online **payments**
  (BYO gateway — merchant connects own Razorpay/Cashfree; checkout is COD-only
  for now), merchant subscription billing for StoreMink plans.
- **WholeSip cleanup is nearly done**: the product started as the WholeSip site
  and was converted into StoreMink. The hardcoded homepage/hero + static pages
  are migrated (Phase 4), and the `--wholesip-*` CSS tokens (→ `--sm-*`) and
  `WHOLESIP_STORE_ID` (→ `FALLBACK_STORE_ID`) are renamed. What remains is only
  the repo/dir name `wholesip`, the `brand/` dir, and the fallback store's own
  DB identity (a real store row named "WholeSip") — bigger/data-level, not code.
