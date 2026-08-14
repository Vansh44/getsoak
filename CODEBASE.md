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
| Deploy    | **Google Cloud Run** via branch-specific Cloud Build triggers (`staging` → `storemink-web`, `main` → `storemink-web-prod`; Dockerfile + `cloudbuild.yaml`). CI on GitHub Actions (`.github/workflows/ci.yml`: lint → typecheck → test → test:shuffle → prettier → build). Database DDL is a separate, checksummed release gate (`npm run db:migrate`; see `drizzle/manual/README.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 3. Multi-tenancy architecture (the core concept)

Every request belongs to exactly one store, resolved from the **Host header**.

### Host routing — `proxy.ts` (edge middleware, runs on everything except `_next` statics & `/api`)

| Host                                                         | Behavior                                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `help.storemink.com` / `help.localhost`                      | Rewritten to `/help/*`                                                                                            |
| `pos.storemink.com` / `pos.localhost`                        | **Public POS product site** — rewritten to `/platform/pos/*`; reserved from merchant slugs                        |
| `themes.storemink.com` / `themes.localhost`                  | **Public theme catalog** — rewritten to `/themes/*`; reserved from merchant slugs                                 |
| `storemink.com`, `www.`, `app.`, `localhost`, `*.vercel.app` | **Platform** — all paths rewritten into `/platform/*` (landing, signup, platform login, platform admin dashboard) |
| `{slug}.storemink.com`, `{slug}.localhost`                   | **Store subdomain** — storefront + `/dashboard` + `/auth` served directly                                         |
| Anything else                                                | **Custom domain** — must have `settings.custom_domain_verified === true` to resolve                               |

`proxy.ts` also gates auth: `/dashboard` requires a valid **Firebase session
cookie** (`sm_session`; redirect to `/auth/login`), enforces
`force_password_reset` → `/auth/set-password`, and sends POS staff
(`role === "cashier" | "manager"`) to `/pos`. The `role`/`force_password_reset`
custom claims + the uid are read straight from the verified session cookie (no
DB query). Next.js 16 `proxy.ts` runs on the **Node runtime** by default, so it
verifies the cookie with `firebase-admin` directly (no edge/`jose` workaround).
Storefront paths skip the session check entirely (anonymous + cache-friendly).
Paths with a file extension (public/ assets like `/themes/...webp`) pass
through untouched on EVERY host — the platform/help rewrites would otherwise
404 them.

**★★ IT NO LONGER RESTRICTS `/dashboard/users` + `/dashboard/media` TO
`superadmin`, and that gate was breaking Customers for every store owner.**
It compared the SESSION COOKIE's `role` claim — but `createStore` writes
`role: "superadmin"` to the `admins` TABLE and never calls `setUserClaims`, so a
wizard-created owner has no role claim at all. The dashboard rendered their
"Superadmin" badge and the Customers link from the DATABASE, then the proxy
bounced the click back to `/dashboard`: a visible link that silently refused to
open. The gate was also STALE — `/dashboard/users` was repurposed from staff
management into the SHOPPER list, so locking it to the owner contradicted the
`users` section existing with view/manage actions for delegation — and
REDUNDANT, since both pages already call `requireSectionAccess()`. Authorisation
now happens in one place, against the database.
**⚠ Note the asymmetry that hid this for so long:** every other claim check in
`proxy.ts` is an ALLOWLIST (`role === "cashier"` → send to `/pos`), which passes
safely when the claim is absent. This was the only DENYLIST, so it was the only
one that failed closed on a missing claim. Don't reintroduce that shape; gate on
permission sections, which read the database. Pinned by `proxy.test.ts`.

### Tenant resolution — `lib/store/`

- `host.ts` — pure host classification (`parseHost`, `isPlatformHost`, `isHelpHost`, `isPosHost`, `isThemesHost`, `cookieDomainForHost`). No Node imports; safe on edge. `ROOT_DOMAIN` from `NEXT_PUBLIC_ROOT_DOMAIN` (default `storemink.com`). Cookies are scoped to `.storemink.com` so a session spans platform + all store subdomains.
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
├── vercel.json                # INERT schedule record (prod = Cloud Scheduler):
│                              # send-emails, plan-expiry, expire-pending-payments,
│                              # daily seo-refresh and prune-logs (docs/cron-jobs.md)
├── vitest.config.ts / vitest.setup.ts / vitest.server-only-stub.ts
├── eslint.config.mjs / postcss.config.mjs / tsconfig.json / components.json
│
├── app/
│   ├── layout.tsx             # Root layout
│   ├── globals.css
│   ├── loading.tsx
│   ├── robots.ts / sitemap.ts # Host-aware discovery for platform, help, POS,
│   │                          # themes, and eligible merchant stores
│   │
│   ├── (storefront)/          # ★ THE STORE WEBSITE (served on store hosts)
│   │   ├── layout.tsx         # Storefront shell: Header/Footer, BrandProvider, Auth+Cart+
│   │   │                      # delivery-location providers
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
│   │   │   │                  #   invoice link) + capability-aware Online /
│   │   │   │                  #   In store tabs. `order-history.tsx` groups
│   │   │   │                  #   StoreMink POS sales and pickup journeys; the
│   │   │   │                  #   split stays hidden for delivery-only stores.
│   │   │   │                  #   Double-locked: withUser (RLS
│   │   │   │                  #   customer_id = auth.uid()) AND host store id
│   │   │   ├── notifications/ #   ★ the SHOPPER's notification centre (§22) —
│   │   │   │                  #   the customer rows the fan-out has always
│   │   │   │                  #   written, finally rendered
│   │   │   ├── profile/       #   customer profile (personal info + address-book
│   │   │   │                  #   card + ★ credit-balance.tsx, the store-credit
│   │   │   │                  #   card (§29 — hides itself at zero with no
│   │   │   │                  #   history) + quick links to orders/notifications)
│   │   │   └── [pageSlug]/    #   ★ ALL content pages from store_pages (see §11): merchant
│   │   │                      #   custom pages AND the former hardcoded static pages
│   │   │                      #   (our-story, faqs, …) — retired in Phase 4b, now editable
│   │   │                      #   rows. Published path (cached) + ?preview=1 draft path
│   │   │                      #   (uncached, admin-gated). Only INTERACTIVE routes above
│   │   │                      #   stay in code + RESERVED (registry.ts + drift test).
│   │   └── components/
│   │       ├── auth/          # AuthModal + AuthProvider (customer auth context).
│   │       │                  # ★ `loading` means "we don't yet know who this
│   │       │                  # is", so it clears only once the customer row has
│   │       │                  # LANDED — not when Firebase answers. Clearing it
│   │       │                  # early left a window of {loading:false, user:set,
│   │       │                  # customer:null}, which every consumer reads as
│   │       │                  # signed OUT: it popped the auth modal over a
│   │       │                  # signed-in checkout on every refresh (nothing
│   │       │                  # closes it once the row arrives) and flashed
│   │       │                  # "sign in to review" on product pages.
│   │       │                  # ★ It also SELF-HEALS a lapsed session cookie:
│   │       │                  # `sm_session` is 14 days while the client SDK's
│   │       │                  # persistence is indefinite, so a shopper back
│   │       │                  # after a fortnight has a browser that is signed
│   │       │                  # in and a server that disagrees. On `no-session`
│   │       │                  # it re-mints via establishSession(forceRefresh)
│   │       │                  # and retries ONCE. That is why
│   │       │                  # getMyCustomerSession returns a STATUS, not a
│   │       │                  # bare null — `no-row` (a store admin on their own
│   │       │                  # storefront: valid cookie, no `users` row) and
│   │       │                  # `unavailable` (a DB blip) must NOT re-mint, or
│   │       │                  # every page load pays a wasted round-trip.
│   │       │                  # getMyCustomer() still returns just the row.
│   │       │                  # ★ Anonymous storefront requests do NOT start
│   │       │                  # Firebase Auth: the server layout passes whether
│   │       │                  # `sm_session` exists, so returning shoppers restore
│   │       │                  # immediately while anonymous visitors dynamically
│   │       │                  # import the Web SDK only when account UI opens.
│   │       ├── cart/          # CartProvider, CartDrawer, CouponField
│   │       ├── delivery/      # ★ remembered/default/current delivery location UI +
│   │       │                  # server-priced PDP PIN availability/charge/ETA (§35)
│   │       ├── header/ footer/  # nav from store_menus via MenuProvider (§11 menu builder)
│   │       ├── homepage/      # Shared per-section renderer (featured products,
│   │       │                  # blog carousel, promo banner, shop-by-category…)
│   │       ├── sections/      # ★ Generalized section renderer shared by homepage + pages:
│   │       │                  # page-section-renderer, custom-code-frame (sandboxed iframe),
│   │       │                  # custom-code-section, rich-text-section, hero-section,
│   │       │                  # usp-bar-section, ticker-section, tile-grid-section,
│   │       │                  # faq-accordion-section, media-text-section,
│   │       │                  # gallery-section, testimonials-section, video-section/player,
│   │       │                  # newsletter-section,
│   │       │                  # preview-bridge, draft-canvas (client-side instant
│   │       │                  # builder preview, §11), builder-overlay
│   │       ├── brand-provider.tsx   # Injects per-store branding CSS vars
│   │       ├── newsletter-form.tsx  # Consent-aware footer/section signup form
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
│   │   ├── channels/          # ★ Channels (§18/§35): connect the store's OWN Razorpay
│   │   │                      # and Shiprocket accounts; pause/resume, sync warehouse
│   │   │                      # pickup mappings and configure the tracking webhook
│   │   ├── ai/                # ★ AI usage (§16): monthly bar + credit balance +
│   │   │                      # ledger + buy-credit packs (platform Razorpay)
│   │   ├── orders/[id]/invoice/  # ★ printable invoice for one order (§17)
│   │   ├── activity/          # ★ THE LOGS HUB (§33). layout.tsx + logs-rail.tsx
│   │   │                      # give every log one left rail (log-types.ts is the
│   │   │                      # registry); the sidebar has NO children anymore, or
│   │   │                      # there'd be two navigations for the same five pages.
│   │   │                      # page.tsx = activity_events audit feed (§22, day-
│   │   │                      # grouped); email-logs/ = what was SENT (§24);
│   │   │                      # ★ import-export/ = CSV job history + [jobId] per-ROW
│   │   │                      # error log (§31), split into Import/Export by ?kind=;
│   │   │                      # ★ failures/ = everything that DIDN'T work, read
│   │   │                      # across the other tables (§33). FIVE logs, ONE
│   │   │                      # `activity` permission
│   │   └── settings/          # account/ + domain/ + shipping/ (checkout rate policy) + ★ notifications/ (§22 CONSOLE:
│   │                          # list → [key] detail with General + per-channel
│   │                          # tabs; me/ = personal opt-outs);
│   │                          # feature toggles live on their feature's own page
│   │                          # (e.g. blogs → blogs/settings — see convention #9)
│   │
│   ├── platform/              # ★ STOREMINK PLATFORM (served on storemink.com via rewrite)
│   │   ├── page.tsx           # Marketing landing page
│   │   ├── signup/            # ★ Store creation wizard (see §19): Shopify-style
│   │   │                      # step order — email → password (+ Continue with
│   │   │                      # Google) → email OTP → phone OTP → name → store →
│   │   │                      # location → theme → plan (Razorpay autopay).
│   │   │                      # Firebase: Google via signInWithPopup (no callback
│   │   │                      # route), phone via signInWithPhoneNumber; password
│   │   │                      # email ownership via signup-email-otp action.
│   │   ├── login/             # Platform-operator login — six-digit email OTP
│   │   └── dashboard/         # Platform-admin control centre: live health metrics,
│   │                          # stores-console, operators-console, email-logs/
│   │                          # (platform mail incl. signup/operator OTPs)
│   │                          # + ★ failures/ = the SAME feed as a store's, scoped
│   │                          # { kind: "platform" } across every store (§33)
│   │                          # (guarded by supabase/multitenant_07_platform_admins.sql)
│   │                          # (the OAuth callback route was removed in Phase 6 —
│   │                          # Google now uses signInWithPopup)
│   │
│   ├── api/auth/              # ★ Phase 6 session bridge: session/route.ts (ID token →
│   │                          # httpOnly Firebase session cookie), signout/route.ts (clear it)
│   ├── auth/                  # Store-host auth: login (email+pw + Google popup),
│   │                          # forgot/set/update-password (Firebase; callback route removed)
│   ├── help/                  # Help centre (served at help.storemink.com)
│   ├── themes/                # ★ Public metadata-driven theme catalog served at
│   │                          # themes.storemink.com; own canonical/OG/CSS, industry
│   │                          # filters, truthful demo/release/plan state
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
│   │   │                      # redirect / refreshed tab). Tested across slug,
│   │   │                      # identity, location, rollback and consent gates.
│   │   ├── signup-email-otp.ts # Authenticated, rate-limited 6-digit email proof;
│   │   │                      # signed httpOnly hash cookie, capped attempts,
│   │   │                      # marks Firebase emailVerified only on success
│   │   ├── store-branding.ts  # Per-store branding updates
│   │   ├── store-settings.ts  # Read/save per-store feature settings (see lib/settings)
│   │   ├── blog-taxonomy-actions.ts  # Per-store blog categories/tags CRUD (+ propagation into blogs)
│   │   ├── subscribe-actions.ts # ★ §34 the NEW subscribe path: startSubscribe /
│   │                      # confirmSubscribe. Runs ALONGSIDE the old
│   │                      # subscription-actions.ts until the cutover, and
│   │                      # REFUSES when the old system already has a live
│   │                      # mandate — failing CLOSED on a read error, because
│   │                      # billing one store from two systems has no single
│   │                      # place to stop it. ⚠ NOT the same file as
│   │                      # billing-actions.ts (§17 tax classes).
│   ├── billing-actions.ts # ★ Invoices & tax (§17): tax-class CRUD + save billing/
│   │   │                      # invoice settings. Gated on `billing`, revalidates TAGS.billing.
│   │   ├── store-domain.ts    # Custom domain connect (§30) — the GATE only; the
│   │                          # work is lib/domains/reconcile.ts so the cron runs
│   │                          # identical logic. Shows zone-relative DNS names (so
│   │                          # registrar UIs do not duplicate the domain), checks
│   │                          # the challenge CNAME, and requires the LB to be the
│   │                          # domain's only A-record destination before serving;
│   │                          # then starts automatic Google META verification /
│   │                          # Search Console sitemap registration (retry by cron).
│   │                          # Tested across permissions, transitions, deprovisioning
│   │                          # order and failure containment.
│   │   ├── page-actions.ts    # ★ Custom-page CRUD + draft/publish (see §11): createPage/
│   │   │                      # updatePageMeta/savePageDraft/publishPage/unpublishPage/
│   │   │                      # deletePage/ensureHomepage, gated builder, service-role
│   │   ├── menu-actions.ts    # ★ Per-store nav read/save (see §11 menu builder, store_menus)
│   │   ├── newsletter-actions.ts # ★ Host-scoped, rate-limited mailing-list upsert (§11)
│   │   ├── checkout-actions.ts # ★ placeOrder (COD + razorpay — §12/§18): re-prices from
│   │   │                      # DB, store-scoped by host, re-validates coupon, rate-limited,
│   │   │                      # SERVICE-ROLE writes (no customer INSERT policy — convention
│   │   │                      # #12); getCheckoutConfig + confirmOnlinePayment (HMAC) +
│   │   │                      # reconcileMyOrderPayment. Tested.
│   │   ├── payment-provider-actions.ts # ★ Channels (§18): get/save/enable/disconnect the
│   │   │                      # store's BYO Razorpay creds (verified, encrypted, plan-gated). Tested.
│   │   ├── logistics-provider-actions.ts # ★ Channels (§35): verify/encrypt BYO Shiprocket
│   │   │                      # credentials, rotate webhook tokens, sync warehouses
│   │   │                      # and expose only safe connection state. Tested across
│   │   │                      # permissions, validation, rotation and location mapping.
│   │   ├── shipping-actions.ts # ★ §35 Shipping settings + authoritative checkout and
│   │   │                      # public PDP PIN quotes (stock/origin/parcel/COD aware). Tested.
│   │   ├── shipment-actions.ts # ★ §35 pack/book/AWB/label/pickup/manifest/tracking/NDR;
│   │   │                      # staged idempotency plus a provider-independent manual fallback.
│   │   │                      # Tested across leases, resumable stages and terminal-state gates.
│   │   ├── ai-credit-actions.ts # ★ AI credits (§16): usage-page data + reconcile,
│   │   │                      # startCreditPurchase/confirmCreditPurchase (platform Razorpay).
│   │   ├── return-actions.ts  # ★ §28 request flow: getReturnableOrder/requestReturn/
│   │   │                      # cancelMyReturn (shopper) + getReturnQueue/reviewReturn/
│   │   │                      # receiveReturn (merchant). Never moves money.
│   │   ├── refund-actions.ts  # ★ Money OUT (§26): refundOrder (pending-row-FIRST
│   │   │                      # idempotency, FOR UPDATE cap, unknown ≠ failure) +
│   │   │                      # getOrderRefundState. Gated getManagerIdentity("orders").
│   │   ├── order-actions.ts   # ★ getOrders (paginated) + updateOrderStatus (allowlisted
│   │   │                      # status/payment_status, store-scoped). Tested.
│   │   ├── import-export-actions.ts # ★ §31 CSV import trust boundary: previewImport
│   │   │                      # (which match keys exist — all the browser can't know),
│   │   │                      # startImport → importChunk × N → finishImport, plus the
│   │   │                      # log readers. Chunked (body cap + request timeout),
│   │   │                      # re-parses every chunk server-side, row-atomic. Gated on
│   │   │                      # the RESOURCE's own section, never a key of its own. Tested.
│   │   ├── customer-order-actions.ts # ★ A shopper's OWN orders (§22):
│   │   │                      # getMyOrders/getMyOrder + physical-store channel
│   │   │                      # capability resolution. withUser + host store —
│   │   │                      # RLS alone would show an order placed on a
│   │   │                      # DIFFERENT store while browsing this one.
│   │   │                      # ★ cancelMyOrder (§26): ONE button, TWO outcomes —
│   │   │                      # cancels outright while stoppable, otherwise emits
│   │   │                      # order.cancellation_requested. Never moves money.
│   │   ├── customer-notification-actions.ts # ★ The shopper's notification
│   │   │                      # centre (§22): list/unread/mark-read over the
│   │   │                      # same notifications table the staff bell uses,
│   │   │                      # scoped to recipient_type 'customer' + host store
│   │   ├── customer-credit-actions.ts # ★ The shopper's OWN store credit (§29):
│   │   │                      # getMyCredit = balance + recent movements, session
│   │   │                      # uid + host store, both server-derived. Exposes
│   │   │                      # NEITHER the ledger's `ref` NOR its `note` (both
│   │   │                      # internal); customer wording derives from `kind`
│   │   ├── notification-actions.ts # ★ Notifications (§22): inbox + unread count
│   │   │                      # (the bell polls it), mark read/all-read/archive,
│   │   │                      # activity feed, preference get/save and delivery retry.
│   │   │                      # Tested across recipient/host scoping, permissions,
│   │   │                      # validation, writes, email safety and dead-letter recovery.
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
│       ├── webhooks/logistics/[connectionId]/ # ★ §35 authenticated carrier events;
│       │                      # provider-neutral URL accepted by Shiprocket; duplicate and
│       │                      # out-of-order safe, raw payload service-only
│       ├── cron/send-emails/  # Daily worker for BOTH outbound queues (Vercel
│       │                      # cron): coupon campaigns + notification emails
│       │                      # (§22). Self-chains while either has work left
│       ├── cron/plan-expiry/  # ★ Daily: flips expired timed plans → free (§15)
│       ├── cron/expire-pending-payments/ # ★ Hourly reaper for unpaid razorpay
│       │                      # orders: mark paid if captured, else cancel+restock (§18)
│       ├── cron/seo-refresh/  # ★ Daily Google reconciliation: platform/help/themes
│       │                      # sitemaps + every launched store; custom-domain META
│       │                      # verification/property creation; 503 triggers retries
│       ├── cron/domain-reconcile/ # ★ HOURLY (§30): finishes every custom domain
│       │                      # whose certificate issued after the merchant closed
│       │                      # the tab. Without it a domain only ever goes live if
│       │                      # someone watches the settings page for ~30 minutes.
│       │                      # 200 even while waiting — the usual "failure" is a
│       │                      # merchant who hasn't added their DNS records yet
│       ├── cron/billing/      # ★ §34 the subscription heartbeat, HOURLY. The
│       │                      # three renewal passes in ONE request, in order —
│       │                      # collect (T−4d), evaluate (cycle turn),
│       │                      # downgrade (grace+48h) — because split across
│       │                      # jobs each pass would lag the previous by a full
│       │                      # interval and the 48h buffer would become 48h +
│       │                      # two intervals. Auth FAILS CLOSED (it charges
│       │                      # merchants and removes plans). A declined
│       │                      # payment or a downgrade is 200, not an outage;
│       │                      # only a thrown pass is 503. ⚠ While the Razorpay
│       │                      # charge endpoint is unverified `collectionSkipped`
│       │                      # is set — AUTOPAY is off, but pass 1 still ISSUES
│       │                      # every invoice, payable by hand on /dashboard/plans
│       ├── cron/prune-logs/   # ★ DAILY log retention (§32): the ONLY caller of
│       │                      # lib/retention/prune.ts. notifications 90d,
│       │                      # activity_events 365d, email_logs 90d — windows
│       │                      # that were documented for months and enforced by
│       │                      # nothing. 503 on a failed table (seo-refresh
│       │                      # contract), 200 while a backlog drains
│       ├── dashboard/export/  # ★ §31 CSV export — a ROUTE, not an action, so it
│       │                      # STREAMS (keyset-paged, one page in memory) with
│       │                      # Content-Disposition. ?template=1 = blank template.
│       │                      # Gated on `view` of the resource's own section
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
│   ├── logistics/             # ★ §35 provider boundary: Shiprocket REST client + encrypted
│   │                          # session, fulfilment work, stable status machine and tracking
│   │                          # ingestion/order synchronization. Pure boundaries tested.
│   ├── shipping/              # ★ §35 checkout policy/types + pure rate translation +
│   │                          # server-only origin-aware Shiprocket quotation
│   ├── phone.ts               # Indian mobile normalization shared by checkout and Shiprocket
│   ├── csv/                   # ★ §31: PURE RFC 4180 codec. parse.ts (BOM, CRLF/LF/CR,
│   │                          # quoted fields w/ embedded delimiters+newlines, quote-
│   │                          # aware delimiter sniffing for Excel's semicolons, ragged
│   │                          # rows, ORIGINAL-file line numbers) + serialize.ts
│   │                          # (guardFormula — CSV injection, exempting plain numbers
│   │                          # so the round trip survives). Shared by browser + server
│   ├── import-export/         # ★ §31 THE REGISTRY: resources.ts (products/categories/
│   │                          # inventory/orders/coupons + their columns, aliases,
│   │                          # toCells), coerce.ts (one cell → one typed value; ISO
│   │                          # dates only), parse.ts (header mapping + Shopify handle
│   │                          # grouping), types.ts, limits.ts (in lib/ because a
│   │                          # "use server" file may only export async functions),
│   │                          # exporters.ts (async generators, keyset-paged),
│   │                          # jobs.ts (server-only job + ISSUE_CAP'd error log),
│   │                          # importers/{categories,products,inventory,coupons}.ts
│   │                          # (row-atomic, never throw, one outcome per row). Tested
│   ├── domains/               # ★ §30 custom domains: domain.ts (PURE validation +
│   │                          # normalisation + zone-relative record names),
│   │                          # naming.ts (deterministic Certificate Manager ids +
│   │                          # the delete guard that stops staging removing a prod
│   │                          # entry from the SHARED cert map), certificates.ts
│   │                          # (create-or-adopt the DnsAuthorization → Certificate
│   │                          # → CertificateMapEntry; explainCertificate turns
│   │                          # Google's CONFIG/CAA/RATE_LIMITED into an actionable
│   │                          # sentence), dns.ts (public-resolver checks — the cert
│   │                          # proves DNS control, NOT that the domain points here),
│   │                          # reconcile.ts (the auth-free core + the cron sweep;
│   │                          # NOT in the "use server" file, or the sweep would be
│   │                          # a public unauthenticated endpoint). Tested, plus a
│   │                          # RUN_DOMAIN_INTEGRATION=1 live provisioning test.
│   ├── store/                 # ★ Tenancy (see §3): host.ts, resolve.ts, brand.ts
│   ├── credit/                # ★ §29: store credit — apply.ts (PURE: how much
│   │                          # credit goes on an order, incl. the unpayable-
│   │                          # remainder gap below the gateway minimum) +
│   │                          # store-credit.ts (the ONE way credit moves —
│   │                          # issue/spend/reinstate, all via the RPCs)
│   ├── fulfilment/            # ★ §23: resolve.ts (which location serves an online
│   │                          # order) + strategies.ts (the routing REGISTRY) +
│   │                          # pickup.ts (is pickup on, hold/ready days, the
│   │                          # collection-payment policy reader) +
│   │                          # ★ payment-policy.ts (PURE: which payment methods
│   │                          # checkout may offer, and whether the one that came
│   │                          # back is allowed — ONE rule asked by both the picker
│   │                          # and placeOrder, so the UI can never offer what the
│   │                          # server refuses. ⚠ NOT lib/pos/pickup-payment.ts,
│   │                          # which answers a different question: what a
│   │                          # collection still OWES at the counter. Renamed off
│   │                          # that basename precisely so the two can't be
│   │                          # imported for each other)
│   ├── returns/               # ★ §28: in-store.ts (BORIS — canTakeReturnHere +
│   │                          # refundRouteFor: the TENDER decides where money goes,
│   │                          # and a sale rung HERE is always returnable here),
│   │                          # exchange.ts (settlement + the v1 boundary —
│   │                          # a replacement may not cost MORE, because collecting a
│   │                          # difference is a payment flow that doesn't exist yet),
│   │                          # reasons.ts (the eight-reason vocabulary +
│   │                          # feesFor — merchantFault WAIVES fees wholesale, and
│   │                          # the deduction is capped at the goods value so a
│   │                          # refund can never go negative) + eligibility.ts (the
│   │                          # ONE answer to "can this come back, and until when";
│   │                          # the window starts at POSSESSION, and it fails OPEN
│   │                          # on a dateless legacy row). Both pure + tested.
│   ├── orders/                # ★ cancel.ts (§26): the ONE implementation of what
│   │                          # cancelling DOES to stock — reserved stock released
│   │                          # AT THE LOCATION THAT RESERVED IT, pickup holds
│   │                          # released instead (their units never left the shelf).
│   │                          # Takes a `runner` so the dashboard keeps its
│   │                          # withUser(admin) scope while the customer path uses
│   │                          # withService after proving ownership itself.
│   │                          # history-channels.ts: pure Online/In-store grouping
│   │                          # and tab-visibility rules (current POS/pickup OR
│   │                          # historical receipt; never hide owned history).
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
│   ├── logs/                  # ★ §33: the Failures feed. failure-types.ts is the
│   │                          # CLIENT-safe half (shapes + FAILURE_SOURCE_META for
│   │                          # the filter chips); failures.ts is the server half —
│   │                          # FAILURE_SOURCES, one entry per table it reads. The
│   │                          # split is load-bearing: failures.ts imports the db
│   │                          # client, so a client component importing it drags
│   │                          # `pg` (and `fs`) into the browser bundle and FAILS
│   │                          # the build. Same rule as themes/meta.ts. Tested,
│   │                          # incl. a guard that the two catalogs stay in step
│   ├── retention/             # ★ §32: prune.ts — the log-retention sweep.
│   │                          # RETENTION_POLICIES is the registry (add a table
│   │                          # = add an entry); batches are 1000 rows, EACH ITS
│   │                          # OWN withService transaction. NOT a "use server"
│   │                          # file, deliberately — the version that lived in
│   │                          # app/actions was an ungated public endpoint that
│   │                          # could wipe the audit trail. Tested (the stopping
│   │                          # rules; deleteBatch is injected)
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
│   │                          # (mint/verify + .storemink.com cookie), constants.ts
│   │                          # (dependency-free shared session-cookie name),
│   │                          # firebase-claims.ts
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
│   │                          # search-engines.ts — grouped-per-host pingIndexNow()
│   │                          # (Bing/Yandex — NOT Google) + typed Google Search
│   │                          # Console / Site Verification API primitives.
│   │                          # ★ store-indexing.ts — ONE post-publish discovery
│   │                          # hook + idempotent per-store Google reconciliation;
│   │                          # keeps public token/status/error timestamps in
│   │                          # stores.settings and retries via seo-refresh cron.
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
│   │                          # templates, event-specific CTAs, pure/escaped) +
│   │                          # shell.ts (mobile table shell, contrast-safe accent)
│   │                          # + notification-worker.ts
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
│   │                          # ★ signup-otp.ts — platform-branded signup code;
│   │                          # RFC example-domain mail is log-only for dummy stores
│   ├── homepage/section-types.ts  # Section schema (typed, tested) — shared by homepage AND
│   │                          # custom pages; 17 types incl. editorial media/gallery/
│   │                          # testimonials, video, newsletter, rich_text + custom_code (§11)
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
│   │                          # razorpay-client.ts (client checkout.js loader + modal),
│   │                          # ★ issue-refund.ts (§26/§28: THE refund mechanism,
│   │                          # shared by the dashboard and the till — authorization
│   │                          # is the caller's job),
│   │                          # ★ refunds.ts (§26: PURE refund arithmetic — the cap,
│   │                          # the status map, the gateway matcher; tested) +
│   │                          # refund-reconcile.ts (settles refunds whose gateway
│   │                          # answer never arrived: reconcile-on-read + cron sweep)
│   ├── billing/               # ★ invoice.ts (§34, PURE + tested): line items,
│   │                          # tax in BOTH modes (inclusive carves
│   │                          # gross×r/(1+r), NOT gross×r), GST split,
│   │                          # proration, amountDuePaise. ★ payment-state.ts:
│   │                          # the MONOTONIC attempt machine — captured is
│   │                          # terminal, so a late payment.failed is rejected
│   │                          # by the machine rather than by comparing clocks.
│   │                          # ★ invoice-store.ts (server-only): the repository.
│   │                          # ensureRenewalInvoice is ON CONFLICT DO NOTHING +
│   │                          # read-the-WINNER, so a lost race never creates a
│   │                          # second obligation; lines are written BEFORE
│   │                          # finalize (the trigger freezes them after);
│   │                          # loadTaxContext falls back to tax-OFF on a read
│   │                          # failure, because a blip must never invent a tax
│   │                          # charge; amountDueForInvoice returns NULL rather
│   │                          # than the full total, since guessing when credit
│   │                          # may be applied would double-charge.
│   │                          # ★★ manual-pay.ts (server-only): paying an open
│   │                          # invoice on session — TODAY the only way a
│   │                          # renewal is paid, since automatic collection is
│   │                          # gated on an unverified endpoint. Refuses a
│   │                          # cross-tenant invoice id, and refuses an
│   │                          # UNCOLLECTIBLE/VOID one: those belong to a cycle
│   │                          # the merchant was already downgraded for, so
│   │                          # taking money would charge for service never
│   │                          # received. Paying during grace restores the plan
│   │                          # AT ONCE via advanceAfterPayment — the SAME
│   │                          # advance the worker uses, never a second copy.
│   │                          # ★★ enrol.ts (server-only): a merchant's FIRST
│   │                          # paid cycle. Works WITHOUT the unverified
│   │                          # recurring endpoint — cycle 1 is collected ON
│   │                          # SESSION by the same verified one-time checkout
│   │                          # the AI-credit purchase uses, and the mandate is
│   │                          # registered opportunistically for later cycles.
│   │                          # The plan is NOT granted until the payment is
│   │                          # captured (grace is for renewals, where
│   │                          # something has already been paid for). The HMAC
│   │                          # signature is the trust boundary. BOTH stores.plan
│   │                          # (the entitlement every gate reads) and
│   │                          # billing_subscriptions move, and the comp floor
│   │                          # holds — the old confirmSubscription wrote
│   │                          # stores.plan unconditionally and could overwrite
│   │                          # an operator comp DOWNWARD. Money in but plan
│   │                          # not moved is never a bare failure.
│   │                          # ★★ collect.ts (server-only): the ONLY place
│   │                          # money moves. issue-refund.ts generalised —
│   │                          # attempt row FIRST with OUR idempotency key,
│   │                          # THEN the gateway, THEN claim the outcome. A
│   │                          # UNIQUE violation on begin means "already
│   │                          # collecting", not an error. An UNKNOWN outcome
│   │                          # (5xx, timeout, THROW, or an unrecognised
│   │                          # gateway status) is NEVER a failure and is never
│   │                          # retried — a failure starts the grace clock.
│   │                          # Eligibility is checked BEFORE anything is
│   │                          # written, so an over-AFA amount routes to manual
│   │                          # rather than becoming a failed attempt. The
│   │                          # gateway call is INJECTED, because the Razorpay
│   │                          # subsequent-charge signature is still unverified.
│   │                          # ★ renewal-worker.ts (server-only): three passes.
│   │                          # COLLECT at T−4d (the X+3 rule), EVALUATE at T0,
│   │                          # DOWNGRADE at T0+48h. ★★ A PROCESSING invoice at
│   │                          # the boundary does NOTHING — no advance, no
│   │                          # grace, no clock. With the X+3 window that is
│   │                          # the ORDINARY state, so treating it as unpaid
│   │                          # would downgrade paying merchants routinely.
│   │                          # Grace is measured from the OBSERVATION, not the
│   │                          # cycle boundary, so an outage on our side cannot
│   │                          # eat a merchant's 48h notice. Downgrade
│   │                          # force-closes an open POS shift at ZERO variance
│   │                          # in the SAME transaction — a variance invented
│   │                          # by a billing event reads as a cashier being
│   │                          # short. ⚠ Pass 1 takes NO row lock on purpose:
│   │                          # it would expire before the gateway call it
│   │                          # looked like it protected. The constraints are
│   │                          # the guarantee.
│   │                          # ★ cycle.ts (§34, PURE + tested): the 30-day/365-day
│   │                          # cycle (a DURATION, never a calendar unit), the
│   │                          # X+3 collection lead, the 48h grace window,
│   │                          # collectionRoute (mandate max AND the AFA-exempt
│   │                          # limit — two different ceilings) and mandateSizePaise.
│   │                          # ★ credit-note-data.ts (§28: what a GST credit note
│   │                          # says — the invoice it reverses + splitGst on the
│   │                          # refunded tax, all from the ORDER's snapshot).
│   │                          # Invoices & tax (§17): types.ts (BillingSettings/
│   │                          # TaxClass + row mappers + defaults), tax.ts (pure
│   │                          # inclusive/exclusive tax math, tested), invoice-data.ts
│   │                          # (server-only invoice loaders: by-store + own-order)
│   ├── pricing.ts / slug.ts / sanitize.ts / rate-limit.ts / og-image.ts
│   ├── blog-taxonomy.ts   # fetchBlogTaxonomy(): per-store blog categories/tags reader
│   ├── blog-reactions.ts / phone-labels.ts / use-otp-throttle.ts
│   ├── site.ts / utils.ts     # Canonical platform/help/themes origins + cn() etc.
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
│   ├── logistics_01_shiprocket.sql # ★ §35 physical product/order snapshots plus
│   │                          # fulfilment orders, parcels, events, credentials and pickup maps;
│   │                          # all logistics tables are service-role only
│   ├── shipping_01_checkout_rates.sql # ★ §35 merchant rate policy + immutable
│   │                          # orders.shipping_option checkout promise
│   ├── locations_04_reservations.sql  # ★ stock_reservations + hold/commit/release
│   │                          # RPCs; available = on_hand - reserved
│   ├── locations_10_default_online_fulfil.sql  # ★ auto-created Main locations
│   │                          # fulfil online; repairs bare capability rows
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
│   ├── themes_01_newsletter_subscribers.sql # ★ host-scoped email consent rows for
│   │                          # footer/section newsletter forms; admin-read RLS (§11)
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
│   ├── import_export_01_jobs.sql # ★ §31: data_jobs (one row per CSV import or
│   │                          # export; `partial` is a real status) + data_job_issues
│   │                          # (one row per PROBLEM, carrying the ORIGINAL file
│   │                          # line — the error log). Service-role only, the
│   │                          # email_logs pattern: the rows quote raw cells, which
│   │                          # for an orders export means customer addresses
│   ├── import_export_02_background.sql # ★ §31: what makes an import a REAL
│   │                          # background job — data_jobs.cursor/lease_until/
│   │                          # attempts + data_job_payloads (the uploaded file,
│   │                          # in Postgres NOT the public media bucket). Its own
│   │                          # file because _01 is a CREATE TABLE IF NOT EXISTS
│   │                          # that prod has already run (§15b)
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
│   ├── billing_01_foundation.sql   # ★ §34 platform_billing_settings (operator GST
│   │                          # singleton; tax OFF until a GSTIN exists) +
│   │                          # billing_accounts + billing_mandates (one ACTIVE
│   │                          # per store, max_amount read from the token)
│   ├── billing_02_subscriptions.sql # ★ §34 billing_subscriptions (OUR state
│   │                          # machine, not Razorpay's) + billing_claim_downgrade()
│   │                          # — ONE statement that re-checks state, deadline,
│   │                          # comp exemption AND payment inside the UPDATE
│   ├── billing_03_invoices.sql # ★ §34 billing_invoices + items + the gapless FY
│   │                          # series (allocated ON FINALIZE by trigger, via
│   │                          # sm_pad) + immutability triggers. ⚠ APPLY BEFORE
│   │                          # billing_02's function is ever CALLED — plpgsql
│   │                          # resolves table names at call time, so the wrong
│   │                          # order succeeds and then fails at runtime
│   ├── billing_06_migrate_legacy.sql # ★ §34 the CUTOVER: moves live
│   │                          # store_subscriptions rows onto the new tables
│   │                          # (one in prod). ⚠ The mandate CANNOT come with
│   │                          # them — a Razorpay Subscription's mandate is a
│   │                          # different product from a recurring token — so
│   │                          # they re-authorise or pay manually next cycle.
│   │                          # No invoice for the already-paid cycle (it would
│   │                          # burn a GST number for a document never sent),
│   │                          # comped stores skipped, and ⚠ the gateway
│   │                          # subscription must be cancelled SEPARATELY or
│   │                          # Razorpay's timer bills alongside our worker
│   ├── billing_05_tax_mode.sql # ★ §34 platform_billing_settings.tax_inclusive.
│   │                          # ⚠ Its OWN file because billing_01 is APPLIED —
│   │                          # editing an applied CREATE TABLE IF NOT EXISTS
│   │                          # is a silent no-op (§15b's subscriptions_02)
│   ├── billing_verify.sql     # ★ §34 adversarial check of the APPLIED schema
│   │                          # (26 checks). Mutations run in a plpgsql
│   │                          # SUBTRANSACTION that is rolled back, so nothing
│   │                          # persists — not even a burned invoice number —
│   │                          # while the results survive in plpgsql ARRAYS,
│   │                          # which are memory rather than transactional
│   │                          # state. Asserts 26-of-26 RAN, so an empty or
│   │                          # half-dead run can never render as green.
│   │                          # No psql meta-commands: runs in Cloud SQL Studio
│   ├── billing_04_payments.sql # ★ §34 billing_payment_attempts (ONE in flight per
│   │                          # invoice, partial unique) + billing_credits +
│   │                          # billing_reconciliation_items + the additive
│   │                          # billing_webhook_events extension
│   ├── plans_02_basic_and_expiry.sql # ★ starter→basic rename + plan_expires_at — §15
│   ├── ai_credits.sql         # ★ credit balances/ledger/purchases + add_ai_credits/
│   │                          # try_spend_ai_credit RPCs (service-role only) — §16
│   ├── payment_providers.sql  # ★ store_payment_providers (BYO Razorpay creds,
│   │                          # service-role only, app-layer encrypted secret) — §18
│   ├── payments_01_orders.sql # ★ orders.razorpay_order_id/payment_id + indexes — §18
│   ├── identifiers_05_no_truncate.sql # ★★ CRITICAL (§14): Postgres lpad()
│   │                          # TRUNCATES, so every sm_* formatter silently lost a
│   │                          # digit past 9999 — the 10,000th product FAILED to
│   │                          # insert ((store_id,sku) is UNIQUE) and order #1000 and
│   │                          # #10000 shared an order_ref. lib/identifiers.ts was
│   │                          # always right; only the SQL mirror was wrong. Adds
│   │                          # sm_pad() + a self-check. Backward compatible: at
│   │                          # ≤ 9999 the two forms are byte-identical
│   ├── store_credit_01_schema.sql # ★ §29: customer_credit_balances +
│   │                          # append-only customer_credit_ledger + the two
│   │                          # RPCs (spend is a conditional UPDATE, so a race
│   │                          # can't overdraw) + orders.store_credit_used
│   ├── returns_04_credit_notes.sql # ★ §28: GST credit notes — store_counters.
│   │                          # credit_note_seq + next_credit_note_no() +
│   │                          # sm_credit_note_ref() + a TRIGGER that allocates the
│   │                          # serial on SETTLEMENT (a gap is what an audit flags)
│   ├── returns_03_exchanges.sql # ★ §28: order_returns.exchange_order_id + per-line
│   │                          # exchange_product/variant/price/hold. An exchange is a
│   │                          # return PLUS a new order, never a third entity
│   ├── returns_02_requests.sql # ★ §28: the order_returns LIFECYCLE (requested →
│   │                          # approved → received → completed) + channel/reason_code/
│   │                          # photos/fee snapshots/review fields, and customer SELECT
│   │                          # RLS. status DEFAULTS 'completed' — every existing row
│   │                          # is a finished till return
│   ├── returns_01_product_policy.sql # ★ §28: products.returnable (backfilled TRUE
│   │                          # — nothing was final-sale before) + return_window_days
│   │                          # (NULLABLE override, never a copy of the store value)
│   ├── refunds_01_gateway.sql # ★ §26: order_refunds.idempotency_key (UNIQUE)/reason/
│   │                          # reference + orders.delivered_at (backfilled). Its OWN
│   │                          # file — pos_12 has run, so editing it is a silent no-op
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
├── drizzle/migrations/        # ★ Existing-DB migration ledger manifest. A verified
│   ├── manifest.json          # legacy baseline + ordered immutable SQL references,
│                              # SHA-256 checksums and object-level postconditions.
│                              # `schema_migrations` itself is bootstrapped by the
│                              # admin-only runner; it is not an application table.
│   └── sql/                   # New forward-only SQL. 0002 repairs the production
│                              # credit-note formatter drift (bare lpad truncated
│                              # legal serials beyond 9,999) and canonicalizes the
│                              # scheduled-plan constraint in both environments.
├── scripts/
│   ├── db-migrate.mjs         # ★ status/baseline/apply/verify runner: physical DB
│   │                          # guard, advisory lock, one transaction per migration,
│   │                          # checksum drift/unknown-row refusal, RLS/table/column/
│   │                          # constraint postconditions + complete schema fingerprint
│   └── db-migrations-core.mjs # pure manifest/checksum/planning primitives (tested)
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
   - **★★ `.dashboard-shell` IS A SCOPE; `.dashboard-frame` IS THE PAGE.** The
     scope class carries the `--dash-*` tokens and every `.dash-*` component
     rule. The frame class carries the things only a whole-page wrapper should
     have — `height: 100vh`, `overflow: hidden`, the page background — and is
     applied ALONGSIDE the scope in `app/dashboard/layout.tsx` and the platform
     console layout. **Keep them apart.** They were one class, and that is why
     nothing in `dashboard.css` reached a dialog: a Radix `DialogContent`
     portals into `document.body`, outside the shell element, so every
     `var(--dash-*)` resolved to nothing and every `.dash-*` rule failed to
     match. Not subtle — Tailwind's `border` utility sets a width and leaves the
     colour to `var(--dash-border)`, and an invalid custom property falls back to
     `currentColor`, so every panel in every dashboard dialog drew a hard BLACK
     hairline; buttons lost `inline-flex` (icons stacked above their labels) and
     `cursor: pointer`; cards lost surface, radius and shadow. The fix is that
     the four portalled primitives (`dialog`, `dropdown-menu`, `sheet`,
     `select` in `components/ui/`) each wear `dashboard-shell`, which is only
     safe because the frame no longer rides along — it was already giving the
     notification recipient picker, which opts into the scope for its tokens, a
     100vh height and an `overflow: hidden` that beat its own `overflow-y-auto`.
     **Rewriting the ~414 selectors instead was the obvious move and the wrong
     one**: it fixes dialogs only, and dropdowns/sheets/selects portal too.
     Adding a class is safe because no rule in the file is a bare element
     selector — they are all `.dash-*`, so scoping an overlay cannot restyle its
     internals by accident. Keep it that way.
   - **⚠ `dashboard.css` IS UNLAYERED, so it beats every Tailwind utility**
     regardless of specificity (utilities live in `@layer utilities`). That is
     fine for rules that predate the utilities at a call site, but a NEW base
     style must go in `@layer components` or it silently defeats them — which is
     where `.dash-input` lives, because two Razorpay credential fields pass
     `font-mono` and the media library passes `px-2 text-xs`. `globals.css`
     documents the same hazard from the other direction.
7. **Next.js 16 caution**: APIs may differ from training data — check
   `node_modules/next/dist/docs/` before using unfamiliar APIs (AGENTS.md rule).
8. **Tests**: `npm run test` (vitest, coverage). CI also runs `lint`, `typecheck`,
   **`test:shuffle`**, `prettier --check`, `build` — all must pass.
   **★★ `test:shuffle` IS NOT A DUPLICATE RUN.** `npm run test` executes files in
   DECLARATION ORDER, so a test that passes only because it happens to run before
   another one looks permanently green. Three did (fixed 2026-08-13), all from the
   same cause: **`vi.clearAllMocks()` clears CALLS, not IMPLEMENTATIONS**, so a
   `mockResolvedValue`/`mockRejectedValue` set inside one test leaks into every
   test after it — and the offenders were declared LAST in their files, so nothing
   followed them. One hid a razorpay suite charging ₹150 for a ₹200 order.
   **Restore defaults explicitly in `beforeEach`**; `resetAllMocks()` is NOT the
   fix here, because in this Vitest `mockReset` restores an implementation passed
   to `vi.fn(impl)` but WIPES a `mockResolvedValue` set at a `vi.mock` factory, and
   this repo uses both forms — which is also why a global `mockReset: true` is a
   prerequisite refactor rather than a config flag.
   ⚠ The seed is FIXED (one ordering, reproducible): a randomly-red suite teaches
   people to re-run rather than trust it. One seed is one permutation, so it
   catches regressions this ordering exposes, not all of them — hunt for more with
   `npx vitest run --coverage=false --sequence.shuffle --sequence.seed=<n>`.
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
   **★ THREE TYPES: `boolean`, `number` and `select`.** `select` carries
   `options` — and that list IS the validation, not a UI hint:
   `resolveStoreSettings` refuses a stored value that is not in it and falls
   back to the default, so a retired option stops applying the moment it is
   removed rather than lingering in a jsonb blob nobody reads.
   `saveStoreSettings` re-checks it server-side (invariant 5 — the dropdown is
   not the boundary) and now validates EVERY type before writing, where it used
   to store whatever arrived on the reasoning that the read side rejects a
   wrong-typed value. True, but it left the stored blob full of values that do
   nothing, which is what makes a settings bug impossible to diagnose from the
   database. First consumer: `fulfilment.pickupPayment` (§23).
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
    shared by the homepage AND custom pages. Seventeen block types: `hero`
    (banner/split/minimal variants — first-class hero, replaces the old
    custom_code hero hack; optional `video_url` plays muted/looping in place
    of the image with the image as poster), `hero_carousel` (auto-playing
    photo/video slideshow — `slides[]` of HeroSlide, dot + arrow nav,
    client-rendered `hero-carousel-section.tsx`), `featured_products`,
    `shop_by_category` (with a
    `display: circles|cards` tile-shape variant), `promo_banner`, `tile_grid`
    (linked colour/image tiles — offers, collections, 2-up mini banners),
    `media_text` (theme-agnostic editorial image/copy split with media position,
    aspect-ratio, alignment and CTA controls), `gallery` (even grid or
    asymmetric editorial lookbook with linked/captioned images), `testimonials`
    (customer quotes and optional press logos in cards or editorial rows),
    `video` (YouTube/Vimeo privacy embeds or direct video with poster, aspect,
    width and playback controls), `newsletter` (consent-aware email signup with
    merchant copy, theme and alignment controls),
    `usp_bar` (fixed icon catalog `USP_ICONS` + label strip), `ticker`
    (scrolling marquee — `messages[]` + speed + text theme; CSS-animated
    `ticker-section.tsx`, pauses on hover, static under reduced-motion),
    `faq_accordion`
    (expandable Q/A with optional category-filter pills; plain-text answers),
    `latest_blogs`, `rich_text` (inline sanitized HTML, SEO-friendly) and
    `custom_code` (merchant HTML/CSS/JS). Hero/tile/slide `background` fields
    are strict colours (`safeColor`) because they render into inline style
    attrs; media, logo, CTA and `video_url` fields are `safeHref`-validated.
    All seventeen types have builder forms and section-library thumbnails;
    Phase 3's renderers live in `media-text-section.tsx`, `gallery-section.tsx`,
    `testimonials-section.tsx`, `video-section.tsx`, and
    `newsletter-section.tsx`.
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
    website decision. The Brand inspector also owns **Storefront layout**:
    header, product-card, PDP, cart and footer can each inherit the pinned theme
    or take a merchant override. These values live in the same draft/published
    `store_chrome` payload, update the iframe through `ChromeProvider`, and do
    not mutate the immutable theme preset. Pages list in an always-visible
    **rail** rather than a
    dropdown that overlaid the section outline you were about to edit, and
    `loadingDraft` starts TRUE when there is a page to auto-open so the first,
    pre-hydration paint says "Opening…" instead of "Select a page" — React
    state cannot fix that frame, only the initial value can. - **Themes (signup seeding)**: a theme is a DATA PACKAGE in `lib/themes/` —
    `meta.ts` (client-safe, versioned catalog manifest: id/name, engine ref,
    release state/version/notes, industries, catalog-size fit, feature claims,
    keywords, plan gate, preview/screenshots, demo health and catalog
    visibility; client surfaces must NEVER import definitions),
    `definitions/basket.ts`, `definitions/studio.ts`, and
    `definitions/ritual.ts` (immutable `preset` releases: brand accents,
    **`design` skin**, pages incl. the homepage sentinel, menus, sample
    categories/products+variants — imagery
    bundled under `public/themes/{id}/`; **basket** is the grocery/F&B
    reference template with real Unsplash photography, per
    docs/vertical-templates-plan.md §9.1, and the default theme; **studio** and
    **ritual** are published `0.1.0` editorial home-design and botanical-wellness
    themes with generated, provenance-logged imagery, available in signup and
    the public catalog after their 2026-08-12 production/demo audits — the
    Arcade/Fresko placeholders were retired 2026-07-04),
    `apply.ts` `applyTheme(storeId, themeId,
    {publish, reset?})` — service-role, idempotent upserts keyed on
    (store_id, slug), best-effort per entity with an errors accumulator;
    `reset` refuses unless `stores.settings.demo === true`. `applyTheme` keeps
    legacy `settings.template` but also pins `{presetId,presetVersion,engineId,
    engineVersion,appliedAt}` in `settings.theme`; the authored preset seeds a
    starting point, while subsequent merchant pages/menus/products remain
    store-scoped DB content rather than theme-package state. Rendering reads
    the pin first and falls back to legacy `template`, so existing stores need
    no migration; old immutable releases stay in `THEME_DEFINITIONS` when a
    preset advances. `createStore` (signup) calls it with the picked template
    (published immediately; brand NAME preserved). v1 constraints CI-tested in
    `lib/themes/themes.test.ts`:
    non-id sources only, no latest_blogs, homepage present, strict publish
    validation, every referenced asset exists, catalog metadata is unique and
    publishable, seeded pages/homepages/catalogs meet minimum content floors,
    and referenced imagery is optimized + catalog-sized. The full release gate
    is **`docs/theme-acceptance.md`**: CI package integrity + live storefront
    stories + accessibility/performance + a scored two-reviewer design pass;
    generated/licensed asset provenance lives in **`docs/theme-assets.md`**.
    A valid definition is deliberately NOT the same as an approved theme.
    **Demo stores**: one per theme
    (`demo-{id}` — the namespace is blocked at signup), seeded/reseeded via
    `seedDemoStore` (platform superadmin action) from the Themes panel on the
    platform stores console; the signup picker's Preview opens
    `https://demo-{id}.{ROOT_DOMAIN}` only when manifest demo health is
    `healthy`; an unavailable demo renders a disabled, explanatory control
    instead of opening a known 404. `createStore` repeats catalog visibility
    validation server-side, so posting a hidden/draft/unknown id around the
    signup UI cannot install it.
    **Public theme catalog (Phase 4, in progress)**:
    `themes.{ROOT_DOMAIN}` is a reserved platform host (`isThemesHost`) rewritten
    by `proxy.ts` to `app/themes/`, never resolved as merchant tenancy. The
    server-rendered catalog imports only client-safe `THEME_META`, so its
    industry filters, plan badges, release labels, preview image, demo health,
    and signup CTA share the exact source used by onboarding. It has its own
    canonical/OG metadata (`public/themes/catalog-og.png`), robots host, and
    one-entry sitemap; the platform nav/footer links to it. Blocked or unhealthy
    demos render an honest unavailable state rather than a broken live link.
    `themes` is also rejected by store-signup slug validation.
    **Theme DESIGN engine (the visual "skin")**: a theme controls the FULL
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
    WholeSip chrome): header supports `classic`, `market`, `centered`, and
    `minimal`; cards support `classic`, `quick_add`, `overlay`, `framed`, and
    `grocery`; product detail supports `classic`, `grocery`, and `editorial`;
    cart supports `classic`, `grocery`, and `compact`; footer supports `rich`,
    `minimal`, and `editorial`. `resolveStorefrontAppearance` in
    `lib/chrome/types.ts` is the single pure resolver for theme defaults plus
    published merchant overrides; it also preserves the pinned legacy
    `storefront:"grocery"` shorthand. Root `sm-*` classes drive CSS variants,
    while `lib/store/storefront-layout.ts` supplies resolved values where
    grocery markup branches are required. `header:"market"` retains its
    theme-controlled colours and `card:"quick_add"` retains safe inline add
    behavior (multi-variant products fall through to detail). Header search is
    FUNCTIONAL on all variants — it submits to
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
    Design derives from the installed preset release at RENDER time. New
    installs are version-pinned in store settings; legacy stores without the
    pin resolve the catalog's current release. - **Newsletter capture**:
    `newsletter-form.tsx` is shared by the footer and the builder newsletter
    section. `subscribeNewsletter` derives tenancy from the request host,
    validates email plus explicit consent, honeypots bots, rate-limits per
    store/IP, and service-upserts one active row per store/email while recording
    the displayed consent copy and source. Storage is
    `newsletter_subscribers` (`themes_01_newsletter_subscribers.sql`): anon has
    no direct write grant and authenticated store admins have read-only RLS. - **Phase 4d (not built, by design)**: nothing pending — homepage, static
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

    **★ THE SQL MIRROR TRUNCATED PAST 9999** (found 2026-08-03, fixed by
    `supabase/identifiers_05_no_truncate.sql`). Postgres `lpad('12345',4,'0')`
    returns `'1234'` — it truncates as well as pads, and every `sm_*` formatter
    padded each field to exactly 4. So `sm_order_ref(1001,1000)` and
    `sm_order_ref(1001,10000)` produced **the identical string**. Consequences,
    in severity order: `(store_id, sku)` is UNIQUE, so a store's **10,000th
    product could not be inserted at all**; `order_ref` has no unique index, so
    orders quietly shared a customer-visible reference (invoices, support
    lookups and the POS return search all ambiguous, with no error anywhere);
    `store_no` is global from 1000, so the platform's 10,000th store hit it
    too. `lib/identifiers.ts` was ALWAYS correct — its `pad()` is documented as
    "codes grow past these; they never truncate" — so the two implementations
    disagreed exactly where it mattered and nowhere a test looked. The fix adds
    `sm_pad(value, minWidth)` and routes every formatter through it, so the next
    one added can't reintroduce it by copying the pattern (which is how
    `sm_credit_note_ref` inherited it). **Backward compatible**: at ≤ 9999 the
    fixed and broken forms are byte-identical, so no already-issued code
    changes, and no backfill is needed. Pinned by `lib/identifiers.test.ts`
    ("codes GROW past their pad width") and by a guard inside the migration.

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
    `stores.plan_source` (`comp`/`paid`/`trial`); every change is recorded in
    the append-only `plan_events` audit table (service-role only, like
    `store_counters`) — schema in `supabase/plans_01_schema.sql`.
    - **★ A COMP IS A FLOOR, NOT A CEILING** (`billingMayApplyPlan`,
      `lib/payments/plan-change.ts`, pure + tested). The rule used to be "an
      operator comp must never be overwritten by a billing webhook", and its
      intent is right — a stale subscription renewing on basic must not strip a
      store an operator gave Pro. But as an unconditional refusal it had **no
      exit**: `setStorePlan` stamps `plan_source = 'comp'` on every operator
      grant and never clears it, so a store an operator had ever touched could
      never activate a plan it PAID for. Prod, 2026-08-06: `echos` was comped
      basic in July, subscribed to Pro, was charged, and had all three Razorpay
      webhooks (`activated`/`charged`/`authenticated`) arrive and be discarded.
      Billing may now RAISE a plan above a comp and never lower it. Equal rank
      is refused deliberately — a store comped Pro indefinitely that subscribes
      to Pro would otherwise swap an open-ended grant for a `plan_expires_at`
      tied to the card, and one failed charge would have the expiry cron take
      away what an operator gave.
    - **★★ `plan_events.source` IS NOT `stores.plan_source`.** The CHECK allows
      `operator | billing | system`; the plan_source column allows
      `comp | paid | trial`. All three billing writers reached for
      `source: "paid"` — rejected by Postgres every time, and because each
      insert sat in the SAME transaction as the `stores` update, the rejection
      **rolled back the plan the merchant had just been charged for**, surfacing
      as "Payment succeeded but activating the plan failed." It hid for months
      because the symptom is an EMPTY audit log — which is the first place you
      look to find out why a plan didn't change. `source` is plain `text`, so
      TypeScript cannot catch it; `lib/plans-audit-coverage.test.ts` is the CI
      guard. Every billing audit insert now runs in its OWN transaction, so an
      audit failure can never undo an activation (the pattern `platform.ts` and
      the plan-expiry cron already used).
    - **★ NEVER REPORT A BARE SUCCESS WHEN THE PLAN DIDN'T MOVE.** `changePlan`
      returned `{success: true, message: "You're now on the Pro plan."}`
      regardless of whether the write landed — money has already moved at
      Razorpay by that point, so a silent no-op is the worst possible outcome.
      It now returns an error naming what happened.
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

15b. **Plan changes — direction decides timing, not the merchant**
(`lib/payments/plan-change.ts`, pure + tested). A merchant can move tier,
billing period, or both. `decidePlanChange` compares AMOUNTS, and the rule
is Shopify's: **dearer applies now** (Razorpay prorates and charges the
difference), **cheaper or equal waits for the paid cycle to end**. - **Not the merchant's choice, deliberately.** "Apply now" on a downgrade
is the option that looks helpful and triggers a refund of money already
paid. Waiting for the cycle removes refunds — and the disputes, partial
reversals and reconciliation that come with them — from the system
entirely. Nobody loses money; they keep what they bought until it runs
out. The dialog now offers ONE button and says which case it is. - **AMOUNTS, not tiers.** Rank would read monthly→yearly as "no change"
(same tier, 10× the charge), and would ignore that a subscriber may be
GRANDFATHERED on an older price — so a tier downgrade can be a real
price increase. The current amount is read from the Razorpay plan
actually attached to the subscription (`amountForRzpPlan`), falling back
to the catalog. - **Period changes are supported by Razorpay** — "if the plans have
different billing cycles, the new plan is billed at the new interval".
They were impossible here only because `changePlan` ignored period and
refused same-plan. monthly→yearly is an upgrade; yearly→monthly is a
downgrade and is scheduled. - **`scheduled_period` exists because `scheduled_plan` cannot express a
same-tier period switch** (`plans_04_scheduled_period.sql`). Worse, the
webhook clears a schedule once billing reaches `scheduled_plan` — which
for a period-only change is true immediately, so the pending switch would
cancel itself at the next renewal. The webhook now resolves BOTH axes
from the billed plan id and clears only when both match. - **★ NEVER ADD A COLUMN BY EDITING A `CREATE TABLE IF NOT EXISTS`
MIGRATION.** `scheduled_plan` was added to `subscriptions_01_schema.sql`
after prod had already run that file, so re-running it was a silent no-op
and the column never arrived — prod held a table matching an older copy
of the file while the code wrote every column Drizzle knew about. Every
upgrade then failed with "Couldn't start the subscription", and because
the Razorpay subscription is created BEFORE that insert, each attempt
left an orphan at the gateway. Repaired additively by
`subscriptions_02_scheduled_plan.sql`; anything added to an existing
table needs its own file. The failure was also invisible from the app
logs — a Drizzle error's `message` is only "Failed query: …" and the
reason lives on `cause`, which `logError` now emits. - **`halted` and `pending` are refused with an explanation.** Razorpay
only updates `authenticated`/`active`, and those two are the states a
subscription lands in AFTER a payment fails — exactly when someone comes
to downgrade. Without the check they got a raw gateway error at the worst
moment. - **The mandate ceiling carries 2× headroom.** It is fixed when authorised
and can only be raised by re-authorising, so pinning it to today's top
price meant any later price rise locked existing subscribers out of
upgrading. A mandate is a ceiling, not a charge. - **Price rises grandfather existing subscribers**, as a consequence of
`razorpayPlans` being keyed on (plan, period, amountPaise): a reprice
mints a NEW Razorpay plan and a live mandate keeps its own. There is no
migration path for existing subscribers by design — silently raising a
running subscription is how you get chargebacks.

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
    order: **email → password (+ Continue with Google) → email OTP → phone OTP
    → name → store → location → theme → plan**. Data model: names go to
    `admins.first_name`/`last_name`; the selling **location** (country + city)
    goes to `stores.settings.business` (anon-readable jsonb — non-secret, prints
    on invoices; convention #9). Country list in `lib/countries.ts` (pure,
    client-safe, India-first). - **Auth (Identity Platform, Phase 6)**: email/password via
    `createUserWithEmailAndPassword` (falls back to `signInWithEmailAndPassword`
    on `auth/email-already-in-use`). Password users then pass a six-digit email
    OTP (`app/actions/signup-email-otp.ts`): the server derives identity from the
    session, rate-limits account + IP, stores only a peppered hash in a signed
    httpOnly cookie, caps wrong attempts, expires it after 10 minutes, and marks
    Firebase `emailVerified` after a constant-time match. Google already supplies
    a verified email claim and skips only that step. Phone uses
    `PhoneAuthProvider.verifyPhoneNumber`
    (invisible reCAPTCHA) + `updatePhoneNumber`. After each sign-in / phone link
    the client `establishSession()`s (POST the ID token → httpOnly cookie);
    `createStore` enforces **both** `emailConfirmed` and `phoneConfirmed`
    server-side via `getServerUser`, so the wizard re-mints the cookie
    (`establishSession(forceRefresh)`) after each verification. Every signup OTP
    is platform mail and lands in the operator email log with its credential
    redacted; RFC-reserved example domains and `.test`/`.invalid`/`.localhost`
    dummy domains skip Resend and put the code in that operator-gated log under
    the separate `signup_test_otp` mailer.
    The Terms/Privacy/AUP checkbox still gates Google and password signup, but
    the buttons stay interactive so a click explains the requirement instead of
    looking like a broken OAuth control. - **Google**:
    `signInWithPopup(GoogleAuthProvider)` — entirely
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
    `RAZORPAY_KEY_SECRET`). - **Location autofill is independent of the map.**
    Browser geolocation is followed by the keyless BigDataCloud client-side
    reverse-geocode endpoint, so country/city fill even when the optional Google
    Maps key/script is missing; Google remains the richer street/map enhancement.

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
      `withService` after the gate. These actions are tested across public
      throttles, the operator dual gate, validation/sanitization, atomic category
      deletion, media cleanup, indexing and AI drafting failures.
      **`deleteHelpCategory` refuses a non-empty
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
    The public product site is separately served at **`pos.storemink.com`** by
    rewriting into `app/platform/pos`; `pos` is reserved from merchant signup,
    uses its own canonical/robots/sitemap, and the daily SEO reconciliation job
    submits that sitemap alongside the apex, help and themes hosts.
    `app/platform/pos/structured-data.ts` emits a connected Organization +
    WebSite + SoftwareApplication graph (visible feature list and the live Pro
    price included), so the product host resolves to StoreMink's shared company
    identity instead of presenting as an unrelated site. The old
    `storemink.com/pos` URL remains a canonicalized compatibility alias.
    Full technical design + phased plan: **`docs/pos-plan.md`** (authoritative).
    Pro-only; 2 locations included, extra locations ₹1,000/mo — **metered
    billing is BUILT (Phase 7, see below); the v1 hard gate at 2 is gone**.
    Work on branch `pos`. **Phase 0 (done) = the inventory
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
        5. **Idle auto-lock** (`app/pos/idle-lock.tsx`, mounted ONCE in
           `app/pos/layout.tsx`): every operator's
           register locks after `pos.idleLockMinutes` of inactivity (registry
           setting, default 10, edited at `/dashboard/pos/settings`) with a
           **2-minute** countdown, capped at half the idle window so a
           1-minute setting doesn't show the banner permanently. It was 20s,
           which is too little notice to finish serving the customer in front
           of you first — and because the banner is the only part of the timer
           anyone ever sees, 20s also got read as the whole lock time.
           **Only the SUPERADMIN is exempt** (`isIdleLockExempt` — a delegated
           dashboard admin locks like anyone else; see the discount rule in
           Phase 2 for why the two are told apart). It targets the
           walked-away-from-a-shared-till risk, and locking clears BOTH the
           operator token and `sm_session` — so it ends a dashboard session as
           well, which is exactly why the exemption exists rather than the lock
           applying to everyone. It is a physical-presence
           measure, NOT an authorization boundary (a client bypass keeps the
           cookie until it expires); the server boundary remains the device gate
           - per-request `pos_staff` re-validation.
             **★★ IT IS MOUNTED IN THE LAYOUT, AND THAT IS THE WHOLE FIX.** It was
             per-page opt-in, and **five of the seven POS screens never opted in** —
             `/pos/inventory`, `/pos/shift`, `/pos/returns`, `/pos/pickups` and
             `/pos/sales`. Only `/pos` and `/pos/sell` ever locked, so the till sat
             unlocked indefinitely on the three screens where walking away costs
             MOST: returns issues refunds, inventory adjusts stock, shift moves
             cash. A control every new page has to remember is one the next page
             will forget. The layout renders it for any non-exempt operator and
             nothing for `/pos/login|register|reset` (no operator ⇒ nothing to
             lock, and a timer that redirects to the login page FROM the login page
             is a loop). Pinned by `app/pos/idle-lock-coverage.test.ts`, which
             fails in BOTH directions — the layout losing it (every screen stops
             locking) and a page re-adding its own (two timers, two banners, two
             racing `posLock()` calls). ⚠ `resolvePosOperator` is now wrapped in
             React `cache()` so the layout's resolve is free: `/pos/sell` was
             already resolving the operator three or four times per render (page
             gate + `getRegisterConfig` + `lookupProducts`), and this dedupes them
             within the request without touching the ACROSS-request re-validation
             that makes deactivation immediate.
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
      re-derived and authorised (see the owner-only rule below), tax
      recomputed, stock reserved atomically **at the register's location**
      (`reserve_stock_at`), service-role writes last, and a reverse rollback
      chain on any failure. `getRegisterConfig` opens the register;
      `placePosSale` rings it; `getPosReceipt` re-renders one. The tender
      vocabulary, its **allowlist** and the coverage/change math live in
      `lib/pos/tenders.ts` — shared with the collection counter, which is the
      second place money is taken (§23).
      - **★ ONLY THE SUPERADMIN MAY GIVE MONEY AWAY** (`pos.ownerOnlyDiscounts`,
        default **on**). A discount is the till's one irreversible act that
        leaves NOTHING missing from the shelf to count afterwards — no physical
        trace — so it sits with the person whose money it is. Three parts:
        - **The grant is `SUPERADMIN_ONLY` in `lib/pos/permissions.ts`** —
          `discount`, `price_override` **and `authorize_device`**, held by
          neither staff role (by OMISSION, so a role added later can't inherit
          them by resembling a manager) and **not by a delegated dashboard admin
          either**. Hence **FOUR actor roles**: `PosActorRole` gained
          `superadmin` alongside `owner`, and `resolvePosOperator` distinguishes
          them with `isStoreSuperadmin()` (access.ts — request-cached, and the
          one gate here that FAILS CLOSED, since the cost of a DB blip is a
          refused discount, not a locked-out admin). POS access is delegable;
          giving money away — and handing out the ability to take it — is not.
          Otherwise "owner only" quietly means "anyone ever given a dashboard
          login with POS on".
        - **GRANTING device trust is narrowed; REVOKING is deliberately not.**
          `authorizeThisDevice` and `createPairingCode` (a pairing code IS an
          authorization, posted to someone else to redeem) go through
          `superadminIdentity()` in pos-auth-actions.ts; both failure modes
          return the same message, so a delegated admin isn't told they'd have
          passed the weaker gate. `revokeDevice` keeps `getManagerIdentity("pos")`
          — revocation can only ever REDUCE what a browser may do, and making the
          owner the only person who can kill a stolen or cloned till would buy
          nothing while leaving it live for hours. Pinned by a test so it isn't
          "tidied up" into symmetry. `pairDevice` is unchanged: the code is the
          authorization, redeemed on the device by whoever holds it.
        - **The idle lock now exempts ONLY the superadmin**
          (`isIdleLockExempt`, applied once in `app/pos/layout.tsx` — see
          Phase 1 §5 for why it is no longer per-page). Not a
          capability — it isn't something you may DO, it's whose screen may be
          left unattended — and a delegated admin at a shared counter is the
          same walked-away-from-an-open-till risk as any operator, with a
          session that reaches further than a cashier's. ⚠ **Know what that
          costs:** `posLock` clears `sm_session` as well as the operator token,
          so an idle till now signs a delegated admin out of `/dashboard` too.
          That is the intended trade for everyone except the person whose shop
          it is — and it is why the exemption exists at all rather than the lock
          simply applying to everybody. `IdleLock` also calls `endSession()`, so
          the Firebase SDK left running in the page can't re-mint a session for
          someone who has walked away; the manual "Lock" button has always done
          both, and an unattended till has more need of it, not less.
        - **Refused, NOT queued for approval.** Returning `needsApproval` would
          put a PIN prompt on screen and let a **manager** wave through the very
          thing they are being kept out of; their own PIN must not be the key.
        - **All three mechanisms, or none.** An order discount, a per-line
          markdown ("Less ₹50"), and repricing a ₹200 tin to ₹1 are the same act
          with different arithmetic. Blocking one and leaving another open makes
          the rule decorative — which is exactly what an open
          `pos.allowPriceOverride` did for the first version of this. That
          setting is now WHETHER the till may reprice at all (a store policy, so
          it stops the superadmin too); WHO may is this rule.
          The register hides both fields via `RegisterConfig.canDiscount` /
          `canOverridePrice` — a field that always fails at the till, in front of
          a customer, is worse than no field — but the server is the boundary, and
          the config carries the ANSWER, never the policy.
          Switching the setting OFF re-arms the pre-existing cap machinery
          (`pos.requireManagerForDiscount` + `pos.maxDiscountPercent`: a cashier
          needs a manager's PIN above the cap, and for an override), which now asks
          `posCan(role, "discount_over_cap")` rather than an inline
          `role === "cashier"` that could drift from the capability table.
          **★ A CAP OF 0 IS A REAL SETTING AND MUST SURVIVE THE FALLBACK.** The
          cap was read as `Number(settings[…]) || 10`, which looks like a NaN
          guard and is really a `0` eater: the registry declares `min: 0`, so 0
          is legal and MEANS "a cashier needs approval for ANY discount" — and
          the merchant who locked it down hardest silently got the 10% default,
          handing cashiers exactly the authority they had withheld. It reads
          `typeof === "number"` now, since `resolveStoreSettings` already
          guarantees a number clamped to `[min, max]` and the fallback is only
          for a structurally impossible value. Same rule as
          `products.return_window_days` (§28): a real 0 is not an absent value.
          Both directions are regression-tested — 0 must stop a 5% discount, and
          must not refuse a sale carrying no discount at all.
      - **★ A MANAGER'S APPROVAL IS A SIGNED GRANT, NOT A CLIENT FLAG**
        (`lib/pos/approval.ts`). `verifyManagerPin` returned `{approved: true}`
        and `placePosSale` trusted an `opts.managerApproved` boolean that came
        from the browser — but both are server ACTIONS, so the register's own
        JavaScript is not the only caller. A cashier with devtools could invoke
        `placePosSale({managerApproved: true})` and take any over-cap discount
        with nobody at the keypad: the PIN pad was a UI step, not a gate, and
        the rate limit on `verifyManagerPin` guarded a door you could walk
        around. The PIN check now MINTS a short HMAC token (over
        `POS_SESSION_SECRET`, reusing `session.ts`'s `signToken`/`verifyToken`
        so there is one signing implementation) and the sale VERIFIES it.
        Bound to four things, each of them a bypass the boolean allowed:
        store + location, the operator, a **fingerprint of the exact cart and
        discount** (so "₹50 off" can't be replayed as "₹5,000 off", or against
        another basket), and a 3-minute expiry — approval means "I am standing
        here looking at this sale", not "this cashier may discount all shift".
        The fingerprint hashes the CLIENT'S INPUTS, not the priced total: those
        are what both calls carry, and the charge derives from them plus DB
        prices the client can't touch. Lines are sorted, so a re-ordered cart
        doesn't void an approval that was really given. ⚠ Residual: inside
        those 3 minutes an identical cart could be rung twice on one approval —
        strict single-use needs a used-nonce table, and the manager is standing
        at the counter. This changes nothing under the default
        `pos.ownerOnlyDiscounts`, where staff discounts are refused outright
        before approval is ever consulted.
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
        opposed to the whole sale: **owner-only like any other discount** (the
        rule above), capped server-side at the line's own gross, and — when a
        merchant has handed discounting to staff — counted toward the
        manager-approval cap together with the order-level discount (so a
        cashier can't stay under it by splitting the giveaway).
        Persisted in `order_items.line_discount`
        (`supabase/pos_07_line_discount.sql`) — `total` stays net of it, so
        existing readers are unaffected, and the thermal receipt prints
        "2 × ₹100 … ₹200 / Less −₹30 = ₹170" instead of arithmetic that
        doesn't add up. Recording it also makes markdowns auditable per
        cashier, which is the point of the cap.
      - **A register sale is a SALE — it emits like one.** `placePosSale` ends
        with `emitEvent("order.placed")` + `reportStockChanges` (§22
        notifications). Without them an in-store sale wrote an `orders` row and
        nothing else: no `/dashboard/logs` entry, no team alert, and no
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
    - **★ THE SHELL (done) = one navigation, and one counter.** The screens were
      built one at a time and each brought its own chrome; this is the pass that
      made them one app. Nothing about permissions, money or stock changed.
      - **★★ THE NAVIGATION IS IN THE LAYOUT, FOR THE IDLE LOCK'S REASON.**
        `app/pos/pos-nav.tsx` is mounted once in `app/pos/layout.tsx` and takes
        `children` — it IS the shell, because the rail and the small-screen top
        bar sit at different points in the tree and a component rendering only
        one would leave each screen to place the other. That is per-page opt-in,
        which is exactly how the lock ended up missing from five of seven
        screens. Before: `/pos/sell`'s header held TEN things (four links, cache
        chip, coverage, Edit layout, location, operator, Lock) and hid every
        label below `sm`, so it degraded to a row of anonymous icons; the other
        five screens had a back arrow to `/pos` and nothing else, in three
        different hand-rolled forms; Stock → Drawer was three taps through a
        page whose entire content was "You're signed in".
      - **★ RAIL ON WIDE, DRAWER ON NARROW.** A hidden menu costs a tap on every
        switch and till work is muscle memory, so above `lg` the destinations
        stay on screen (76px rail); below it the same list is the hamburger
        drawer, because a portrait tablet cannot spare the product grid.
      - **★ `lib/pos/nav.ts` IS THE REGISTRY** — pure and icon-free (icons live
        in the client component, keyed by `key`, the `lib/logs/failure-types.ts`
        split) so a server component and a test can import it. `posNavFor(role)`
        filters on the SAME `posCan` the pages redirect on, so the rail and the
        gate cannot drift. **A destination's `cap` is the capability that opens
        the SCREEN, never the strongest action on it**: Orders is `sell`,
        because handing a collection over is a cashier's job with the customer
        standing there — gating that door on `refund` would hide the queue from
        the person who works it. Tested, both directions. (The key and label are
        `pickups`; Orders was its first name.)
      - **★★ COLLECTIONS AND RETURNS MERGED INTO `/pos/pickups`.** They were two
        search screens for one physical moment — a customer at the counter with
        an order that already exists. `/pos/pickups` searched a collection code
        or an order number; `/pos/returns` searched an order number, a phone or
        an email; **neither could find what the other could**, so a cashier had
        to know which kind of visit it was BEFORE they knew which order it was.
        One box now takes all of it and each row offers what that order can do
        AND what this operator may do (`Mark ready` = `fulfil_pickup`,
        `Hand over` = `sell`, `Take return` = `refund`, every one re-checked in
        the action). It is the queue's own ONE-BOX-TAKES-BOTH rule for scanned
        codes carried one step further. Only the operator's permitted lookups
        fire — a cashier has no `refund`, so `findOrderForReturn` is never
        called for them.
      - **★ IT IS CALLED PICKUPS, NOT ORDERS** (owner's call, 2026-08-12, after
        it shipped as Orders). Shopify POS names the equivalent screen Orders
        and that was the case for it, but in THIS rail it sat two rows above
        "Sales" and both read as "the things we sold". The label names the job
        the screen exists for. `/pos/orders` 307s here.
      - **★★ TWO DOORS, ONE SEARCH.** `/pos/pickups` and `/pos/returns` are both
        `counter-client.tsx` with a different `mode`, and Returns has its own
        rail entry. Discoverability and lookup are separate problems: someone
        holding goods a customer just handed back would not think to tap
        "Pickups", so Returns needs a name — but giving it a second SEARCH would
        rebuild exactly what the merge removed, because a customer hands over a
        number without announcing which kind of visit it is. The mode changes
        only what is on screen BEFORE you search: Pickups opens on the queue,
        Returns on a prompt (there is no returns queue at a till — a return
        starts when someone walks in). Either door finds everything.
      - **★ RETURNS IS THE ONE DESTINATION GATED ABOVE `sell`** (`refund`), so a
        cashier never sees it and `app/pos/returns/page.tsx` re-checks for
        anyone typing the URL — with an explanation, not a redirect, since a
        manager sending them there should see why. Pickups stays on `sell`: its
        door is handing collections over, which IS a cashier's job.
      - **★★ THE QUEUE IS SECTIONED BY WHO IT IS WAITING ON** — "To prepare"
        (`awaiting`) above "Ready to collect" (`ready`), each with its count.
        One flat list hid two opposite states behind a small badge: orders
        nobody has packed, which are work for STAFF right now, and packed
        parcels waiting on a CUSTOMER to walk in. A shop had to sort them by
        eye every time. SEARCHING stays one flat list, deliberately — when you
        are hunting one order, splitting three hits across headings makes you
        read all of them. An `others` section catches any future
        `pickup_status` rather than dropping it silently off a work queue.
      - **The old paths still resolve** (`/pos/orders`, `/pos/returns` → 307),
        because `revalidatePath` calls and `docs/pos-acceptance.md` name them.
        **307, not 308** — a permanent redirect is cached by browsers
        indefinitely and there are no SEO signals to consolidate behind a login
        (the trap `proxy.ts` works around with `Cache-Control: no-store`, §30).
        The return DETAIL screen stays at `/pos/returns/[orderId]`; only the
        front door moved, and `activePosNavKey` keeps Pickups lit on it.
      - **`/pos` OPENS THE REGISTER.** It redirects to `/pos/sell`; the only
        screen left there is the device-authorization prompt
        (`authorize-client.tsx`), and staff cannot resolve as an operator
        without an authorized device, so whoever sees it can fix it.
        `register-home.tsx` is deleted.
      - **★ THE BADGE IS A COUNT, NOT THE QUEUE READ** (`lib/pos/pickup-count.ts`).
        It is drawn by the layout, so it runs on EVERY POS page load including
        `/pos/sell`, whose whole design goal is a register that opens without
        waiting on the network — one indexed COUNT, not two queries and 100 rows
        with their line-item counts. It **fails to zero rather than throwing**: a
        blip must cost a badge, not the ability to serve a customer. NOT a
        `"use server"` file — it takes a store and a location as arguments, the
        exact shape that must never be publicly callable. `pickup-count.test.ts`
        pins its predicate to `getPickupQueue`'s, because a badge that disagrees
        with the list under it is worse than no badge.
      - `app/pos/pos-screen.tsx` is the shared chrome for every screen that is
        not the register (title, subtitle, scroll body). **No back button**, by
        design — the rail goes anywhere in one tap, and back-to-`/pos` was what
        made every switch a three-tap trip. The ONE exception is the return
        detail: that is a step in a flow, not a destination. Three screens also
        stopped painting `bg-neutral-950` over the shell's `bg-[#0b0f14]`, and
        the return detail's action bar went `fixed inset-x-0` → `sticky`, which
        with a rail on screen had been running underneath it.
23. **Locations own capabilities; POS is one of them.** Locations used to live
    under Point of Sale. They don't: a warehouse is a location with POS
    switched off, and pickup/online-fulfilment/returns are storefront features
    that merely depend on a location. So **`/dashboard/locations`** is its own
    Workspace section (above Point of Sale), `/dashboard/pos/locations`
    redirects to it, and `pos-location-actions.ts` became
    `location-actions.ts`. Full design: `docs/locations-ia.md`; the phased
    build: `docs/inventory-fulfilment-roadmap.md`.
    - **★ `lib/locations/address.ts` — TWO address shapes, and they are not
      the same.** A customer address (`customer_addresses`,
      `orders.shipping_address`) uses `addressLine1`/`addressLine2`/`country`/
      `phone`; a LOCATION's (`store_locations.address`) uses the five fields
      its editor writes — `line1`, `line2`, `city`, `state`, `postalCode`.
      Reading one with the other's keys fails SILENTLY: every field comes back
      undefined and simply doesn't render, which is how the shopper's "Collect
      from" card dropped the street line of every shop with no error anywhere.
      `locationAddressLines` (a card) and `formatAddressLine` (one line, for an
      email row or event payload) are now the only two readers, pure and
      tested — checkout and `pickup.ts` each carried their own byte-identical
      copy of the joiner before.
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
      - **★★ THE COUNTER IS ALSO WHERE THE MONEY ARRIVES, AND IT WAS
        INVISIBLE** (fixed 2026-08-06). `markCollected` flipped
        `payment_status` pending → paid for a `pay_at_store` order and wrote
        **no `order_payments` row and no `orders.shift_id`**. Shift
        reconciliation reads cash as `order_payments` INNER JOIN orders ON
        `shift_id` (only `placePosSale` ever inserted one), so the notes were
        physically in the drawer and contributed **0** to `expectedCash`: every
        drawer reported OVER by the full value of every collection it took,
        every shift, and the same join left those sales out of the Z-report's
        count and gross. It is the mirror of the two bugs `lib/pos/shifts.ts`
        already guards — double-counted change and cash refunds — which both
        reported SHORT.
      - **★ WHO PAYS WHEN IS THE MERCHANT'S CHOICE** — `fulfilment.pickupPayment`
        (`customer_choice` | `prepaid` | `at_store`, defaulting to the first
        because that is today's behaviour, invariant 1). The rule lives in
        `lib/fulfilment/payment-policy.ts`, pure and tested, and **the same
        function answers for the picker and for `placeOrder`** — the checkout
        screen asks it which controls to render, the server asks it whether the
        method that came back is allowed, so the UI can never offer something
        the server then refuses in front of a customer (the
        `RegisterConfig.canDiscount` rule from §22, applied to the other
        counter). Three things are load-bearing: **delivery is never touched by
        it** (a policy about collections says nothing about courier orders);
        **`prepaid` with no gateway offers NOTHING rather than falling back to
        pay-at-store**, which would serve the opposite of the merchant's policy
        — `canRequirePrepaid` refuses the setting at SAVE time so that state
        never exists; and `placeOrder` reuses its own gateway lookup for the
        check, which is only correct while `offline` is independent of
        `onlineAvailable` in `paymentOptionsFor` — a property with a test
        pinning it, because a future policy that broke it would silently start
        refusing COD orders.
      - **★ CHECKOUT DEFAULTS TO ONLINE WHEN A GATEWAY IS CONNECTED.** It was
        `useState<PaymentMethod>("cod")` with nothing reconciling it against
        `payConfig.onlinePayments`, so every merchant who connected Razorpay
        watched shoppers land on Cash on Delivery — the option that costs them a
        courier round trip and a collection risk, pre-selected by us. The
        default is now derived (`defaultPaymentMethod`) and applied in an effect,
        because the config arrives after first paint — guarded by a `payTouched`
        ref, since an effect that re-applied it would yank the selection out from
        under a shopper who had already tapped one. It re-applies ONLY when the
        current choice stops being offered (switching Delivery→Pickup under a
        prepaid policy), which would otherwise fail at `placeOrder`.
      - **★ `pay_at_store` IS NOT A TENDER, so the tender is CAPTURED, never
        assumed** (`lib/pos/pickup-payment.ts`, pure + tested). It is a promise
        recorded at checkout, and the checkout copy says exactly that — "Pay at
        the counter when you collect your order" — deliberately silent on the
        instrument where COD's, beside it, says cash. The customer may well
        hand over a card. Booking every collection as cash would put card money
        into expected cash and report the drawer SHORT: the same defect pointed
        the other way, and worse, because "over on cash, short on card" cannot
        be attributed to anything. `/pos/pickups` shows the amount owed on the
        row and opens the register's own `TenderPanel` (cash/card/UPI, split
        tenders, change) before handing over. It is the rule §26 and §28
        already state for refunds, read backwards: **the tender decides where
        the money goes.**
      - **★ COVERAGE IS CHECKED BEFORE THE CLAIM.** Claiming
        awaiting/ready → collected and THEN refusing the payment is the one
        outcome with no recovery — the order reads as collected and nothing was
        ever taken — so `markCollected` reads what is owed first, settles the
        tenders against it, and only then claims. The claim still decides
        exactly-once: a second tap matches zero rows, so it cannot write a
        second payment for money handed over once. Tenders on an order that
        owes nothing are REFUSED, not ignored — recording them would inflate
        expected cash with money nobody handed over.
      - **★ THE SHIFT STAMP IS ONLY FOR MONEY TAKEN HERE.** An order paid
        online weeks ago that happens to be collected during this shift never
        touched this drawer, and stamping it would pull its whole total into
        the Z-report's gross as takings the till never took. With no shift
        open, the SAME `pos.requireOpenShift` rule the sell path applies —
        taking payment at a counter IS selling, so the money gets exactly the
        home a counter sale's money gets (refused, or unattributed, per the
        merchant's own setting). Inventing a third policy here is how the two
        counters drift apart. A prepaid collection never consults it: no money
        changes hands, and blocking it would refuse a customer their own
        paid-for goods.
      - `lib/pos/tenders.ts` holds the tender vocabulary, the
        **allowlist** and the coverage/change math, extracted from
        pos-sale-actions.ts once a second counter took money. The allowlist is a
        SECURITY boundary (it is why `gift_card`/`store_credit` are refused —
        there is no ledger behind them), and a second hand-written copy is how
        an unsettleable tender gets accepted at the one counter nobody audited.
        It lives in `lib/` because a `"use server"` file may only export async
        functions, and everything it exports is a public endpoint.
      - **Expiry cancels, it does not refund.** `sweepExpiredPickups` claims
        awaiting/ready → expired per order, then releases the holds (that
        order, so a hand-over racing the sweep can't lose). Refunds wait for
        the returns machinery that records them (roadmap Phase G) — quietly
        moving money on a schedule ahead of that is not a thing to build.
      - **★★ THE COUNTER KNOWS WHAT A COLLECTION CAN STILL DO**
        (`lib/pos/collection-state.ts`, pure + tested). `markCollected` has
        always scoped its read to `pickup_status in ('awaiting','ready')`, so
        the SERVER could never hand over an expired or already-collected order.
        The SCREEN did not know: `findPickupByCode` has no status filter (by
        design — see below) and the row drew "Hand over" unconditionally, so
        scanning a cancelled order's code produced a full-strength green button
        that could only fail, in front of the customer. Exactly the anti-pattern
        the discount fields and the BORIS cash button already exist to avoid.
        Three states now: `collectable`, `lapsed` and `gone`.
      - **★ `lapsed` IS STILL COLLECTABLE, AND THAT IS THE POINT.** The sweep is
        DAILY, so between `pickup_expires_at` passing and the cron running there
        is a window of up to 24 hours in which the server will happily hand the
        order over — and should, because a customer a few hours late should
        simply be served. The row previously showed "Expired" beside a live
        green button with nothing saying which to believe; it now drops the
        contradictory countdown and says "The hold period has passed, but this
        can still be handed over."
      - **★ A `gone` ORDER STILL RENDERS — it just stops offering actions.**
        Filtering expired orders out of the lookup would swap a failing button
        for "No collection found for that code", which is a LIE and leaves a
        customer at a counter with an order the shop can see and cannot explain.
        The row renders dimmed, with no buttons, no "₹45 to pay" (nothing is
        owed on something that will not be handed over), and a note that says
        what happened — including **where the stock went**, which is the
        merchant's next question and is not obvious from "cancelled". It
        replaces `markCollected`'s old catch-all guess, "It may already have
        been collected", which was given AFTER the tap and was wrong whenever
        the real answer was expiry.
      - **★ `findPickupByCode` RETURNED ZEROES FOR MONEY AND ITEMS.** Both were
        hardcoded 0 on the reasoning that a scan "lands on the order itself,
        where the caller re-reads what it needs" — but nothing re-reads: a
        scanned order renders through the SAME row as the queue. So a
        pay-at-store collection scanned at the counter drew "Hand over" instead
        of "Take payment" and skipped the tender pad, and every scanned order
        read "0 items". No money could be lost (markCollected re-reads what is
        owed and refuses an uncovered hand-over), but the button described the
        wrong action. It now returns the real `amountDueAtCollection` and a real
        count, and does NOT default a missing status to `awaiting` — that would
        present a dead order as live, which is the whole defect.
      - ⚠ **Staging never sweeps.** Every Cloud Scheduler job targets
        `storemink.com` (docs/cron-jobs.md), so an expired collection sits in
        the staging queue indefinitely. That is the `lapsed` state, permanently
        — useful for testing it, and not a bug.
      - **★ A COLLECTION CODE, AND WHY IT IS NOT THE ORDER REFERENCE**
        (`lib/fulfilment/collection-code.ts`, pure + tested;
        `orders.pickup_code`, locations_11). Minted at checkout for collections
        only. It is a **LOOKUP key, not a bearer token** — access control stays
        UUID + store scope (§14) and the counter operator is already
        authenticated — but it is RANDOM, because `order_ref` is sequential and
        guessable and anyone at a counter could otherwise name somebody else's
        collection. **Crockford base32**: the alphabet drops I, L, O and U, the
        characters people misread off a phone screen in a shop, and
        `normalizeCollectionCode` folds those confusions back in, so a customer
        reading "0" as "O" still finds their order.
      - **★★ THE EMAIL LEADS WITH THE CODE, NOT THE QR.** Gmail strips `data:`
        URIs in `<img>` and every major client blocks remote images by default,
        so a QR embedded in email is a broken-image icon on the one screen a
        customer holds up at the counter. The code goes out as TEXT (always
        renders, can be read aloud) and links to `/orders/[id]/collect`, which
        draws the QR client-side via `BrowserQRCodeSvgWriter` — already a
        dependency for camera scanning, so no new package. That page is
        owner-gated and `noindex`, and the code in text is never conditional on
        the QR rendering: if the writer fails, eight characters still work.
      - **★ PICKUP ALERTS DEFAULT TO THE SHOP THEY HAPPENED AT.**
        `EventDef.defaultScope` lets an event pick its own routing fallback, and
        the four pickup-specific events (`ready_for_pickup`, `collected`,
        `pickup_expiring`, `pickup_expired`) default to `event_location`: a
        collection is physically at one shop, so the people who can act on it
        are the ones standing in it. **`order.placed` deliberately does NOT** —
        it fires for every order including deliveries, so narrowing it would
        change who hears about ordinary orders for every existing store
        (invariant 1). A merchant's own stored choice always beats the default;
        the fallback only applies when they have chosen nothing.
      - **★ ONE BOX AT THE COUNTER TAKES BOTH.** `/pos/pickups` resolves a
        scanned collection code OR a typed order number from the same input —
        a hardware scanner is a keyboard, and making someone pick a field first
        is exactly the friction the code was meant to remove.
        `isCollectionCode` is a cheap shape check, so a scanner pointed at a
        milk carton never becomes a database lookup, and a code belonging to a
        sister branch names THAT branch rather than returning "not found".
      - **★ MANAGER MARKS READY; CASHIER HANDS OVER** (`fulfil_pickup`).
        Marking ready is what tells a customer to travel, so it belongs to
        someone who has seen the box; handing it over is a cashier's job with
        the customer standing there, so `markCollected` stays on `sell`.
        Tightening this was only safe because no store had pickup enabled when
        it shipped (owner confirmed 2026-08-09) — invariant 1 is satisfied by
        there being no live behaviour to preserve. ⚠ `markReadyForPickup` had
        **no test coverage at all** before this; it does now, in both
        directions.
      - **★ THE SHOPPER'S PAGES SPEAK COLLECTION**
        (`(pages)/orders/order-status.tsx` — pure helpers + tests). A pickup is
        not a delivery with a different address, and these pages used one
        vocabulary for both. (1) The tracker read **Order placed → Being
        prepared → On the way → Delivered**, so a collection could never
        advance past step two (nothing ships) and its last two steps described
        a van that was never coming; `orderProgress` gives pickup its own
        **… → Ready to collect → Collected**, driven by `pickup_status`, which
        is where the till writes. (2) Hand-over writes `status: "completed"`,
        which is NOT in `ORDER_FLOW` — so `indexOf` returned −1 and a finished
        order rendered with every step un-started, under a pill showing the raw
        enum. (3) `pickupNote` quotes **`pickup_ready_at`**, the date promised
        at checkout, not just whether a human has pressed Ready: reading only
        `pickup_status` (which stays `awaiting` until the till acts) meant a
        same-day store said "Available today" at checkout and "we'll let you
        know as soon as it's ready" one screen later. (4) A **Pickup badge** on
        both list and detail, because "Order placed" looks identical whether a
        van is coming or the shopper has to drive over — `getMyOrders` selects
        `fulfilment_type`/`pickup_status` for it, having had no idea before.
        Dates pin `timeZone: "Asia/Kolkata"`, the §24 reason: these render on
        the server, where the zone is UTC on Cloud Run. ⚠ The DASHBOARD is
        still pickup-blind (pos-acceptance §11).
      - **★ A COLLECTION IS VISIBLE EVERYWHERE AN ORDER IS.** Three surfaces
        knew nothing about `fulfilment_type`, and each failed differently.
        (1) The **success page** showed only an order reference — no shop, no
        address, no deadline — at the moment the shopper most wants all three;
        it is a SERVER component now (`searchParams` prop + `getMyOrder`), so
        the collection card is in the first paint rather than flashing in, with
        the reconcile-on-read effect (§18) split into `reconcile-payment.tsx`.
        (2) The **invoice** printed the customer's home address under "Ship
        To" on an order nothing was ever sent to; it renders **"Collect From"**
        with the SHOP's address instead, and the customer party now always
        renders for a pickup — otherwise turning off `showBillingAddress` left
        the invoice naming no buyer at all, because the only place they
        appeared was the block a pickup doesn't have. (3) The **dashboard**
        list gained a Pickup badge + the collection stage under the status
        pill, and the drawer a Collection section (shop, address, ready date,
        hold deadline) with the customer block relabelled "Customer" — their
        address is not a destination. `ORDER_LIST_COLUMNS` /
        `ORDER_DETAIL_COLUMNS` carry the pickup fields; merchant-voiced labels
        live in `app/dashboard/orders/pickup-badge.tsx`, kept apart from the
        shopper's wording for the same reason `CUSTOMER_STATUS_LABEL` is.
      - **★ THE SHOPPER SEARCHES THE SHOP LIST; THE MERCHANT DOESN'T PREDICT
        IT.** Every shop with the goods is offered, and the checkout picker
        filters the list by postcode, city or shop name as they type. To keep a
        specific shop off the list, turn off its `pickup` capability — that
        route always existed.
        ⚠ **`pickup_pincodes` was built (`locations_07`) and REMOVED
        (`locations_08`); `lib/locations/pincodes.ts` is deleted.** It let a
        merchant list the postcodes each shop collects to and hid pickup from
        anyone outside them. It was reverted because the design argued against
        itself: it needed a "Collecting somewhere else?" escape hatch precisely
        BECAUSE hand-typed lists have gaps — and a shopper's DELIVERY postcode
        is a guess at where they are, never a fact about where they will drive.
        People collect near work, near family, on a route home; the merchant
        cannot predict that and shouldn't be asked to. Nothing was lost in the
        drop, because the column only ever decided what was OFFERED, never what
        was permitted — `placeOrder` validated capability, store and stock then
        and still does, and deliberately never refused on geography. Recorded
        here so it isn't re-proposed as a new idea.
      - **★ THE NUDGE IS A CLAIM, NOT A SCHEDULE.** `sweepPickupReminders`
        warns 48 hours out (`PICKUP_WARN_HOURS`, which must stay ≥ TWICE the
        cron interval: window and schedule are not in phase, so the notice an
        order gets is (W − I, W] — at W = I nothing slips through unwarned, but
        an order expiring just after a run is warned just before it lapses, and
        it spends the one email the claim allows) and claims
        `orders.pickup_warned_at` NULL → now() in
        the same conditional UPDATE it selects with
        (`locations_06_pickup_reminder.sql`). The cron is a HEARTBEAT — it
        re-reads the same rows every run — and `notifications`' UNIQUE on
        (event, recipient) cannot dedupe this because every emit creates a NEW
        event row. Without the claim, a merchant mails the same customer about
        the same box daily, which is how people learn to ignore their email.
        Reminders run AFTER the expiry sweep: an order that just lapsed is no
        longer awaiting collection, and telling someone to hurry and collect
        something already cancelled is worse than saying nothing.
    - **★ METERED EXTRA LOCATIONS (Phase 7, done).** Pro includes 2; more are
      ₹1,000/mo (₹10,000/yr) by default, and **a platform operator sets the
      live price from the console** — `plan_prices`, key `extra_location`
      (`supabase/plans_05_extra_location_price.sql`), edited in the same
      Pricing panel as the tiers. `EXTRA_LOCATION_PRICE` in `lib/plans.ts` is
      only the fallback until one is set, the way `PLAN_META` is for tiers.
      **★ IT IS PRICED LIKE A TIER BUT IS NOT ONE.** `resolvePricing` keys off
      `PLAN_IDS` and so ignores this row — which is what stops it rendering as
      a fourth card on the public pricing page that somebody could try to
      subscribe to. `resolveExtraLocationPricing` reads it instead, and the two
      share one query. Widening `resolvePricing` to accept arbitrary keys is
      exactly the change that would break this; there is a test pinning it.
      The add-on has no `base_*` price because it has no card to strike
      through — `savePlanPricing` forces those null rather than storing a
      number nobody can ever see. **Charging reads LIVE**
      (`getExtraLocationPricingLive`), never the cached loader: a location is
      bought against an already-authorised mandate, so quoting from a cache a
      reprice has not reached would debit the old amount.
      **⚠ `EXTRA_LOCATION_KEY` LIVES IN `lib/plans.ts`, NOT `lib/plans/pricing.ts`.**
      That module is `server-only` — it pulls in the db client, and therefore
      `pg` and `fs` — while the operator's Pricing panel is a CLIENT component
      that needs the key at runtime to tell the add-on row from a tier. Defining
      it there fails the BUILD while typecheck passes happily, which is what
      makes it worth writing down. The TYPES may still come from `pricing.ts`;
      those are erased. Same split as `lib/logs/failure-types.ts` and
      `lib/themes/meta.ts`.
      - **★★ AN EXTRA LOCATION IS A PRICE RISE ON THE SAME SUBSCRIPTION, NOT A
        SECOND ONE** (`lib/plans/location-billing.ts`, pure + tested). A second
        mandate would make the merchant authorise autopay twice and then let one
        succeed while the other halts; per-cycle add-ons would need a charge
        added at every renewal forever. Folding the cost into the plan AMOUNT
        means the existing machinery already covers it: `razorpay_plans` is
        keyed on **(plan, period, amount)**, so a different location count
        resolves to a different cached plan id with NO new table;
        `planForRzpPlan` still maps it back to (tier, period) for the webhook,
        because neither changed; and `decidePlanChange`'s rule applies
        unaltered — **buying prorates now, releasing waits for the cycle end** —
        which keeps refunds out of the system (§15b's reasoning, reused).
      - **★ `store_subscriptions.billed_locations` IS ADDITIVE, NEVER A TOTAL**
        (`supabase/subscriptions_03_billed_locations.sql` — its OWN file, per
        §15b's never-edit-an-applied-`CREATE TABLE IF NOT EXISTS` rule). The
        allowance is `included + billed`, so if Pro's included count ever rises,
        a merchant paying for one gains headroom rather than being billed for
        what became free. Backfilled 0, which is the honest value: nobody has
        ever been able to buy one (invariant 1).
      - **★ THE COUNT IS ABSOLUTE, NEVER A DELTA.** Two tabs each pressing "add
        one" against a delta buys two, and the merchant finds out on their card.
        An absolute target is idempotent — the second request no-ops.
      - **★ IT IS WRITTEN ONLY WHEN THE CHANGE IS LIVE.** Persisting a scheduled
        RELEASE immediately would drop the allowance while they are still paying
        for that location, refusing them a shop they own until the cycle ends.
      - **★ `changePlan` CARRIES THE COUNT THROUGH.** Resolving a tier change
        without it would silently drop the merchant to the bare plan price while
        they keep every shop — a leak invisible from both sides. It is zeroed
        only when the TARGET tier has no POS (charging for something the plan
        cannot use is indefensible), and the stored count is deliberately NOT
        written back, so returning to Pro resumes billing for the shops they
        still hold rather than handing them over free.
      - **★ THE MANDATE CEILING IS CHECKED BEFORE THE GATEWAY.** It was fixed
        when autopay was authorised and cannot be raised without the merchant
        re-authorising; Razorpay would accept the plan change and then fail the
        DEBIT weeks later, surfacing as a halted subscription rather than as
        "you can't buy this". `mandateMaxPaise` now carries room for
        `MANDATE_LOCATION_ALLOWANCE` (10) locations — well below
        `MAX_EXTRA_LOCATIONS` (50) on purpose, because this number is shown to
        the merchant on the mandate screen and quoting a ₹6 lakh ceiling for a
        ₹5,000/month plan loses the signup.
      - **Refused, not clamped, in both directions.** Silently raising a request
        charges for a number nobody chose; silently lowering one leaves them
        paying for a release they believed went through. Releasing below the
        locations in USE is refused outright — soft-on-downgrade means never
        deleting a shop on the merchant's behalf.
      - Merchants buy and release on `/dashboard/locations`
        (`location-billing-card.tsx`); `getLocationBillingState` feeds it and
        explains WHY the controls are absent when they are (a comped Pro store
        has no mandate to raise, so it is told plainly rather than shown a
        button that fails at the gateway).
    - **Not yet built:** Twilio receipts (Phase 6), omnichannel/BOPIS (8),
      offline outbox (9). See `docs/pos-plan.md` and `docs/roadmap.md`.

24. **Notifications & email — one event log, registry-driven fan-out, one way
    out.** **📖 Full guide: `docs/notifications.md`** (mental model, where each
    decision lives, how to add one, troubleshooting). This section restores the
    summary the POS merge overwrote.
    - **EVERY action emits an EVENT** into append-only `activity_events` — the
      audit trail, complete by construction, rendered at `/dashboard/logs`.
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
      intended, not duplication.
    - **CUSTOMER TRANSACTIONAL COPY IS HAND-WRITTEN.**
      `CUSTOMER_BLUEPRINTS` in `default-templates.ts` covers the complete
      customer order, pickup, cancellation, return, exchange, refund and blog
      journey. It leads with the decision, shows only the facts that matter and
      never claims money moved before `order.refund_issued` says it did. Pickup
      mail makes the collection code the focal point. The action-heavy team
      paths (new order, cancellation, failed payment, return and stock alerts)
      have their own `TEAM_BLUEPRINTS`; lower-risk team events keep the compact
      generated report. Store/domain milestones remain bespoke prose.
    - **ONE SENDER PER MESSAGE.** Where a dedicated sender exists the registry
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
    - **EMAIL LOGS** at `/dashboard/logs/email-logs` (a child of Activity
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
      The platform console exposes the platform scope at
      `/dashboard/email-logs`; `signup_otp` and `signup_test_otp` are deliberately
      retained in full (owner decision, 2026-08-12) so an operator can complete
      assisted or dummy-store signup. Both are platform rows, never enter a
      merchant log, and the read actions independently require platform-operator
      membership before returning platform-scoped rows. Password-reset and
      staff-invite credentials remain redacted.
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
    - **★ FORMAT ONCE, AND ONLY FROM THE STORED SHAPE.** `{{date}}` was the one
      value that arrived at `templateValues` ALREADY formatted — the envelope
      passed `new Date().toLocaleString("en-IN")` — so `formatVariable` ran over
      it a second time and misread the first: V8 parses "5/8/2026" as **M/D/Y**,
      so an order placed on 5 August 2026 was confirmed to the customer as
      **"8 May 2026"**. Past the 12th it doesn't parse at all, and the raw
      "28/7/2026, 12:20:46 am" fell through to the email — the exact string the
      bullet above cites as fixed. The envelope now carries ISO, like every
      other value. **`formatDate` also PINS `timeZone: "Asia/Kolkata"`**: without
      it the render uses the system zone, which is UTC on Cloud Run, so a 3:12 pm
      order was confirmed as "9:42 am" with nothing to say it wasn't local (the
      India-first default the dashboard tables already use, until per-store
      timezones exist). Tests run under `TZ=UTC` to prove the pin holds.
    - **★ A LABEL WITH NOTHING UNDER IT IS WORSE THAN NO ROW.** The default
      email's fact list is generated from the variable CATALOG, which declares
      everything an event COULD carry — so an emitter that supplies none of it
      doesn't produce a shorter email, it produces empty labelled rows. A
      "Ready to collect" notice went out with **"Pickup location"** and
      **"Pickup address"** above blank space, on the one message in the pickup
      flow whose entire job is an address. Two fixes: `markReadyForPickup` /
      `markCollected` now pass the shop (read in the same statement that claims
      the row, so a name can't be fetched for a claim that didn't win), and
      `defaultEmailTemplate` takes the resolved `values` on a REAL send and
      drops any fact that came back blank. The console preview still passes
      none, deliberately — a preview shows which tokens EXIST, so it should
      show them all.
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
      rendered with whichever sorted first. The settings preview and test-send
      carry the active audience through the same renderer too; customer previews
      previously showed a staff CTA/footer even though the real queued message
      did not. Regression-tested in both directions.
    - **THE ORDER SUMMARY IS RENDERER CHROME** (`lib/email/line-items.ts`,
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
      declared, so a merchant who wants them can still use them.
    - **ONE GLOBAL EMAIL DESIGN** (`lib/email/shell.ts`): a neutral, table-safe
      shell, the store logo/name and one restrained brand accent. Notification
      CTAs use `emailAccentColor`, which preserves a valid merchant hue but
      darkens it until white text reaches WCAG AA contrast; malformed values
      fall back to ink. The same safe colour edges the notification card and
      links, while the content stays near-black on white. Mobile media rules
      tighten the card at 620 px, and the rendered order/pickup/refund/team-alert
      samples have no horizontal overflow at 390 px. Semantic template classes
      (`email-lead/details/detail/label/code/note`) are inlined for clients that
      strip styles and remain readable as ordinary HTML without them.
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

26. **Refunds — money out, and the one place a RETRY is dangerous.**
    Design + the full returns/exchanges plan this is step one of:
    **`docs/returns-exchanges-plan.md`** (roadmap Step 2).
    - **★ THE ROW IS WRITTEN BEFORE THE MONEY MOVES.** `gateway_refund_id` is
      UNIQUE, which makes the RECORD idempotent — but it cannot make the CALL
      idempotent, because you do not have a Razorpay refund id until the call
      returns, and **a timeout is indistinguishable from a success you never
      read**. So `refundOrder` inserts `order_refunds` as `pending` carrying an
      `idempotency_key` WE generated, sends that key to Razorpay as both the
      idempotency header AND inside the refund's `notes`, and only then claims
      `pending → completed|failed`. The `notes` copy is the load-bearing half:
      it still works if the header is ever unsupported or renamed, and it is
      what reconciliation looks the refund up by.
    - **★ AN UNKNOWN OUTCOME IS NOT A FAILURE.** `RzpResult`'s error arm carries
      `outcome: "rejected" | "unknown"` — a 4xx is a verdict (nothing happened,
      so fail the row and free the amount), a 5xx or a network throw is not (the
      refund may exist). On `unknown` the action returns `pendingReconcile` with
      **no error**, and the UI says "we're checking — don't send it again".
      Reporting it as a failure is precisely how a customer gets paid twice.
    - **THE CAP COUNTS PENDING REFUNDS.** `refundableAmount`
      (`lib/payments/refunds.ts`, pure + tested) excludes only `failed` rows. A
      refund in flight has not settled but might; ignoring it lets a second
      refund be raised for the same money. And the whole read-check-insert runs
      inside ONE `withService` transaction behind `SELECT … FOR UPDATE` on the
      order — two admins clicking Refund would otherwise both read the same
      headroom and both pass.
    - **★ A MONEY REFUND CANNOT EXCEED WHAT MONEY PAID.** `orders.total` is the
      full value of the GOODS and stays that way when part of it was settled
      with store credit (§29 — credit is a payment, not a discount), so `total`
      is NOT what any instrument received: a ₹500 order paid with ₹200 credit
      and ₹300 on a card only ever charged ₹300. Capping every method at
      `total` hands back ₹200 the store never took. Razorpay refuses a refund
      above its payment, but `cash` and `manual` have no backstop — the
      merchant simply counts out too much. So `refundableAmount` takes
      `storeCreditUsed` + `method` and applies a second cap to money methods,
      less what money has already gone back. Refunding AS CREDIT stays uncapped
      by this rule: a balance for a balance costs nothing that wasn't owed.
      Both arguments are optional and default to the old behaviour.
    - **MATCHED BY KEY, NEVER BY AMOUNT.** Two legitimate ₹500 refunds on one
      order are indistinguishable by amount, and settling the wrong row is
      unrecoverable. An unknown gateway status maps to `pending`, never to
      settled.
    - **RECONCILE-ON-READ + A CRON BACKSTOP** (`refund-reconcile.ts`), the §18
      decision unchanged — no webhook endpoint to secure. Opening the order
      settles it in practice; `/api/cron/expire-pending-payments` sweeps the
      ones nobody opens, on **both** its return paths (money out is a different
      queue from money in). `syncOrderRefundState` DERIVES
      `orders.payment_status` from refunds that actually settled, so a failed
      refund moves an order back off `refunded` instead of stranding it.
    - **`PAYMENT_STATUSES` IS SPLIT FROM `SETTABLE_PAYMENT_STATUSES`**
      (order-actions). `refunded` / `partially_refunded` are derived and must be
      FILTERABLE — the till has been writing `refunded` since pos_12 and the
      orders list treated it as invalid, so merchants could not find their own
      refunded orders — but not SETTABLE, because picking one asserts money went
      back with no `order_refunds` row saying so. The drawer renders them as a
      read-only pill, and `updateField` now sends `paymentStatus` only when it
      is what changed (echoing it back would fail every fulfilment edit on a
      refunded order).
    - **THE TENDER DECIDES WHERE THE MONEY GOES**, never a preference. Online
      orders offer the gateway; COD offers `manual` — a record of money the
      merchant moved themselves, with a **required** reference, because that is
      the only evidence such a row ever carries. There is deliberately no
      "refund as cash" on an online order: buy with a stolen card, return for
      cash is the card-not-present laundering path. RazorpayX payouts drop in
      later as one more `method`, no schema change.
    - **`orders.delivered_at`** stamped `coalesce(delivered_at, now())` so
      re-marking an order delivered cannot restart a return window. Nothing
      reads it yet — the returns settings do.
    - **A refund is NOT a restock** (roadmap invariant 8): returned goods may be
      damaged, and a cancellation has no goods at all. `pos_12_returns.sql`
      keeps `order_returns` and `order_refunds` apart; keep them apart.
    - **⚠ Never exercised against a live Razorpay account**, and the exact
      idempotency header name should be re-checked against their current docs.

27. **Cancellation — a REQUEST, then a decision** (roadmap Step 2, rebuilt
    2026-08-09). Design: `docs/roadmap.md` Step 2.
    - **★ ASKING IS NOT CANCELLING.** `cancelMyOrder` raises a request
      (`orders.cancellation_status = 'requested'`); a human approves it. Money
      and stock move on APPROVAL. It used to cancel outright the moment a
      shopper pressed the button.
    - **★ WHOLE-ORDER ONLY, AND DELIBERATELY SO.** No item-level cancellation,
      approval, refund or state anywhere in this flow — it would need partial
      fulfilment, which this system does not have. Owner decision; written into
      `lib/orders/cancellation.ts` and `approve-cancellation.ts` headers so the
      next reader does not "fix" it.
    - **★ ONE IMPLEMENTATION OF CANCELLING** (`lib/orders/approve-cancellation.ts`),
      shared by the merchant's Cancel panel, the Approve button, and the
      customer path under automatic approval. Claim the status conditionally →
      release stock (`lib/orders/cancel.ts`) → move the money → notify, in that
      order and for stated reasons.
    - **★ BOTH REFUND DESTINATIONS GO THROUGH `issueRefund`.** It already knows
      `store_credit` as a method, so using it for both gives an `order_refunds`
      row either way (keeping `refundDueForOrder` and `payment_status` correct),
      the refund cap on both, and pending-row-first idempotency. Calling
      `issueCredit` directly would credit a customer with no refund row behind
      it — money out the order does not know about. `later` moves nothing by
      design: it records the obligation.
    - **★ A FAILED REFUND IS NEVER A SUCCESS, AND AN UNKNOWN ONE IS NEVER A
      FAILURE.** The order is cancelled either way (the claim already
      committed), but `refundError` and `refundPending` are returned separately
      so the caller says which — §26's rule, reused.
    - **★ APPROVAL IS REQUIRED BY DEFAULT** (`orders.cancellationApproval`), and
      `normalizeApproval` resolves anything unknown to requiring it: automatic
      approval moves money with nobody looking, so it is never what a typo
      lands on.
    - **★ THE WINDOW IS A FIXED LIST, INCLUDING "UNTIL FULFILLED"** — a
      first-class rule, not a very long duration. A shop that packs in 20
      minutes and one that takes three days both mean "before we've packed it".
    - **★ A DECLINE CARRIES A REASON, ENFORCED SERVER-SIDE**, and the customer
      reads it verbatim (`order.cancellation_declined`). A silent no is the
      most complained-about thing a request flow does.
    - One active request per order, enforced by a conditional claim on
      `cancellation_status IS NULL`; a declined request cannot be reopened by
      asking again.

27b. **The original cancellation notes — and why nothing paid automatically.** The other half of
roadmap Step 2; design in `docs/returns-exchanges-plan.md` §10. - **★ CANCELLING NEVER MOVES MONEY, AND THAT IS THE FEATURE.** Auto-refund
on cancel was considered and refused — not even as a setting — for the
same reason §22 gives for owner-only discounts: money leaving with no
human looking at it is the one irreversible act with no physical trace.
So the OBLIGATION is made loud instead of automatic. - **`OrderRefundState.refundOwed`** turns the refund panel amber on a
cancelled order that was paid for. **Derived**, never stored: a flag
would need clearing on refund, on partial refund and on reinstatement,
and the one you forget is the one that nags a merchant forever. - **A CRON CANNOT PROMPT, SO IT TELLS.** `sweepExpiredPickups` computes
`refundDueForOrder` and rides `refund_due` into the
`order.pickup_expired` payload — the merchant learns it in the channel
they already read. `refund_due` had to be added to `MONEY` in
`lib/notifications/format.ts` or it would arrive as a bare `840` (§24's
"Total 281.4" failure), and declared in `variables.ts` to be a usable
`{{token}}`. - **`lib/orders/cancel.ts` is ONE implementation for TWO callers.** It was
inline in `updateOrderStatus`; a second hand-written copy for the
customer path would fail SILENTLY — stock simply never comes back, and
it surfaces in a stock count weeks later. It preserves both branches
exactly: reserved stock releases at the location that reserved it (a POS
sale must not restock at the store's default shop), and a pickup order
releases HOLDS because its units never left the shelf. - **★ `cancelMyOrder` — ONE BUTTON, TWO OUTCOMES, and the client decides
neither.** Stoppable (`pending`/`processing`, not collected, inside the
window) ⇒ cancelled outright + `order.cancelled` carrying `refund_due`.
Too late ⇒ `order.cancellation_requested` and the order is untouched. The
status is re-checked INSIDE the statement that changes it, so a dispatch
racing a cancel means one matches nothing rather than both "succeeding".
`withService` after the WHERE re-proves ownership + store scope, because
a shopper holds SELECT but not UPDATE on their own orders (convention
#12's model). - **The button does NOT disappear once an order ships.** Someone who wants
out still wants out, and hiding it just becomes a support email the
merchant handles by hand anyway. - Settings (group **Orders**, section `orders`, at
`/dashboard/orders/settings`): `orders.allowCustomerCancellation`
(**default OFF** — new behaviour on a live store, invariant 1) and
`orders.cancellationWindowHours` (24). Enforced server-side; a hidden
button is not a permission. - **★ `PENDING` in `lib/notifications/coverage.test.ts` IS NOW EMPTY.**
Every registry event has a real emitter;
`order.cancellation_requested` was the last one waiting. Keep it that
way — an entry there is a deliberate act, not a way to silence the guard.

28. **Returns — the policy surface.** Config + the pure rules; the request flow
    itself is NOT built (design + phasing: `docs/returns-exchanges-plan.md`,
    build order §7; what shipped: §11).
    - **★ "ONLY CERTAIN PRODUCTS" IS A COLUMN, NOT A SETTING.**
      `lib/settings/registry.ts` holds one boolean or number PER STORE and
      cannot address a single SKU, so `products.returnable` + optional
      `products.return_window_days` sit on the row, exactly like
      `tax_class_id`. Deliberately NOT a `return_profiles` table: tax classes
      exist because rates vary per product BY LAW and the buckets need naming;
      return rules rarely vary by more than "returnable or not, and for how
      long". The upgrade path is a nullable `return_profile_id`, which is
      additive.
    - **The window override is NULLABLE, never a copy of the store value.**
      Writing the store's window into each product at save time freezes it, so
      a merchant widening it later would silently not reach any product ever
      saved. For the same reason `0` is MEANINGFUL (same-day only) and survives
      a null check rather than `||`.
    - **★ A FEE IS NEVER CHARGED FOR THE MERCHANT'S OWN MISTAKE**
      (`lib/returns/reasons.ts`). `merchantFault` is the load-bearing field:
      damaged / defective / wrong item / not as described / arrived late waive
      fees WHOLESALE and put return postage on the store. A flat "10%
      restocking fee on everything" bills the customer for a parcel that
      arrived broken. Three guards fell out of it: the deduction is **capped at
      the goods value** (a ₹50 postage fee on a ₹25 item would otherwise
      compute a NEGATIVE refund); an **absent reason is not merchant-fault**,
      or anyone waives fees by not answering; and a photo is only asked for
      where one could **settle** the claim.
    - **The reason list is CODE, not a table.** Merchant-editable reasons make
      the data useless across two stores — "damaged" and "Damaged/Broken" can't
      be compared — and unlike a label this vocabulary carries BEHAVIOUR.
    - **★ ONE ELIGIBILITY ANSWER** (`lib/returns/eligibility.ts`), so the
      storefront badge, the request form, the review queue and the till cannot
      disagree. The window starts at POSSESSION — `delivered_at` →
      `collected_at` → `created_at` (POS only). Two decisions: **undelivered is
      not expired** (`not_yet_delivered` is its own answer; collapsing them
      tells someone their day-old order is too old to return), and it **FAILS
      OPEN** when a delivered order has no timestamp — refusing a genuine
      return because OUR backfill couldn't date a legacy row is the store's
      problem to absorb.
    - **Settings**: twelve `returns.*` keys, group Returns, section `orders`,
      at `/dashboard/orders/settings`. Almost all `dependsOn: returns.enabled`,
      so an unenabled store sees ONE switch rather than a wall of config.
      `returns.enabled` defaults OFF (invariant 1); `returns.allowInStore` is
      Pro (it needs POS). **Only two are enforced today** — `ownerOnlyRefunds`
      and `maxRefundWithoutApproval` gate `refundOrder` (§26) via
      `isStoreSuperadmin()`, and ★ the cap is re-checked INSIDE the transaction
      once the amount resolves, because an omitted amount means "refund
      everything left" and checking only `input.amount` is bypassed by leaving
      the field blank. The rest are consumed by Steps 3–5.
    - **Final sale is said BEFORE the sale**: a badge on both PDP layouts,
      shown regardless of whether returns are switched on, because it is a
      statement about that product and discovering it afterwards is how a
      return policy becomes an argument.
    - **THE REQUEST FLOW** (`app/actions/return-actions.ts`, both ends of the
      object in one file; `/orders/[id]` for the shopper,
      `/dashboard/orders/returns` for the merchant). A return is
      **requested → approved → received → completed**, or rejected/cancelled.
      It **never moves money**: approving says what is owed and a human presses
      Refund, the same rule cancellation follows (§27).
      - **★ `order_returns.status` DEFAULTS TO `completed`.** Every row that
        existed before the lifecycle is a till return that finished when it was
        written, and `pos-return-actions.ts` still doesn't set the column.
        Defaulting to `requested` would reopen every return the shop has ever
        taken. The lifecycle went on the EXISTING table for the same reason a
        sibling `return_requests` was rejected: a counter return and a posted
        one are the same fact by different routes, and two tables means every
        reader either joins both or silently ignores one.
      - **★ AUTO-APPROVE NEVER COVERS A FAULT CLAIM.** A merchant-fault reason
        waives every fee, so auto-approving it lets anyone opt out of a store's
        return charges with a radio button. Not a setting — it is what makes
        `returns.autoApprove` safe to offer at all.
      - **★ A REJECTION MUST CARRY A REASON**, refused server-side. The
        customer reads it verbatim; a silent no is the most complained-about
        thing a returns process does.
      - **★ ONLY `sellable` UNITS REACH THE SHELF**, and condition is decided at
        RECEIPT with the goods in front of someone — never at request time.
      - **★ Only OPEN statuses hold units** — `OPEN_RETURN_STATUSES` in
        `lib/returns/lifecycle.ts`, its own module because THREE layers have to
        agree. A rejected or cancelled request gives its quantities back, or
        one decline makes those items unreturnable forever.
        `countReturnedUnits` fails toward REFUSING (a DB error returns
        MAX_SAFE_INTEGER per line) because "we don't know" must never read as
        "nothing returned yet". ⚠ The till did NOT have this filter: it was
        written when every `order_returns` row was a finished counter return,
        so once the lifecycle landed, a customer whose online return had been
        REJECTED could not bring the goods in either — the dead request still
        counted against them.
      - **★★ THE QUANTITY CLAMP WAS PER-ENTRY, NOT PER-LINE** (found
        2026-08-04). `refundBreakdown` iterated the client's `request` array
        and clamped EACH entry against `remainingQty` independently, so
        `[{A,1},{A,1},{A,1}]` on a one-unit line passed three times and priced
        3× the money — in a SINGLE call, no race, from both the till and the
        storefront. It now coalesces by line id before clamping. This is the
        second time the same shape of bug has appeared here: like the `lpad()`
        truncation (§14), the cap READ as if it bounded the total while
        actually bounding each part.
      - **★★ NEITHER RETURN PATH TOOK A ROW LOCK.** `getReturnableSale` /
        `getReturnableOrder` answered "what may come back" outside any
        transaction, and the write trusted that answer. Two tabs, or one
        double-tapped Confirm, both read "1 unit left" and both booked it —
        reproduced on staging as **₹158 refunded against a ₹79 sale, 2 units
        returned on 1 sold**. Both now `SELECT … FOR UPDATE` the order and
        RE-PRICE inside the lock, which is what `issueRefund` has always done
        (and why the gateway path was never exposed).
      - **★★ THE TILL'S CASH REFUND HAD NO MONEY CAP AT ALL.** `processReturn`
        inserted its `order_refunds` row directly with `breakdown.total` and
        never consulted `refundableAmount` — that check lived only in
        `issueRefund`, which the counter tenders bypass by design (the money is
        already across the counter, so it is recorded in the same transaction
        as the goods). The quantity clamp bounded the GOODS; nothing bounded
        the DRAWER. It now checks the cap inside the lock.
      - **★ AN EXCHANGE OWES THE DIFFERENCE, NOT THE WHOLE LINE.**
        `order_returns.total` is what the merchant's queue prints and what the
        approval email quotes, and `requestReturn` stored the full goods value
        even on a swap — so a like-for-like exchange told the merchant to
        refund ₹1,050 while the customer's own screen, which calls
        `exchangeSettlement`, correctly quoted ₹0. Two ends of one object
        disagreeing about money is §22's `posTotals` failure again. The server
        now stores `settlement.storeOwes` less fees.
      - **★ PHOTOS ARE PINNED TO OUR BUCKET.** `sanitizePhotos` accepted any
        `https://storage.googleapis.com/` URL — a host shared by every GCS
        customer on earth, so an attacker's bucket rendered inside a merchant's
        dashboard next to a money decision. It now requires the `GCS_BUCKET`
        prefix (degrading to the host check when unset) and rejects `..`/`@`.
      - Customer RLS is `customer_id` **AND** store, the
        `pos_08_customer_order_store_scope.sql` pairing — a Firebase uid is
        global. Writes stay service-role.
      - **Not built:** photo upload (column + sanitiser + dashboard rendering
        exist; the storefront only warns one may be asked for), and per-line
        damaged marking at receipt (books in as sellable, like the till).
    - **★ AN EXCHANGE IS A RETURN PLUS A NEW ORDER**
      (`returns_03_exchanges.sql`, `lib/returns/exchange.ts`). A distinct
      `exchanges` table would add an "…or exchange" branch to every stock path,
      tax calculation, invoice and report forever; as two existing rows and one
      FK, the orders list, the invoice and fulfilment routing pick the
      replacement up unchanged. The target is per LINE, so one return can mix
      swapped and refunded items.
      - **★ A REPLACEMENT MAY NOT COST MORE.** Collecting a difference is a
        payment flow that doesn't exist outside checkout; half-building it
        leaves replacement orders `pending` forever. Refused at request time
        with a sentence telling the shopper to place a new order. It is the
        ARITHMETIC that decides, not a flag — `customerOwes` is still computed,
        so a future payment-link flow already has its number. Same-price swaps
        (the common case) settle to zero; cheaper ones refund the balance.
      - **★ THE PRICE IS SNAPSHOTTED AT REQUEST**, because weeks pass before
        the parcel arrives and re-reading it would bill someone for a
        repricing they were never quoted. The variant NAME is read fresh — a
        name change is cosmetic, which is why the asymmetry is deliberate.
      - **★ STOCK IS HELD WHEN THEY ASK, not when the merchant approves**, or
        the size sells out in transit and the exchange fails at the last step.
        A hold doesn't empty the shelf, it stops units being promised twice.
        Released on decline and withdrawal; committed against the new order at
        receipt, so units leave exactly once. `stock_status: 'none'` on the
        replacement — committing the hold IS the movement, and reserving again
        would take the same units twice.
      - **No coupon, no netted tax.** The replacement inherits the price paid,
        not the code; it is taxed at its own class while the return's tax is
        refunded from its snapshot. `payment_method: 'exchange'`,
        `payment_status: 'paid'` — paid for by the goods that came back, and it
        must never read as unpaid revenue to chase.
      - **Not built:** shipping the replacement BEFORE the return arrives (an
        advance exchange needs a card hold, and there is no hold primitive),
        and cross-product swaps.
    - **★ BORIS — RETURNING AN ONLINE ORDER AT A COUNTER**
      (`lib/returns/in-store.ts`, `/pos/pickups`). This is what finally reads
      the `returns` location capability, in the registry unused since Phase 0.
      - **The bug that made it impossible:** `getReturnableSale` filtered on
        `orders.location_id = op.locationId`, and an online order's location is
        its FULFILMENT one (or null), so the till could never find one. Now
        STORE-scoped, and the location question splits into the two it always
        was — whose shelf gains the stock (the shop they walked into) and
        whether this counter may accept it (`canTakeReturnHere`).
      - **★ A SALE RUNG AT THIS COUNTER IS ALWAYS RETURNABLE HERE**, regardless
        of the BORIS settings. Invariant 1: the till has done this since
        pos_12, and making it conditional on a later setting would break every
        shop doing it today. `returns.allowInStore` governs the NEW capability
        only.
      - **★ THE TENDER DECIDES WHERE THE MONEY GOES.** An online order refunds
        to the gateway and the till shows NO cash button — a control that
        always fails server-side, in front of a customer, is worse than no
        control; `isTenderAllowed` refuses it server-side anyway. Cash back for
        a card sale is the card-not-present laundering path. COD is the one
        case where cash at the counter is right.
      - **★ A gateway refund carries NO location_id and NO shift_id.** It never
        touches the drawer, and stamping a shift would make the cash report
        count money that never left the till.
      - **A failed gateway refund does NOT undo the return** — the customer has
        handed the goods over and is walking away with nothing, so the return
        stands and the till WARNS. `borisGates` fails CLOSED: refusing a return
        the merchant can take by hand is recoverable; accepting one at a
        counter that isn't set up puts stock on the wrong shelf.
      - **`lib/payments/issue-refund.ts`** is the extraction that made this
        safe — one refund mechanism, called by `refundOrder` and
        `processReturn` after their own authorization. A second hand-written
        copy of the pending-row-first idempotency is how someone gets refunded
        twice at a till where nobody is watching a log. It returns a stable
        `code` so each caller can advise its own audience.
      - **Not enforced at the till:** the return window and final-sale rules.
        Adding them would change what the counter does today (invariant 1), and
        the merchant is standing right there.
    - **★ GST CREDIT NOTES** (`returns_04_credit_notes.sql`,
      `lib/billing/credit-note-data.ts`). A legal document, not a receipt: it
      reverses output tax the store has already declared.
      - **★ THE SERIAL MUST HAVE NO GAPS, AND THAT DECIDES THE DESIGN.** A
        missing number is precisely what an audit flags, so it is allocated on
        **SETTLEMENT** — §26 writes the refund row `pending` before calling
        Razorpay, and a pending refund that fails would burn a serial. That
        ruled out app code: `completed` is reached from FOUR places (the till
        insert, issueRefund's non-gateway insert, its gateway claim, the
        reconcile sweep). It is a **TRIGGER**, the same reasoning convention
        #14 gives for order_ref and SKUs. `credit_note_no IS NULL` makes it
        exactly-once, so completed → failed → completed keeps the ORIGINAL
        serial rather than leaving the first as a gap.
      - **No note on an untaxed order** — nothing to reverse — and **NO
        BACKFILL**: inventing serials for historical refunds would fabricate
        documents dated to periods already filed.
      - The document names **the invoice it reverses**, carries its own `CRN…`
        ref (the §14 grammar, SQL mirror `sm_credit_note_ref` cross-checked by
        `lib/identifiers.test.ts`), and splits tax the way it was CHARGED via
        `splitGst`. All from the order's snapshot — a store that has since
        changed its rates must not reverse at the new one.
      - **A refund with no serial renders an explanation, not a blank page.**
        Both causes are correct behaviour, and a blank document looks like a
        bug and gets printed anyway.
      - Keyed by REFUND (`/dashboard/orders/credit-notes/[refundId]`), because
        one order can be refunded more than once.
      - **⚠ NOT reviewed by a CA**, the §25 posture. It covers the fields the
        format needs; get a professional to check it before anyone files.

29. **Store credit — a balance the store owes, spendable at checkout.**
    Design: `docs/returns-exchanges-plan.md` §16 (roadmap Step 4).
    - **Modelled on `ai_credits.sql`**, which already solves this here: the
      append-only `customer_credit_ledger` is the truth,
      `customer_credit_balances` is a cached sum with `CHECK (balance >= 0)`,
      and every mutation is a single conditional UPDATE. Issuing is idempotent
      per `(store, customer, kind, ref)`, so a double-confirmed refund credits
      once.
    - **★ `try_spend_customer_credit` puts `balance >= amount` INSIDE the
      UPDATE**, so two checkouts racing on one balance can't both pass a prior
      check-then-act and overdraw it.
    - **★ CREDIT IS A PAYMENT, NOT A DISCOUNT.** `orders.total` stays the FULL
      goods value and `orders.store_credit_used` records what was settled with
      credit; only the REMAINDER is charged. Netting it off would be wrong in
      three places at once — the invoice would understate the sale, GST would
      be computed on the wrong base, and the §28 credit note would reverse the
      wrong amount. Pinned by a test asserting the same basket writes the same
      total with and without credit.
    - **★ THE UNPAYABLE-REMAINDER GAP** (`lib/credit/apply.ts`, pure + tested).
      A ₹200.50 order against a ₹200 balance naively leaves ₹0.50 — which
      Razorpay refuses, so checkout would fail on an order the customer nearly
      had credit for. It only shows up when the balance lands within a rupee of
      the total. So LESS credit is applied, leaving a chargeable amount; the
      difference stays on the balance. Rounding UP to cover the order was
      rejected — it spends money they didn't agree to spend. Off for COD and
      the counter, which have no floor. The checkout summary calls the SAME
      function, so preview and charge can't disagree, and it says when credit
      was held back.
    - **Fully covered ⇒ `payment_method: 'store_credit'`, `paid`.** Otherwise a
      COD courier is told to collect ₹0 and the gateway is asked for an amount
      it refuses.
    - **Cancelling reinstates**, keyed on the order so a second cancel
      reinstates nothing rather than minting money. `reinstate` is its own
      ledger kind, not a second `grant`: a report that can't tell a returned
      spend from a goodwill gesture overstates what the store gave away.
    - **★ BUT A CREDIT REFUND HAS ALREADY GIVEN IT BACK** (found 2026-08-04).
      Refund-then-cancel is an ordinary sequence — settle with the customer,
      then mark the order dead — and the two halves knew nothing about each
      other, so a ₹500 order paid entirely with credit, refunded AS credit and
      then cancelled, left the customer holding ₹1,000. The idempotency keys
      cannot catch it: they are per (kind, ref), and these are a `refund` keyed
      on the refund and a `reinstate` keyed on the order. `reinstateCreditForOrder`
      now offsets by completed `store_credit` refunds on that order. **Only
      credit refunds count** — a cash or gateway refund returned the MONEY half
      and says nothing about the credit half, so netting those off would
      swallow a balance still owed. It fails toward reinstating: a customer
      silently losing their balance is worse than a visible over-credit.
    - **Spending never refuses a sale** (invariant 6) — a balance that moved
      means they pay the full amount, not that checkout fails.
    - **Offered, never forced** (§28's §3.3 rule): the refund panel shows it
      only when the order has a customer account, and tells the merchant to
      make sure the customer agreed to a balance rather than their money back.
    - **★ THE CUSTOMER CAN NOW SEE IT** (`app/actions/customer-credit-actions.ts`
      → `getMyCredit`, rendered by `(pages)/profile/credit-balance.tsx`). Credit
      was INVISIBLE to the person who owns it: it applied itself at checkout
      (`creditSplit.applied > 0`) and appeared nowhere else — not in the
      profile, not on an order — so a shopper refunded to credit had no way to
      learn they had any short of filling a cart and noticing the total drop.
      That is how a merchant gets "you never refunded me", and it made the
      "offered, never forced" rule above half a promise. Three decisions:
      - **Scope is server-derived on BOTH axes** — session uid + HOST store,
        never caller input. That is what keeps the `withService` reads inside
        `lib/credit` safe from a storefront entry point; and the store scope is
        not redundant, because a Firebase uid is global
        (the `customer-order-actions.ts` double lock).
      - **★ `ref` AND `note` ARE NOT EXPOSED.** `note` is merchant-authored
        (free text once the grant UI lands) and `ref` carries internal ids —
        §16's AI ledger uses an operator's EMAIL as a ref. The customer's
        wording is derived from `kind` alone, a closed vocabulary the action
        owns, so a private note can never surface on a storefront page. Pinned
        by a test; don't "complete" the mapping by passing `note` through.
      - **The card hides itself** when the balance is 0 AND there is no
        history, matching checkout's `applied > 0`. A spent-to-zero balance
        still renders, because the history explains where the money went and
        vanishing would look like it was lost.
    - **Not built:** gift cards (they share this ledger shape — that is why
      `kind` is an enum), expiry (`'expire'` is reserved in the CHECK so it
      needs no migration), a merchant grant UI (`issueCredit` takes
      `kind: 'grant'` and is ready), and split-tender refunds.

30. **Custom domains & TLS — three conditions, and nobody is watching.**
    `lib/domains/`, `/dashboard/settings/domain`, Pro-only. A domain is marked
    `settings.custom_domain_verified` — the single flag `lookupStoreByHost` and
    `storeOrigin()` read — only when ALL THREE hold: the managed certificate is
    ACTIVE, the domain resolves publicly to `DOMAIN_LB_IP`, and the
    CertificateMapEntry exists. Each alone is insufficient in a way that bites:
    without the cert the TLS handshake fails before a request reaches the app;
    without the DNS check we publish a host we don't serve in every canonical,
    sitemap entry and `og:url`; without the entry the certificate is issued and
    **nothing presents it**.
    - **★★ THE FLOW HAD NO WAY TO FINISH** (found 2026-08-06). `verifyDomain`
      had exactly ONE caller: the settings page, polling every 30s, capped at
      ~10 minutes, and skipping every tick while the tab was backgrounded. But
      the three steps cannot complete in one sitting — the merchant leaves to
      add records at their registrar, and Google's managed certificate is
      documented as taking up to ~30 minutes AFTER the challenge CNAME
      resolves. So in the ordinary case the certificate reached ACTIVE at
      Google and then nothing ever ran step 3 or set the flag. The domain
      never served, the dashboard still said "waiting for your DNS records",
      and the certificate everyone was waiting on had already been issued.
      Fixed the way §18/§26 already do it: **reconcile-on-read plus a cron
      backstop** — `/api/cron/domain-reconcile`, HOURLY (a daily sweep makes a
      09:05 connection wait a day).
    - **★ `lib/domains/reconcile.ts` HOLDS THE CORE, AND IT IS NOT A
      `"use server"` FILE.** Everything exported from `app/actions/*` is a
      publicly reachable endpoint, so an unauthenticated sweep over every store
      exported from there would be the exact hazard the
      `syncEmailDomainVerified` comment in that file warns about. The action is
      the gate and delegates; the plan check stays in the core, because a
      lapsed Pro plan must not be verified by a background job either.
    - **★ THE FAILURE REASON WAS BEING THROWN AWAY.** `CertResource` declared
      `provisioningIssue.reason` and nothing read it, and
      `authorizationAttemptInfo` — the PER-DOMAIN cause, and the only field
      that separates the three real failure modes — wasn't declared at all. So
      a CAA record forbidding Google, a CA rate limit, and a genuinely missing
      CNAME all produced the same sentence: "add the DNS records shown".
      **Two of those three are not fixed by adding the records shown**, and
      neither the merchant nor an operator reading the logs could tell which
      they had. `explainCertificate` (pure, tested) maps them, and the enum is
      persisted to `settings.domain_cert_issue` — the ENUM only, since
      `stores.settings` is anon-readable (§9).
    - **★ A CREATE IS AN LRO, SO READ-BACK MUST RETRY.** Certificate Manager
      POSTs return an Operation and the resource is not queryable until it
      completes, so the immediate GET could 404 — which surfaced as "Couldn't
      start domain verification" on the FIRST attempt, persisted no
      `domain_challenge`, and left the settings page listing the A record
      ALONE. The merchant added it, saw nothing else to add, and left; the
      certificate could never validate because the one record proving
      ownership was never on screen. `getEventually` retries 404 only (a 403
      on IAM must surface at once) and takes a `ready` predicate, because a
      DnsAuthorization is readable a beat before `dnsResourceRecord` is filled.
    - **★★ IT SELF-HEALS A STALE VERDICT — the last step that needed a human**
      (`lib/domains/reissue.ts`, pure + tested). A managed certificate records
      the result of its LAST authorization attempt and then retries on Google's
      own backoff, so a merchant who fixes their DNS is NOT re-checked promptly.
      Observed in prod 2026-08-06: `wholesip.com` read
      `CONFIG / CNAME_MISMATCH` from an attempt **59 minutes older** than the
      correct records, with the apex fully down the whole time. Nothing was
      broken and nothing was going to fix it — it was waiting on Google to
      look again.
      Deleting only the CERTIFICATE forces a fresh attempt; done by hand it went
      ACTIVE in **80 seconds**. `reconcileDomainForStore` now does that itself.
    - **The authorization is never touched** — it holds the challenge token
      the merchant already published, so deleting it would mint a new one and
      silently invalidate their record, turning self-healing into "go and edit
      your DNS again". `reissueCertificate` removes the certificate alone,
      under `assertManaged`, and provisioning recreates it under the identical
      deterministic name against the same authorization.
    - **★ NEVER ON `RATE_LIMITED`** — the failure IS that we asked too often,
      so asking again is the one action guaranteed to prolong it, and the limit
      is shared across every domain under that registrable name. Never on
      `CAA` either: a fresh certificate hits the identical record.
    - **★ OUR OWN DNS CHECK IS THE PRECONDITION.** A reissue is only justified
      because we can see the cause is already gone; without it we would spend
      the rate-limit budget relearning the same answer. Also refused on a
      missing/unparseable `attemptTime` (acting blind could delete a
      certificate Google is authorizing that second) and inside a 6-hour
      per-host cooldown, persisted as `settings.domain_reissued` — a cooldown
      that isn't written down is a reissue that happens every run.
    - One extra provisioning pass per sweep, then stop: the new certificate
      won't be ACTIVE for ~80s, so the NEXT run attaches it.
    - **★ SILENCE IS NOT SUCCESS.** The sweep answers 200 while domains wait (a
      merchant who hasn't added records is not an outage), so a domain stuck for
      a week looked exactly like one stuck for a minute. `domain_pending_since`
      plus `pendingDuration` give it a clock: `logWarn("custom domain stuck")` past
      3 days for Error Reporting to alert on, and `waitingDays` in the cron
      response. Both cleared on going live, so a later reconnect doesn't inherit
      a months-old timestamp and alarm immediately.
    - **★ ONE ADDRESS PER STORE: the subdomain REDIRECTS to a live custom
      domain.** `proxy.ts` 308s `{slug}.storemink.com/*` → `xyz.com/*` —
      storefront, `/dashboard` and `/pos` alike — so a store has one address
      rather than two that both serve and split its SEO signals. The lookup is
      `lib/store/canonical.ts`.
    - **★ THE REDIRECT GATE IS `storeOrigin()`, BORROWED NOT REIMPLEMENTED.** It
      already applies the two gates (verified + entitled) for canonical URLs,
      sitemaps and robots, so the redirect cannot disagree with what we serve or
      what we publish. It also means **the redirect undoes itself for free**: a
      lapsed Pro plan or an un-verified domain makes `storeOrigin` return the
      subdomain, so `xyz.com` stops resolving (`lookupStoreByHost` applies the
      same two gates) and the subdomain works again with no extra code.
    - **★★ `Cache-Control: no-store` ON THE 308, AND IT IS LOAD-BEARING.** A 308
      is heuristically cacheable and browsers keep it INDEFINITELY. Without the
      header, a merchant whose domain later breaks would have the dead redirect
      pinned in their own browser — so reverting `custom_domain_verified` would
      restore the subdomain for the whole internet EXCEPT the one person who
      needs it. The status stays 308 so search engines still consolidate signals.
    - **★★ THE REDIRECT IS PRODUCTION-ONLY (`IS_PRODUCTION_PLATFORM`), AND THAT
      IS CORRECTNESS, NOT CAUTION.** A custom domain has ONE A record → ONE load
      balancer, and `cloudbuild.yaml` gives staging the SAME `_DOMAIN_LB_IP` and
      `_DOMAIN_CERT_MAP` as prod (one HTTPS proxy holds one map). The URL map has
      exactly one host rule — `staging.storemink.com` + `*.staging.storemink.com`
      → the staging backend — so **every merchant domain falls to `defaultService`,
      the PRODUCTION backend**. Staging can therefore never serve a custom domain.
      But `custom_domain_verified` is per-DATABASE and staging has its own, so
      staging would redirect to a host only prod can answer: the store lands on a
      different database (where it may not exist) or, if DNS is incomplete,
      nowhere.
      Observed 2026-08-08: `echos.staging.storemink.com` 308'd to `storiq.in`,
      whose zone holds only NS + SOA — storefront, `/dashboard` and `/pos` gone
      together, with no way back in. **And it could not self-heal**: the health
      check that reverts a dead domain (3 consecutive failures) runs only from
      `/api/cron/domain-reconcile`, and every Cloud Scheduler job targets
      `https://storemink.com` (`docs/cron-jobs.md`) — the affected row had
      `domain_health_checked_at = null`, never checked once. Off prod the safety
      net this redirect leans on does not exist, so the redirect must not run
      there. This SUBSUMES the older `*.localhost` check, which excluded local dev
      for the identical reason. `IS_PRODUCTION_PLATFORM` lives in
      `lib/store/host.ts` and `SEARCH_INDEXABLE` now derives from it — split apart
      deliberately, since `NEXT_PUBLIC_NOINDEX` is an indexing kill-switch and
      must not change the answer to "which environment am I?". Pinned by
      `proxy.test.ts`.
    - **★ PROVISIONING IS GATED THE SAME WAY, IN `reconcileDomainForStore`** —
      the one place BOTH the merchant's Verify click and the cron sweep pass
      through, so neither can provision behind the other's back
      (`ensureProvisioned` has no other caller). Without it staging still wrote
      real `sm-domain-stg-*` certificates, authorizations and entries into the
      SHARED prod map: billable, and an entry makes the LB terminate TLS for a
      host the prod backend then 404s as an unknown store. Five such resources
      for one staging test domain were deleted by hand on 2026-08-08. The check
      sits BEFORE the plan check deliberately — this is "this cannot work", not
      "you may not", and reporting it as an upgrade prompt would send someone to
      buy Pro to fix an environment. **Deprovisioning is deliberately NOT gated**:
      `disconnectDomain` does not route through here, so a store that already has
      a domain set off prod can still tidy up. Pinned by `reconcile.test.ts`.
    - The proxy cannot use `unstable_cache` (no render scope in middleware) and
      the storefront path is deliberately free of per-request DB work, so the
      mapping sits in a 60s per-instance TTL cache bounded at 1000 entries. A DB
      error FAILS OPEN — null means no redirect, so the subdomain keeps working.
      `*.localhost` is excluded, or local dev of a store with a custom domain
      would redirect to production.
    - ⚠ **Every paired POS till must be re-authorised once** after a domain goes
      live: device + operator cookies are host-only and `SameSite=Strict` by
      design (§22), and a host-scoped credential cannot cross origins. Dashboard
      sessions likewise — a merchant signed in on the subdomain signs in again on
      their own domain, once.
    - **★ A LIVE DOMAIN IS HEALTH-CHECKED, AND REVERTS IF IT BREAKS**
      (`lib/domains/health.ts`, pure + tested). The sweep used to skip anything
      already verified, which was survivable while the subdomain stayed
      reachable — but once it REDIRECTS, a merchant whose DNS later breaks
      (nameservers moved, registrar lapsed, A record deleted) has no route into
      their own dashboard. The redirect turns a cosmetic problem into a lock-out.
    - **★ HYSTERESIS, NOT A SINGLE VERDICT.** `REVERT_AFTER_FAILURES = 3`
      consecutive failures, and any single success clears the count outright — a
      working domain is not "two failures away from working". Reverting on one
      check would flap the store's canonical URL on a transient DNS hiccup, and
      that URL is what Google indexes; oscillating is worse for a merchant than
      being briefly down.
    - **Asymmetric cadence**: a healthy domain is re-checked every 6h, a FAILING
      one every 1h (≈3h to revert). Confirming a suspected failure is
      time-critical because the merchant may be locked out; re-confirming health
      is not. `shouldHealthCheck` is consulted BEFORE any work, so the hourly
      sweep does almost nothing for a fleet of healthy domains.
    - The revert is just `delete settings.custom_domain_verified`, which stops
      serving AND cancels the redirect through the same `storeOrigin` rule. One
      flag — which is why there is no separate "disable the redirect" step.
    - **`store.domain_reverted`** tells the merchant (both channels,
      `configurable: false`): their public address has just changed under them
      and every link they shared now goes elsewhere, so there is no defensible
      version of "they opted out of hearing this". Copy is BESPOKE and leads with
      what still WORKS — a generated fact list would open with "Domain:
      acme.com" and leave them to work out whether their shop is down, which is
      their only question.
    - **★ THE DASHBOARD IS SERVED ON THE CUSTOM DOMAIN TOO**, not only on the
      `{slug}.storemink.com` subdomain. `proxy.ts` has ONE "store hosts" branch
      covering storefront + `/dashboard` + `/auth` + `/pos`, and
      `cookieDomainForHost` returns `undefined` for a custom domain, so
      `sm_session` is set HOST-ONLY on it rather than scoped to
      `.storemink.com`. Verified live: `wholesip.com/dashboard` → 307 →
      `wholesip.com/auth/login` (staying on the custom domain), which renders.
      ⚠ **Sessions therefore do NOT carry over** — different registrable domain,
      different cookie jar — so a merchant signed in on the subdomain is signed
      out on their own domain and must log in again. Cookies working correctly,
      but it surprises people.
    - **★ GOOGLE SIGN-IN NEEDS THE DOMAIN IN IDENTITY PLATFORM'S
      `authorizedDomains`** (`lib/auth/authorized-domains.ts`, pure helpers +
      18 tests). `signInWithPopup` refuses to run on an unlisted origin,
      failing `auth/unauthorized-domain` before any popup opens — so on a
      merchant's own domain that button was dead while email+password worked,
      because password sign-in is a plain REST call and is not origin-gated.
    - **★ ONE ENTRY COVERS EVERY SUBDOMAIN.** `matchDomain` in
      `@firebase/auth` v12 builds
      `^(.+\.<escaped>|<escaped>)$`, so a listed `storemink.com` authorises
      `storemink.com` AND every `*.storemink.com`. **There is no bug on store
      subdomains** — and the earlier §7 instruction to add `*.storemink.com`
      was both unnecessary and impossible, since **Firebase rejects wildcards
      in this list**. `entryCovers` mirrors that regex; keep it in step with
      the SDK, because if the rule ever tightens this becomes an
      over-estimate and `planAdd` would skip entries that are needed.
    - The entry added is the **registrable** domain (`entryForDomain` via the
      PSL), so apex + www + anything else the merchant points at us is covered
      by one entry — listing `www.xyz.com` alone would leave the apex, the
      commoner address, unauthorised.
    - `ensureAuthorizedDomain` runs on the `becameLive` edge, **best effort**:
      a failure leaves password sign-in working and the next reconcile
      retries; it must never un-verify a live domain.
      `removeAuthorizedDomain` runs on disconnect AND on a domain change —
      an entry for a host we no longer serve is standing permission to run
      popup sign-in against our project, which matters most if someone else
      later buys that domain.
    - **★ `planRemove` REMOVES BY EXACT ENTRY, NEVER BY COVERAGE, and refuses
      protected entries.** Coverage-based removal is the trap: a
      subdomain-shaped input would match and delete `storemink.com`, killing
      Google sign-in for the platform and every store subdomain in one call.
      Same class of guard as `assertManaged`.
    - ⚠ Read-modify-write on a project-global list, so two domains verifying
      in the same second can lose one update. Deliberately not locked — the
      loser is retried, and the cost is one merchant briefly using a password.
    - Needs `roles/firebaseauth.admin` on the runtime SA (it has it; the role
      includes `firebaseauth.configs.get`/`.update`).
    - **⚠ THE INFRASTRUCTURE IS THE OTHER HALF, AND IT IS NOT IN CODE.** Four
      things must be true in GCP or every domain fails identically no matter
      what this code does: the runtime SA holds **`roles/certificatemanager.editor`**
      (claimed in `naming.ts`'s comment but granted by NO provisioning doc —
      `docs/gcp-migration-phase4-cloud-run.md` §78 lists four roles and this is
      not one), `DOMAIN_CERT_MAP` exists, **that map is attached to the target
      HTTPS proxy** (`--certificate-map`; if the proxy carries certs directly
      instead, every merchant entry is inert and the LB serves the
      `*.storemink.com` cert → name-mismatch in the browser while the app
      reports ACTIVE), and `DOMAIN_LB_IP` is the IP the forwarding rule
      actually holds.
    - **★ APEX AND www ARE BOTH COVERED, AND www CANNOT GATE THE STORE.** A
      certificate covers the EXACT hostnames it was issued for, so connecting
      `acme.com` used to leave every visitor who typed `www.` — most of them,
      and what older links and Google's index often carry — with a full-page
      browser certificate warning, with no setting to fix it.
      `companionHost`/`domainHosts` (pure, PSL-based, tested) pair apex ↔ www
      and nothing else: `shop.acme.com` has no second form worth guessing at,
      and inventing hostnames costs a certificate plus a DNS record the merchant
      then has to be told about.
    - **A FULL TRIPLE PER HOSTNAME**, not one certificate with two SANs.
      `managed.domains` is IMMUTABLE, so widening an existing single-host
      certificate is impossible — `createOrAdopt` would 409 and adopt the old
      narrow one, and the www map entry would point at a certificate that does
      not cover www. Per-host triples also keep every already-provisioned
      resource byte-identical in name, so live domains kept their certificates
      with nothing to migrate.
    - **★ THE PRIMARY DECIDES.** `ProvisionState`'s top-level fields mirror
      `hosts[0]` — the domain the merchant actually typed — and the companion
      is strictly best-effort. Gating on both would mean someone who added one
      A record instead of two has a working certificate for the address they
      asked for and a store that still refuses to serve it: trading a real
      outage for a cosmetic one. When the store is live and www is still
      pending, its challenge record STAYS on screen under "Finish covering
      www.…", named by the host rather than the raw `_acme-challenge` name.
    - `deprovision` walks the same `domainHosts` list, so disconnecting can't
      leave the www triple behind. Provisioning is sequential, primary first:
      Certificate Manager rate-limits per project and a burst of parallel
      creates is what later surfaces as RATE_LIMITED on a merchant's cert.
    - **★ CHANGING A DOMAIN RELEASES THE OLD ONE.** `deprovision` was wired only
      to `disconnectDomain`, so editing the domain silently orphaned the previous
      one's certificate, authorization and map entry. Two costs: a certificate
      nothing references keeps billing and only surfaces on an invoice, and the
      stale map entry leaves the load balancer still terminating TLS for a
      hostname the store no longer claims — it resolves, handshakes, then 404s as
      an unknown store. (This is where the orphaned `www.wholesip.com` resources
      in prod came from.) Runs in `after()` and best-effort: the new domain is
      already saved, and a cleanup failure must not fail the change requested.
    - **★ THE MERCHANT IS TOLD WHEN IT GOES LIVE.** `store.domain_live`
      (`store-admins`, in-app + email) is the merchant milestone;
      `platform.domain_verified` remains the operators' console line for the same
      moment — the `store.created` / `platform.store_created` precedent, not
      duplication. EMAIL is the whole point: the flow finishes in the background,
      so without a mail nobody is told the thing they waited days for happened
      and they must keep revisiting the settings page to guess. The **cron** path
      is the one that matters — the action only fires for someone who happened to
      be on the page at the finishing moment. Copy is BESPOKE (§24's rule): as a
      generated fact list it would read like a status row rather than an answer,
      and the notification links to the DOMAIN, not `/dashboard`, because the one
      thing anyone wants on being told this is to click through and see their own
      shop answer on it.

31. **CSV import & export — a registry, and a log that names the row.**
    Products, Categories, Inventory and Coupons import + export; **Orders
    export ONLY**. Shopify's shape, because that is the file merchants already
    have. Import/Export lives in a menu on each resource's OWN list page; the
    HISTORY lives at `/dashboard/logs/import-export`, beside Activity and
    Email logs.
    - **★ A REGISTRY, NOT FIVE IMPORT SCREENS** (`lib/import-export/`). The
      alternative is header matching, coercion, validation, error reporting and
      the template file reimplemented per resource, diverging immediately, with
      a sixth resource costing a week. Same trade `lib/settings/registry.ts` and
      `lib/notifications/events.ts` make. `resources.ts` holds the columns;
      adding a resource is a `ResourceDef` plus one importer function.
    - **★ THE PURE CORE IS SHARED BY THE BROWSER AND THE SERVER.** `lib/csv/`
      (RFC 4180 parse + serialize) and `lib/import-export/{coerce,parse}.ts`
      have no server imports, so the browser parses the merchant's file to
      build an instant preview and the server re-parses the SAME bytes before
      writing. Two parsers would be the bug: the preview would promise one
      thing and the import would do another. The preview is a COURTESY — every
      coercion, length cap, URL-scheme check and enum check runs again server-
      side, or the whole validation layer is a suggestion.
    - **★ ROW-ATOMIC, NOT FILE-ATOMIC.** Each row is its own transaction, so
      row 12 failing says nothing about row 13. A 500-row file with 3 bad rows
      imports 497 and reports 3. Wrapping a slice in one transaction is
      simpler and means one bad cell discards 499 good rows — after which the
      merchant, unable to tell which, re-uploads and duplicates everything that
      did work. Hence `partial` is a first-class job status, and the job page
      says so in words, because the instinct on reading "failed" is to
      re-upload.
    - **★★ AN IMPORT IS A REAL BACKGROUND JOB.** The file is uploaded ONCE to
      `POST /api/dashboard/import`, stored in `data_job_payloads`, and applied
      by `lib/import-export/worker.ts`. **Closing the tab changes nothing** —
      the browser's only job is the upload.
      It got here the long way. The rows used to be posted FROM the browser a
      slice at a time, which was a real answer to two hard limits (a server
      action's body cap, Cloud Run's request timeout) but meant an import died
      with the tab; then the loop moved to a provider in the dashboard layout,
      which bought surviving navigation and nothing more. Both are gone.
      `startImport` / `importChunk` / `finishImport` were DELETED rather than
      left unused: every export of a `"use server"` file is a public endpoint,
      and `importChunk` took no lease, so a caller could still apply rows to a
      job the worker was mid-way through.
    - **★ THE UPLOAD IS A ROUTE HANDLER BECAUSE IT HAS TO BE.** A server action
      caps the body at 4mb and `MAX_IMPORT_FILE_BYTES` is 25MB, so the file
      cannot travel through one. That single POST is also atomic — either the
      job is queued or nothing happened — where the chunked upload it replaced
      could always leave a half-uploaded job behind.
    - **★★ THE FILE LIVES IN POSTGRES, NOT THE MEDIA BUCKET, AND THAT IS A
      SECURITY DECISION.** The GCS bucket is `allUsers:objectViewer` with
      uniform bucket-level access (§7) — every object in it is readable by
      anyone with the URL. An import file is the merchant's raw data, and the
      same code path carries orders-shaped CSVs with customer names, addresses
      and phone numbers; an unguessable public URL is obscurity, not access
      control. `data_job_payloads` is service-role only, cascades with its job,
      is dropped the moment the job finishes, and is already covered by §32
      retention. A side table rather than a column, because the job row is read
      by the history list, the detail page and the failures feed and none of
      them want to drag 25MB along.
    - **★★ THE LEASE IS WHAT STOPS A SLICE BEING APPLIED TWICE.** The worker
      chains itself AND a cron sweep picks up stalled jobs, so two runs can
      genuinely overlap — and importing is NOT idempotent, so an overlap means
      duplicate products and double stock. The claim is one statement:
      `FOR UPDATE SKIP LOCKED` picking the oldest free job, with `lease_until`
      written in the same breath. Only an EXPIRED lease is claimable, which is
      also what lets a job survive a worker killed mid-slice. `attempts` bounds
      it, so a job that dies the same way every time gives up instead of being
      re-claimed forever.
    - **★ PROGRESS IS WRITTEN PER SLICE, NOT PER RUN.** `cursor` is where the
      next run resumes and what the job page's progress bar reads. It is kept
      DISTINCT from `processed_rows`: they move together today, and conflating
      "where to resume" with "how much got done" is how a resumed job silently
      skips a slice.
    - **★ THE SLICE IS BOUNDED BY TIME, NOT ROWS** (`SLICE_BUDGET_MS` 40s under
      the route's `maxDuration` 60, leaving room to write progress and chain).
      Rows differ by an order of magnitude in cost — a product with variants and
      images against a coupon — so a row count would either waste the request or
      overrun it. `SLICE_MAX_ROWS` is a second ceiling on memory and on how much
      one crash loses.
    - **★ `reapStaleJobs` NOW TESTS THE LEASE, NOT THE AGE.** It cancels
      pending/running jobs untouched for 30 minutes, which under the
      browser-driven design could only mean a closed tab. Server-side, a large
      import legitimately runs longer than that — so without the lease check the
      merchant's own history page would reach in and cancel a healthy import
      mid-slice.
    - **★ THE CACHE BUSTING AND THE SEO HOOK MOVED WITH THE WORK.** They lived
      in `finishImport`, the action the browser called when its loop ran out.
      Moving the loop server-side without moving those would have left every
      import writing rows the storefront kept serving stale, and new products
      never reaching Google.
    - **★ THE JOB PAGE POLLS ITSELF WHILE THE JOB IS LIVE** (2s, `router.refresh`,
      stopping the moment the status leaves running/pending). It is now the page
      a merchant is SENT to at the START of an import, so a frozen screen of
      zeroes reads as a stuck import. Polling a FINISHED job forever is how a
      forgotten background tab quietly costs a request every two seconds all
      afternoon, which is why the interval is torn down on status rather than on
      unmount alone.
    - **★ `data.import_started` IS A SECOND EVENT FOR ONE IMPORT, DELIBERATELY.**
      Between `startImport` and `data.imported` there is a window — minutes, on
      a big file — where the only record is a job row nobody has a link to. The
      merchant is redirected to that log, but they are free to navigate away, and
      the finish event cannot help them: it does not exist yet while they are
      wondering where their import went. **IN-APP ONLY**; mailing "started" and
      then "finished" is the two-messages-for-one-action pattern §24 says trains
      people to ignore a channel.
    - **★ ALL THREE DATA EVENTS CARRY A URL NOW.** They fell through to
      `render.ts`'s default, which renders the event label and NO link — so
      "Import finished" sat in the bell as a dead end, next to an import whose
      entire value is the row-by-row log one click away. `subjectId` is the job
      id at every emit site.
    - **An EXPORT redirects to the export LIST, not to its own job page**, and
      that is a limitation rather than a preference: the job row is created by
      the streaming route as it starts, so the id does not exist on the client
      side of the call. The export just started is the newest row. The download
      itself is a `Content-Disposition: attachment` navigation, which does NOT
      unload the page, so the redirect and the save coexist.
    - **★ AN ABSENT CELL MEANS "LEAVE THIS ALONE", NEVER "SET TO NULL"** — what
      makes a two-column file (Handle + Selling Price) a safe way to change only
      prices.
    - **★ THE GATE IS THE RESOURCE'S OWN PERMISSION SECTION**, deliberately not
      an `import_export` key of its own — that would be a way to grant write
      access to the whole catalogue without granting Products, a grant that
      looks narrow and is the widest in the system. Import needs `manage`,
      export needs `view` (downloading is a read). Inventory additionally needs
      `products` (`alsoRequires`) because resolving a SKU is a product read.
      Inventory import also respects `admin_locations` scope — the file names
      locations by TEXT, so without it a location-bound manager could type
      another branch's name.
    - **★ ORDERS ARE EXPORT-ONLY, AND THAT IS A DECISION.** An imported order
      would carry an `order_ref` this store never issued, reserve no stock, take
      no money, and land in revenue reports as a sale that never happened. Every
      order column is `readOnly`; a CI test asserts it has no writable column.
    - **★ COLUMN DRIFT IS IMPOSSIBLE BY CONSTRUCTION.** Exporters yield records
      KEYED BY FIELD and `toCells` lays them out in registry order. Positional
      arrays had to be kept in step by hand, and the failure is silent and
      total: add a column, forget one exporter, and every cell after it shifts —
      prices land in the stock column and the file still looks plausible enough
      to reimport. `EXPORT_FIELDS` + two tests pin it both ways (no phantom
      field, no always-blank column).
    - **★ THE EXPORT STREAMS, AND ITS STATUS CODE IS COMMITTED FIRST.** A route
      (`/api/dashboard/export`), not an action: an action builds the whole file
      in memory twice on a fixed-memory container while the merchant watches a
      dead page. Keyset paging (`id > cursor`), not OFFSET, because OFFSET skips
      and repeats rows when the catalogue is edited mid-export — the POS
      catalogue snapshot pages this way for the same reason. Once headers are
      sent a mid-stream failure CANNOT become a 500, so it is recorded on the
      job and the stream ends with a visible marker row: a silently truncated
      CSV is one a merchant reimports believing it complete.
    - **★ CSV FORMULA INJECTION IS GUARDED ON WRITE** (`guardFormula`). A cell
      beginning `=`, `+`, `-`, `@`, tab or CR executes when the file is opened,
      and the export carries customer-supplied text — a crafted name on an order
      reaches the merchant's spreadsheet, so the attacker needs no account here.
      **A plain number is exempt**, or the guard mangles every negative price
      and breaks the round trip it exists inside.
    - **★ DATES ARE ISO-ONLY, REFUSED OTHERWISE.** `05/08/2026` is 5 August to
      the merchant and 8 May to V8's parser, and nothing in the string
      distinguishes them. §24 already paid for that once; a coupon silently
      starting three months early is the same bug with money attached.
    - **★ STOCK NEVER MOVES THROUGH A PRODUCT IMPORT.** `products.stock` is a
      trigger-maintained aggregate of `inventory_levels`, so a direct write is
      reverted by the next sale. It is accepted on CREATE only, where the
      pos_01 seed trigger carries it onto the default location's shelf. The
      Inventory import applies counts as a DELTA through `adjust_stock_at`:
      atomic, and it leaves the `stock_movements` ledger row without which a
      stocktake is indistinguishable from stock going missing. It feeds
      `reportStockChanges`, so a correction to zero still fires the low-stock
      crossing.
    - **★ VARIANTS ABSENT FROM THE FILE ARE LEFT ALONE, NEVER DELETED.** The
      editor deletes them because it shows the complete set and a human is
      looking at it; a CSV is routinely partial, and deleting the rest would
      destroy stock, order links and system SKUs that can never be reissued.
    - **A missing CATEGORY is created and named in the log; a missing TAX CLASS
      is not.** They look alike and are not: a category is navigation a merchant
      renames in ten seconds, while a tax class carries a RATE, and inventing
      "GST 12%" means guessing 12 — a filing problem found by an auditor, not by
      looking at the shop.
    - **★ ONE EVENT PER JOB, NOT PER ROW.** `data.imported` (both channels) and
      `data.exported` (in-app only — an orders file carries every customer's
      address and "who took a copy, when" is only answerable afterwards if
      someone wrote it down, but it is routine enough that emailing would train
      people to ignore it). 2,000 per-row events would bury every other thing
      that happened that day.
    - **The error log is `data_job_issues`** (`supabase/import_export_01_jobs.sql`,
      service-role only, the email_logs pattern — the rows quote raw cells,
      which for an orders export means customer addresses). Issues carry the
      **1-based ORIGINAL FILE LINE**, not the row index: blank lines and
      newlines inside quoted fields make the two diverge, and "row 40 is broken"
      pointing at line 47 is worse than no number. Capped at `ISSUE_CAP` per job
      with the overflow COUNTED (`dropped_issues`) — a log that looks complete
      when it isn't is worse than a truncated one that says so.
    - **Not built:** customers (blocked by design — `users.id` IS the Firebase
      uid and `(phone, store_id)` is unique, so an imported row collides with
      that person's later signup; it needs the same claim/merge story the POS
      lacks), scheduled/recurring imports, and import from a URL.

32. **Log retention — the policy that was written down three times and enforced
    nowhere.** `lib/retention/prune.ts`, driven daily by
    `/api/cron/prune-logs` (03:00 UTC). Windows: `notifications` 90 days,
    `activity_events` 365, `email_logs` 90. Full operational detail —
    the schedule, the `gcloud` command, how to read a response — is in
    `docs/cron-jobs.md`.
    - **★ IT WAS DOCUMENTED, INDEXED, AND DEAD.** `supabase/email_logs.sql`
      states the 90-day intent and ships `email_logs_created_idx` built "for
      retention sweeps"; `pruneNotifications` had the right windows and a
      docstring saying it was "called by the daily cron". **Nothing called it.**
      A comment asserting that something runs is not a thing that runs — the
      same failure `docs/cron-jobs.md` records for the jobs that were documented
      but never created. This is why the guard is a real endpoint on a real
      schedule and not a comment.
    - **★★ AND IT WAS AN UNGATED PUBLIC ENDPOINT.** `pruneNotifications` was
      exported from `app/actions/notification-actions.ts`, a `"use server"` file
      — where every export is a publicly reachable endpoint — with no gate of
      any kind, running under `withService` (which bypasses RLS), taking its
      retention windows as **parameters**. An unauthenticated caller passing
      zeroes would have deleted every notification, every email log and the
      whole of `activity_events` — the append-only audit trail — for every store
      on the platform. Destroying the audit log is precisely what an attacker
      does to cover their tracks. The function is **deleted**, not wired up. The
      core lives in `lib/` and the cron route is the gate, which is the identical
      resolution §30 gives for `lib/domains/reconcile.ts`; the same rule, for the
      same reason, is why `lib/pos/tenders.ts` is not a `"use server"` file
      either. **Do not put a prune back in `app/actions/`.**
    - **★ EACH BATCH IS ITS OWN TRANSACTION.** `withService` wraps its callback
      in one BEGIN/COMMIT, so looping batches inside a single call would be one
      enormous transaction — exactly what batching exists to avoid. The loop
      calls `withService` per batch: locks release between batches, WAL stays
      bounded, and a run killed half way is resumable because the committed
      batches stay committed. The sweep is idempotent; the next night carries on.
    - **★ ORDER IS LOAD-BEARING.** `notifications.event_id` references
      `activity_events` **ON DELETE CASCADE**, so pruning events destroys their
      notifications too. Notifications are swept FIRST and at the shorter
      window, leaving the event sweep far less to cascade through.
    - **★ A DRAINING BACKLOG IS NOT A FAILURE.** It stops at 50,000 rows per
      table or 240 seconds and reports `stop` per table
      (`drained`/`cap`/`budget`/`error`). `incomplete` returns **200** — a first
      sweep over years of rows legitimately hits its cap, and a permanently-red
      job is one nobody reads (the `domain-reconcile` lesson). A failed table
      returns **503** so Scheduler's retries engage (the `seo-refresh`
      contract), and one table failing never stops the next.
    - **Financial records are never touched** — orders, refunds and credit notes
      live in their own tables. This sweep only ever deletes the inbox, the
      activity feed and the mail log.
    - **⚠ §31's `data_jobs` / `data_job_issues` are NOT swept yet, and they
      should be.** `ISSUE_CAP` bounds issues per job, but nothing bounds the
      number of jobs. The sweep was written on `main`, where those tables do
      not exist; on this branch they do, so the blocker is gone. Adding them is
      two `RETENTION_POLICIES` entries — **issues before jobs**, because
      `data_job_issues.job_id` is `ON DELETE CASCADE` from `data_jobs`, the
      same shape as notifications→events. ⚠ They also carry only
      `(store_id, created_at)` composite indexes, which a sweep filtering on
      `created_at` ALONE cannot use, so each also wants a plain `created_at`
      index in `supabase/import_export_01_jobs.sql` — a separate
      `CREATE INDEX IF NOT EXISTS`, so re-running the file stays idempotent.
    - **⚠ The Cloud Scheduler job did not exist when this shipped** — created
      and verified **2026-08-11**, along with `import-worker`, which was also
      absent. Both had been documented in `docs/cron-jobs.md` as though they
      existed: the third recurrence of that failure, found by DIFFING the
      documented list against `gcloud scheduler jobs list`, which is the only
      method that has ever caught it.

33. **Logs — five of them, one hub, one permission.** `/dashboard/logs`,
    with `lib/logs/` behind the newest of them.
    - **★ THE CAPABILITY WAS THERE; THE IA WASN'T.** Activity, Email, Import
      and Export logs all existed, and the Email table already carried To /
      From / Type / Provider / Status / Sent at. What was missing was a place
      they lived together: `activity` sat under Settings with `parent` set, so
      the logs were a third-level nav item, and its `children` duplicated the
      rail. The section is now top-level, its children are GONE, and
      `logs-rail.tsx` (driven by `log-types.ts`) is the one navigation between
      logs.
    - **★ THE PERMISSION KEY IS STILL `activity`.** Roles store the key, so
      renaming it to `logs` would silently revoke every grant already saved —
      the same reason `navigation` kept its key when it folded into the
      builder. Only the LABEL and the URL changed.
    - **★ THE ROUTES ARE `/dashboard/logs/*`** (was `/dashboard/activity/*`).
      The old path named ONE of the five logs after the section holding all of
      them, so the URL contradicted the nav the moment you opened Email logs.
      **The old paths still resolve** — a 307 pair in `next.config.ts`, query
      string preserved. Not a courtesy to bookmarks: every notification email
      ALREADY SENT carries an absolute `/dashboard/activity` link
      (`lib/email/notification-emails.ts`) and those are in inboxes nobody can
      edit. TEMPORARY (307), not permanent: this is an internal admin path
      behind a login, so there are no SEO signals to consolidate, and a 308 is
      cached indefinitely by browsers — the trap `proxy.ts` already had to work
      around with `Cache-Control: no-store` (§30).
    - **★ THE RAIL IS THE SIDEBAR NOW, NOT A SECOND COLUMN.** It rendered
      beside the content, which put THREE navigations on screen at once: the
      dashboard's own nav, the rail, and the page's filters. The dashboard
      already had the right pattern — the sub-nav panel that swaps the main nav
      for Back + the section's pages (Settings, Blogs, POS) — so
      `dashboard-sidebar.tsx` branches on the logs path and renders `LogsRail`
      in that slot, and `logs/layout.tsx` renders nothing but its children.
      ⚠ It stays a COMPONENT driven by `LOG_TYPES` rather than becoming
      `children` on the permission section, which would have been the obvious
      tidy-up: Import and Export share a pathname and differ only by `?kind=`,
      and the sidebar's generic child matcher compares hrefs while ignoring the
      query string — so it would light up both entries on either page.
      `activeLogKey` is the thing that knows better.
    - **Import and Export are one page filtered two ways.** `data_jobs.kind`
      already separates them and the page already read `?kind=`, so the split
      the merchant sees costs two rail entries and no route.
    - **★ FAILURES READS EXISTING TABLES; IT DOES NOT ADD ONE.** Every failure
      is already recorded — a bounced email is an `email_logs` row, a dead
      refund is `order_refunds.status = 'failed'`, a broken import is a
      `data_jobs` row. A `failures` table would be a second copy of facts we
      hold, a write to forget on every new failure path, and a row that can
      disagree with the thing it describes. So `FAILURE_SOURCES` is a registry
      of READS (email, notification, refund, import, payment) — add a source =
      add an entry — and there is nothing to migrate, backfill, or prune (§32
      already prunes the underlying tables).
    - **★ SCOPE IS A DISCRIMINATED UNION, NOT AN OPTIONAL `storeId`.** These
      queries run under `withService`, which BYPASSES RLS, so tenant scoping is
      the caller's job (convention #2). An optional field would make "every
      store on the platform" the value you get by FORGETTING an argument — the
      worst available default. `{ kind: "platform" }` cannot be produced by
      omission, and it is constructed in exactly one file, the operator page.
    - **★ A PARTIAL ANSWER IS NEVER SHOWN AS A CLEAN ONE.** One source erroring
      must not blank the page — this view is read precisely when things are
      broken — so a failed source is caught, NAMED in `failedSources`, and
      rendered as a banner. A short list that looks healthy is the one wrong
      answer this feature must not give.
    - **Merging cannot paginate exactly**, so it takes the most recent 100 per
      source, merges, sorts and caps. Ties break on id, because the common case
      is a batch that failed together sharing one timestamp — without it the
      order shuffles between refreshes. Past that depth you are auditing, not
      triaging, and the individual logs are where that belongs.
    - **★ THE CLIENT/SERVER SPLIT IS LOAD-BEARING.** `failures.ts` imports the
      db client, which pulls in `pg`, which needs `fs` — so a client component
      importing the source catalog from it fails the BUILD (typecheck passes
      happily). The filter chips therefore read `FAILURE_SOURCE_META` from
      `failure-types.ts`, the same split `lib/themes/meta.ts` makes, with a test
      asserting the two catalogs stay in step.
    - **The operator view is the same feed unscoped**, at
      `/dashboard/failures` on the platform host, gated by the console's
      `getServerUser` + `getPlatformViewer` pair. ⚠ It shows only
      MERCHANT-READABLE failures. Stack traces and platform internals stay in
      Cloud Logging / Error Reporting, which already group and alert on them;
      copying them into a table would be a worse duplicate that nobody prunes.
    - **⚠ SMS and Push are NOT here**, and can't be: both are marked
      `available: false` in `lib/notifications/channels.ts` with no provider
      connected. A log of sends that never happen is an empty table. They need
      a provider (Twilio/MSG91, FCM) first — the log is the last 10% of that
      work.
    - **⚠ The activity feed is still day-grouped CARDS** while the other four
      are tables. Left alone deliberately: it is working UI, and a
      chronological event stream reads better as cards than as rows.

34. **Platform → merchant billing (IN PROGRESS — schema only, nothing applied).**
    Full design: **`docs/billing-architecture.md`**. This is StoreMink billing its
    OWN merchants, and is distinct from §17 (a merchant invoicing their shopper)
    and §18 (a merchant's BYO gateway). Greenfield: there are no production
    customers, so it REPLACES the Razorpay-Subscriptions design rather than
    migrating it. Phases 1–2 are done; §3 onward is unbuilt.
    - **★★ THE PRICE MUST NOT LIVE IN A PROVIDER-SIDE PLAN.** Razorpay's own
      docs: _"You can only update a Subscription authorised using cards and not
      via UPI and Emandate."_ Every amount change — tier, period, locations —
      goes through `rzpUpdateSubscription`, so on a UPI or e-mandate mandate
      `changePlan` AND `changeBilledLocations` are both **dead**, and add-ons
      (the usual escape hatch) are deprecated. So StoreMink computes the amount
      and the gateway merely collects it: token-based recurring, not
      Subscriptions.
    - **★★ TWO DIFFERENT CEILINGS, AND CONFLATING THEM IS THE COMMON ERROR.**
      A mandate's registered `max_amount` is the most it may EVER be debited for
      (₹1,00,000+ on UPI, effectively uncapped on cards). The **AFA-exempt
      limit** is the most that can be taken without the customer authenticating
      that specific debit — **₹15,000**, UPI and cards alike (RBI _Digital
      Payments — E-mandate Framework, 2026_; raised from ₹5,000 on 16 June
      2022). A ₹2,00,000 mandate does NOT make a ₹50,000 debit automatic, only
      permitted. `collectionRoute` (`lib/billing/cycle.ts`) is therefore a
      CONJUNCTION of both, and fails closed on an unrecorded max.
      ⚠ The ₹1,00,000 AFA exemption is real but reaches only insurance
      premiums, mutual-fund subscriptions and credit-card bills. A SaaS
      subscription is none of those.
    - **★★ THE X+3 RULE RESHAPES THE TIMELINE.** RBI requires a pre-debit
      notification ≥24h ahead and Razorpay's guidance is that a recurring
      payment takes **X+3 days** to confirm. So collection starts at
      **T−4 days**, not at cycle start: the naive loop would expire the 2-day
      grace **before the payment result was even known** and downgrade merchants
      whose money was still in flight. A consequence that resolves an
      ambiguity — the amount freezes at T−4, so a location added at T−2 bills
      NEXT cycle.
    - **★ 30 DAYS MEANS 30 DAYS; YEARLY IS 365** (owner, 2026-08-11). A
      DURATION, never a calendar unit, so February and leap years get no special
      case — and the tests assert exactly that, in the inverted direction. Two
      intended consequences: the billing date DRIFTS (1 Aug → 31 Aug → 30 Sep,
      so "we bill on the 1st" is never true), and a 365-day year is not an
      anniversary — a cycle starting 1 Jan 2028 ends **31 Dec 2028**.
    - **★ THE MANDATE COVERS THE RENEWAL, NOT EVERY FUTURE PURCHASE.** A failed
      renewal costs a grace period and possibly the merchant; an upgrade that
      needs re-authorisation happens while the merchant is on screen, which is a
      fine place for friction. The superseded `mandateMaxPaise()` had this
      backwards — no arguments, one global ₹2,00,000 for everyone, over half of
      it provisioning locations a Basic plan cannot buy. `mandateSizePaise`
      sizes on plan + billed locations, ×1.18 tax, ×1.5 reprice headroom
      (Basic yearly ⇒ **₹27,000**).
      **★★ The tax provision is applied even while `tax_enabled` is false** —
      GST turns Basic yearly into ₹17,700, and a mandate sized on the bare price
      would be REFUSED at the first post-GST renewal for everyone who signed up
      before the switch.
    - **★ CONSTRAINTS, NOT APPLICATION LOGIC** (invariant 3). Duplicate renewal
      invoices are impossible via `unique (store_id, kind, cycle_seq)`; two
      in-flight payment attempts via a partial unique on `invoice_id`; two
      active mandates via a partial unique on `store_id`. And
      `billing_claim_downgrade()` is ONE statement re-checking state, deadline,
      the comp exemption and whether the invoice was paid — so a payment racing
      the downgrade, a payment at the exact boundary, and the job running twice
      all resolve with no lock and no read-then-write window.
    - **★ OUT-OF-ORDER WEBHOOKS ARE SOLVED BY A MONOTONIC STATE MACHINE**, not
      by comparing timestamps: `captured`/`refunded` are terminal, so a late
      `payment.failed` is rejected by the machine itself. `unknown` is a
      first-class state whose only exit is provider verification — `RzpResult`
      (`lib/payments/razorpay.ts`) already distinguishes `rejected` from
      `unknown`, so this needs no new plumbing, only callers that respect it.
    - **★ A PAYMENT AFTER DOWNGRADE NEVER REACTIVATES THE PLAN**, and it also
      never takes money for nothing: the invoice becomes `uncollectible` and
      unpayable, and any money that still arrives becomes an `account_credit` in
      `billing_credits` against their next subscription.
    - **★ GST IS OPERATOR-CONFIGURED** (owner, 2026-08-11), in the singleton
      `platform_billing_settings`. Tax is OFF until a GSTIN exists, a CHECK
      refuses enabling it without one, and turning it on is NEVER retroactive
      because finalized invoices are immutable by trigger.
      **★ `tax_inclusive` (billing_05) picks INCLUSIVE or EXCLUSIVE pricing.**
      Exclusive (default) = ₹15,000 + 18% = ₹17,700; inclusive = ₹15,000
      charged, carved as `gross × r / (1 + r)` — **not** `gross × r`, which
      would under-declare output tax on every invoice. Under inclusive,
      enabling GST later changes nothing a merchant pays and more plans stay
      auto-collectable (Basic yearly stays ON the ₹15,000 AFA line rather than
      over it); under exclusive it raises every bill 18%, which is the whole
      reason `mandateSizePaise` provisions ×1.18 — a provision it drops when
      inclusive. ⚠ The mode must match what the pricing page advertises.
      **⚠ Its own migration file, because `billing_01` is APPLIED** — editing a
      `CREATE TABLE IF NOT EXISTS` that has already run is a silent no-op
      (§15b's `subscriptions_02` incident). The document series is
      gapless per Indian FY, allocated **on finalization** by trigger (a draft
      that is abandoned must not burn a number — the §28 credit-note reasoning)
      and routed through `sm_pad()`, never bare `lpad()` (§14).
    - **★ A COMPED STORE IS NEVER BILLED AND NEVER DOWNGRADED.** It has no
      mandate and no invoice, so the renewal worker skips it and the downgrade
      claim excludes it; `billingMayApplyPlan`'s comp-is-a-floor rule survives
      unchanged.
    - **★ DOWNGRADE FORCE-CLOSES AN OPEN POS SHIFT** with a system note (owner,
      2026-08-11), in the same transaction. `posEnabled` goes false, so the till
      stops; an open shift holds uncounted cash and leaving it open strands the
      drawer. Closed at `counted = expected` and attributed to the system — a
      variance invented by a billing event would read as a cashier being short.
    - **★ THE MERCHANT'S END IS WIRED (`/dashboard/plans`).** Subscribing goes
      through `startSubscribe` → Razorpay ORDER → `confirmSubscribe`, not
      `startPlanSubscription`, so the first cycle is a one-time payment on the
      verified checkout and no amount lives in a provider-side plan. Two things
      the flow says out loud rather than assuming: a confirm that fails is a
      `toast.info` carrying the server's own wording (money may have moved —
      §26's rule), and `autopay: false` is stated plainly, because a merchant who
      assumes autopay is simply downgraded at the next cycle.
    - **★★ `OpenInvoices` IS NOT A NICETY — IT IS THE ONLY WAY A RENEWAL GETS
      PAID.** Automatic collection is gated behind `RECURRING_CHARGE_VERIFIED`,
      so every invoice the worker writes is settled by hand or not at all; with
      no surface for it, a merchant is downgraded 48 hours later for a bill they
      never saw. It renders ABOVE everything on the page and renders NOTHING when
      nothing is owed. A `processing` invoice shows "payment in progress" instead
      of a Pay button — offering one would open a second payment against the same
      money, which the partial unique index would refuse anyway.
    - **★★ `startEnrolment` REFUSES A STORE ALREADY ON A PAID CYCLE.**
      `seedSubscription` is an upsert on `store_id`, so without the guard a
      merchant on Basic could point their `billing_subscriptions` row at Pro and
      dismiss the payment window: the record moves, the money does not, and the
      flow then fails confusingly ("already paid for") because cycle 1's invoice
      was settled months ago. Fails CLOSED on a read error — unable to read means
      unable to rule out billing the same store twice. Changing tier mid-cycle is
      a PRORATED plan change, a different operation.
    - **★★ `lib/billing/invoice-types.ts` EXISTS BECAUSE A `type` EXPORT FROM A
      `"use server"` FILE FAILS THE BUILD.** Every export of one of those files
      is registered as a server action, so `export type { PayableInvoice }` emits
      an action reference for a binding that erasure has already removed —
      `Export PayableInvoice doesn't exist in target module`. **`tsc` and
      `eslint` both pass**; only `npm run build` catches it. It cannot live in
      `manual-pay.ts` either, which is `server-only`. Third instance of this
      shape in the codebase, after `lib/logs/failure-types.ts` and
      `EXTRA_LOCATION_KEY` in `lib/plans.ts`.
    - **★★ ISSUING AN INVOICE IS NOT CHARGING IT** (`lib/billing/renewal-worker.ts`,
      `charge: ChargeFn | null`). The cron used to skip pass 1 ENTIRELY when the
      gateway was unavailable — and pass 1 is what calls `ensureRenewalInvoice`,
      so with collection gated **no invoice was ever written**. Pass 2 then found
      nothing and recorded `waiting`; grace never opened; nobody was ever
      downgraded. Every subscriber would have received free service past their
      cycle end, indefinitely, while the job reported green hourly — and the
      manual payment surface listed nothing, because there was nothing to list.
      A null `charge` now issues and FINALIZES the invoice, then stops and
      reports `manualRequired` — never `failed`, which starts the grace clock.
      Still not a stub charge: an unreachable provider is an UNKNOWN outcome, so
      every attempt would sit in reconciliation forever.
    - **★★ `lib/billing/dunning.ts` — THE WORKER'S VOICE, AND WITHOUT IT THIS IS
      NOT A BILLING SYSTEM.** Three moments the merchant can act on: the invoice
      issued (four days' notice), the 48-hour overdue warning, and the
      downgrade. With collection gated, that first email IS how a merchant
      learns they must pay; silently issuing, waiting, then stopping their till
      is the alternative. Email from here (platform correspondence from
      `billing@storemink.com`), in-app from the registry — the §24
      dedicated-sender rule, so `subscription.invoice_due` is IN_APP and
      `configurable: false` (an opt-out would let someone lose their plan for a
      bill they switched off).
      - **★ EACH NOTICE RIDES A CLAIM THAT ALREADY EXISTED**, so none needed a
        `notified_at` column: `finalizeInvoiceClaimed` (an invoice finalizes
        once), the active→past_due UPDATE with `returning()` (once per grace
        window), and `billing_claim_downgrade()`. The cron is an HOURLY
        HEARTBEAT re-reading the same rows, so without that property each of
        these mails the same merchant every hour — §23's pickup-reminder rule.
      - **★ `finalizeInvoice` COULD NOT TELL "I finalized it" FROM "I observed
        it finalized"** — it re-reads the row, so a caller that lost the race
        still got a finalized invoice back and believed it won. Harmless for
        control flow, not harmless for a bill: `claimDue` deliberately takes no
        lock, so two overlapping runs would have mailed it twice.
        `finalizeInvoiceClaimed` returns `{invoice, claimed}`.
      - **★ AUTOPAY TRUE ONLY WITH A GATEWAY **AND** A MANDATE.** It decides
        what the email IS — a heads-up before a debit, or a bill. A merchant
        told "we'll collect this automatically" does nothing and is downgraded.
        Same rule for `attempted` on the overdue notice: "we couldn't take
        payment" describes a charge that never happened and sends them to check
        a card nobody touched.
      - **⚠ MAILED OUTSIDE THE TRANSACTION, ALWAYS.** An email is a network
        call; sending it inside `withService` holds a pooled connection open for
        an HTTP request (the reason `claimDue` takes no lock), and would
        announce a grace window a rollback then un-started.
      - **★ BEST-EFFORT, NEVER THROWS.** A mail outage must not fail a
        collection, block a cycle advance, or abort a downgrade.
    - **★ SIGNUP ENROLS ON THE NEW SYSTEM** (`startSignupSubscribe` /
      `confirmSignupSubscribe`). The wizard runs on the PLATFORM host, where
      `getActingStoreId()` resolves the FALLBACK store rather than the one created
      seconds earlier — so the client names the store and
      **`assertStoreSuperadmin` is the entire security boundary**: without it any
      signed-in user could post another store's id and buy, or settle, a
      subscription on it. Superadmin, not any admin, mirroring the old gate — a
      new path to the same act must not be easier to pass than the one it
      replaces — and it returns null on a read error, so a blip refuses rather
      than authorises. Both entry points delegate to
      `startSubscribeForStore`/`confirmSubscribeForStore`, the SAME cores the
      dashboard uses: a second copy of the plan validation, legacy-mandate check
      or price lookup is how a merchant gets billed differently depending on
      which screen they subscribed from.
    - **★★ AN ENROLMENT IS AN OFFER; A RENEWAL IS AN OBLIGATION.**
      `startEnrolment` deliberately does NOT finalize its invoice —
      `confirmEnrolment` does, once the payment verifies. Finalizing up front did
      three bad things at once: it burned a number in the gapless GST series for
      a document nobody ever received (the exact waste that allocating ON
      finalize exists to prevent), it made the invoice `open` so
      `/dashboard/plans` demanded payment for a plan that was never granted, and
      it dated the document to the Subscribe click rather than the payment. The
      renewal worker still finalizes BEFORE charging, because there the merchant
      already has the plan and genuinely owes it.
    - **★★ A DISMISSED CHECKOUT USED TO BE A PERMANENT DEAD END.** Closing the
      Razorpay modal leaves the attempt `processing` forever — nothing tells us a
      modal was closed — and `billing_payment_attempts_one_in_flight` then
      refused every later attempt, so "A payment is already in progress" was the
      answer to Subscribe FOREVER. Reproducible in two clicks. `startEnrolment`
      now hands back the SAME Razorpay order, which stays payable until paid —
      the §18 "Retry payment" pattern, with no staleness guess and no risk of a
      second charge. ⚠ Only a `processing` attempt is resumable: the index also
      covers `created` (no order exists yet) and `authorized` (money already
      authorized — re-opening checkout would invite a second authorization).
    - **★★ EXTRA LOCATIONS ARE BOUGHT ON THE NEW SYSTEM** (`lib/billing/locations.ts`,
      `supabase/billing_07_addon_invoices.sql`). The old path called
      `rzpUpdateSubscription`, which Razorpay does not support for UPI or
      e-mandate mandates — so for most Indian merchants buying a location silently
      did not work at all, and could not be made to. Here StoreMink prices it: the
      part period is a one-off payment on the verified checkout, and every future
      cycle is billed from `billed_locations` by the renewal worker, needing no
      gateway call.
      - **★ A THIRD INVOICE KIND, `addon`, carrying NO `cycle_seq`.** A renewal
        invoice is one per cycle and idempotent on it; a mid-cycle purchase happens
        at an arbitrary moment and can happen twice in one cycle. Because
        `billing_invoices_one_per_cycle` is already partial on
        `cycle_seq is not null`, several addons per cycle need NO index change —
        the same trick `ai_credits` relies on.
      - **★★ THE GRANTED COUNT LIVES ON THE INVOICE** (`addon_target_count`), not
        in the confirm request. `confirm` is a public server action, so reading
        the count from the client would let a caller be granted more locations
        than it paid for.
      - **★ BUYING APPLIES NOW; RELEASING WAITS FOR THE CYCLE END** — the §15b
        rule, whose point is that **nobody is ever refunded**. A release writes
        `scheduled_locations`, and `advanceCycle` applies it in the SAME statement
        that turns the cycle; writing `billed_locations` down at once would refuse
        a merchant a shop they own and are still paying for.
      - **★★ AND THE INVOICE FOR THE NEXT CYCLE MUST BE PRICED WITH THE SCHEDULED
        COUNT.** Pricing at today's count and then dropping it at the turn charges
        a full extra cycle for a released shop — the one direction "nobody is
        refunded" must not be allowed to mean. So `collectOne` reads
        `scheduledLocations ?? billedLocations`, and a release booked INSIDE the
        T−4d window is REFUSED with the date it becomes possible again, because
        that invoice is already issued and immutable. Closing that properly needs
        the schedule to carry the cycle it applies from.
      - **★ THE MANDATE CEILING IS CHECKED BEFORE THE SALE.** The part period is
        on-session and unaffected by it, but every future cycle is debited
        automatically against a ceiling fixed when autopay was authorised. Selling
        a location that makes the next renewal undebitable is how a paying
        merchant gets downgraded.
      - **★ A ZERO PART PERIOD GRANTS IT INSTEAD OF CHARGING ₹0** — at the end of
        a cycle the proration rounds to nothing and Razorpay refuses a ₹0 order.
        The merchant gains a few hours; the next renewal bills it in full.
    - **★★ CANCELLING IS A FLAG, NOT A GATEWAY CALL** (`lib/billing/cancel.ts`).
      The old path asked Razorpay to cancel the Subscription, so it could fail for
      reasons unrelated to the merchant's intent — commonest being _"Subscription
      cannot be cancelled since no billing cycle is going on"_, which hit anyone
      cancelling before their first charge and left them stuck. Now
      `cancel_at_period_end = true`, which cannot fail for a provider's reasons.
      - **★ THE MANDATE IS REVOKED IMMEDIATELY**, even though the flag alone stops
        the next charge. A live mandate is standing permission to debit; someone
        who cancelled has withdrawn it, and "it doesn't matter, nothing will
        charge it" is the reasoning that turns one bug into a debit.
      - **★ RESUMING EXISTS NOW** — the old flow could not offer it, because the
        gateway subscription was gone. ⚠ It does NOT restore autopay: only the
        merchant can authorise a new mandate, and saying otherwise has them expect
        a charge that never comes.
      - **★ `claimDue` SKIPS a cancelled subscription** and `evaluateCycleTurns`
        ENDS it at the period end. Without the second half the merchant sits in
        `waiting` forever — still entitled to a plan they stopped paying for.
    - **★★ PLAN AND PERIOD CHANGES** (`lib/billing/plan-change.ts`). Dearer applies
      NOW and is paid for through the SAME `addon` invoice a location purchase
      uses; cheaper or equal books `scheduled_plan`/`scheduled_period` for the
      cycle end. One payment shape for every mid-cycle charge means one place
      money can go wrong, not three. Period changes are first-class at last —
      they were impossible before because `scheduled_plan` cannot express
      "same tier, different period".
    - **★★ `lib/billing/next-cycle.ts` — ONE RESOLVER, because THREE callers must
      agree days apart:** pass 1 PRICES the next invoice at T−4d, pass 2 WRITES the
      shape at T0, and the plans page TELLS the merchant. If pricing and writing
      disagree someone is billed for something they did not get, silently, a month
      later. It also decides two things that are easy to get wrong separately:
      **a cancellation is not a change** (`ending` wins over any booked downgrade —
      applying it would renew them onto a plan they explicitly stopped), and **a
      plan with no POS carries no billable locations** (zeroed here, so the invoice
      and the write cannot differ; the stored count is NOT cleared, so returning to
      Pro resumes billing for shops they still hold).
    - **★★ TAX IS OPERATOR-CONFIGURED, ON A REAL SCREEN**
      (`/dashboard/billing` on the platform host; `lib/billing/platform-settings.ts`).
      `platform_billing_settings` had existed since `billing_01` with NOTHING
      writing it, so tax could only be switched on by hand-editing SQL — the
      requirement (owner, 2026-08-11) was schema-only until now. Superadmin to
      edit, any operator to read, because "are we charging GST?" is a support
      question that needs no write grant.
      - **★ ENABLING IT REQUIRES A GSTIN, A STATE AND A LEGAL NAME.** The first is
        also a DB CHECK (`platform_billing_tax_needs_gstin`) — an invoice charging
        GST while naming no GSTIN is not a valid tax invoice and the merchant
        cannot claim input credit against it. The state is NOT a constraint but is
        just as load-bearing: `splitGst` compares it against the merchant's to
        choose CGST+SGST vs IGST, so without it every invoice is silently treated
        as intra-state.
      - **★★ THE GSTIN CARRIES THE STATE, and a mismatch is refused.** Its first
        two digits ARE the state code (`stateCodeFromGstin`), so if they disagree
        with the state selected one of them is a typo — and the resulting wrong
        tax split is invisible on the invoice and expensive at filing time.
      - **★★ INCLUSIVE vs EXCLUSIVE CHANGES WHAT MERCHANTS PAY**, not how the
        invoice reads, so the screen states the consequence in rupees against a
        ₹5,000 plan rather than naming the modes. It must match what the pricing
        page advertises or every merchant is over- or under-charged from the next
        invoice onward.
      - **★ TURNING TAX ON IS NEVER RETROACTIVE** — finalized invoices are
        immutable by trigger — and the screen says so, because the intuition
        ("I've added my GSTIN, now everything is a tax invoice") is the opposite.
      - `GST_STATES` + `gstStateName` live in the PURE `lib/billing/gst.ts`, so the
        client form can import them; `platform-settings.ts` is `server-only` and
        `PlatformTaxSettings` therefore lives in `invoice-types.ts` (the third
        instance of that split). The retired codes `25` and `28` are deliberately
        omitted from the picker but still parse, because a merchant's stored code
        may be one.
    - **★★ MERCHANTS CAN SEE AND PRINT THEIR INVOICES**
      (`/dashboard/plans/invoices`, `lib/billing/invoice-history.ts`). The gapless
      FY series, the immutability triggers and the tax snapshot all existed to
      produce a document nothing could retrieve — the only reader was
      `listPayableInvoices`, which shows what is OWED, so a merchant who had paid
      ₹50,000 for a year had no receipt.
      - **★ ONLY FINALIZED INVOICES ARE DOCUMENTS.** A draft has no number (the
        trigger allocates one on finalize precisely so an abandoned checkout does
        not burn one), and enrolment and add-on purchases BOTH leave drafts behind
        whenever a payment window is closed. Showing one would present an
        unnumbered, unpaid row as a bill.
      - **★★ THE TAX IDENTIFIERS WERE NEVER SNAPSHOTTED, and now are.**
        `supplier_gstin` / `customer_gstin` / `place_of_supply` have existed since
        billing_03; every creator ACCEPTED them and no caller passed one, so every
        invoice stored NULL. The document would then have had to name a GSTIN from
        LIVE settings — so an operator correcting one in September would rewrite
        what April's invoice claims. `loadInvoiceParties` + a stamp at all four
        creation sites fixes it. ⚠ The NAMES and ADDRESSES are still read live,
        because no column stores them; closing that needs a `parties jsonb`.
      - **★★ A NO-TAX INVOICE IS A VALID INVOICE** and must not pretend otherwise:
        titled "Invoice" not "Tax Invoice", NO GST line at all (a "GST ₹0" row on a
        document naming no GSTIN reads as a claim), and a footer saying why. It is
        the state every invoice is in today.
      - **★ The GST split comes from the tax AMOUNT** (`splitGstPaise`), never
        recomputed from the rate, so the halves always re-sum to what was charged.
        Intra-state ⇒ CGST+SGST, inter-state ⇒ IGST, decided by comparing the
        supplier GSTIN's first two digits with the snapshotted place of supply.
      - Printable HTML, not a server PDF — the §17 decision, reusing that module's
        `.invoice-sheet` print isolation and `PrintInvoiceButton`. The INNER
        classes are `sminv-*`, deliberately NOT the `inv-*` ones: those are shaped
        for the order invoice's different markup and would silently mis-style this.
    - **★★ RECONCILIATION — SETTLING WHAT WE NEVER LEARNED**
      (`lib/billing/reconcile.ts`, run first in the hourly cron).
      `collect.ts` is deliberate that an UNKNOWN outcome is never a failure and
      never retried, because a retry might charge twice — which is right, and left
      the attempt in `unknown` forever with nothing to resolve it. `processing` is
      the same: nothing tells us a merchant closed the payment window.
      `billing_reconciliation_items` had existed since billing_04 with NOTHING
      writing or reading it.
      - **★ IT ASKS THE GATEWAY, IT DOES NOT GUESS.** The only evidence that
        settles an attempt as paid is a CAPTURED payment on the order we created,
        via `rzpFetchOrderPayments` + `capturedPayment` — the VERIFIED pair §18
        has used in production, not the unverified recurring endpoint. So it works
        today, with autopay off.
      - **★★ THE TWO DIRECTIONS ARE NOT SYMMETRIC.** Finding money is safe and
        runs after 15 minutes: a captured payment means they paid, and recording
        it can only help. Declaring FAILURE frees the invoice for a fresh
        attempt — so doing it to a payment still in flight invites a second
        charge — and waits **72 hours**, only ever on the gateway's word that
        nothing was captured. An ANCIENT attempt that WAS captured is recovered,
        never failed: age is not evidence.
      - **★ RECOVERY ADVANCES THE CYCLE.** Without it a merchant who really did
        pay stays in grace and is downgraded, because the only thing that moves a
        cycle is a paid invoice being NOTICED.
      - **★ AN AMOUNT MISMATCH IS FLAGGED, NOT AUTO-FIXED.** The payment is
        recorded either way — they paid — but what happens to the difference is a
        human decision. Deduped by the partial unique index, so an hourly sweep
        cannot bury the queue it exists to surface.
      - **★ IT RUNS BEFORE PASS 2**, because pass 2 decides grace and downgrade
        from whether the invoice is paid; running it after would downgrade a
        merchant whose payment that very request discovers. Pinned by a test.
      - ⚠ It only sees attempts that reached the gateway (`provider_order_id` set)
        — one that died before that has nothing to ask about.
      - **★★ THE QUEUE IS A SCREEN NOW**
        (`/dashboard/billing/reconciliation` on the platform host, filtered by
        `?status=`; `listReconciliationItems` / `countOpenReconciliationItems` /
        `resolveReconciliationItem`). Every item is a discrepancy the sweep
        deliberately refused to decide, so leaving them readable only by SQL
        meant the one queue in the system that EXISTS to summon a human summoned
        nobody. The Billing & tax page carries the open count, amber when it is
        not zero.
        - **★★ CLOSING AN ITEM MOVES NO MONEY, and the screen says so at the
          point of action** rather than in a header nobody re-reads. Refunding a
          difference or issuing a credit happens on the store's own billing
          screens, chosen by a person. A button here that "fixed" a discrepancy
          would be a money movement nobody reviewed — and worse, it would leave
          the queue looking clean. Pinned by a test, because that sentence is the
          only thing standing between the two readings.
        - **★ THREE OUTCOMES**, since "resolved" alone is a lie in two common
          cases: genuinely settled, needs chasing (`manual_review`), and turned
          out not to matter (`ignored`). Collapsing them loses the difference
          between "dealt with" and "decided not to".
        - **★ A NOTE IS REQUIRED**, in the UI and again in the action. The row
          records that a human looked; without what they FOUND it is an
          audit trail that proves only that somebody clicked.
        - **★ THE CLOSE IS A CONDITIONAL CLAIM** on `status = 'open'`, so two
          operators working the queue at once cannot overwrite each other's
          verdict — the loser is told it was already closed.
        - **★ ANY OPERATOR MAY CLOSE, not just a superadmin.** This records a
          judgement rather than moving money, and a queue only the owner can
          clear is a queue nobody clears. Who did it is stored either way.
        - **★ A NULL STORE IS ITSELF THE PROBLEM** — an orphan payment nobody
          can attribute — so the row says "needs attributing" rather than
          rendering a blank that reads as a bug.
        - ⚠ **TEST GAP**: the db mock does not evaluate WHERE clauses, so the
          `status = 'open'` predicate is argued rather than pinned; the
          behaviour that depends on it (a zero-row claim reported as
          already-closed) IS covered.
    - **★★ AI CREDIT PURCHASES NOW PRODUCE AN INVOICE**
      (`lib/billing/credit-invoice.ts`, `supabase/billing_08_ai_credit_invoice.sql`).
      `kind = 'ai_credits'` has existed since billing_03 and
      `buildAiCreditsInvoice` / `createAiCreditsInvoice` were written, tested and
      NEVER CALLED — a credit purchase produced no document at all. Survivable
      while merchants could see no invoices; once `/dashboard/plans/invoices`
      listed them, a purchase appearing nowhere is a receipt they cannot produce.
      - **★ CREDITS GET THEIR OWN INVOICE, never a line on a subscription one**
        (spec §1, §14). They are a one-off at an arbitrary moment; a subscription
        invoice covers a period and is idempotent on its cycle. Carrying no
        `cycle_seq` is what keeps it outside `billing_invoices_one_per_cycle`, so
        a merchant can buy twice in a month.
      - **★★ ISSUED FROM `settlePurchase`, THE ONE PLACE A PURCHASE BECOMES PAID**
        — reached both from `confirmCreditPurchase` and from the reconcile-on-read
        sweep. Hooking only the confirm path would leave every reconciled purchase
        without a document, which is exactly the case where the merchant is
        already unsure what happened. Pinned by a mutation.
      - **★ DRAFT AT PURCHASE, FINALIZED ON PAYMENT** — the enrolment rule, so an
        abandoned checkout never burns a number. And the draft is raised AFTER the
        gateway order, so a purchase that died there leaves no document at all.
      - **★ The link lives on the PURCHASE** (`ai_credit_purchases.invoice_id`,
        UNIQUE where not null), not on the invoice: `billing_invoices` is the
        generic document table and already carries one product-specific column, so
        a second would start a pattern of one per product.
      - **⚠ APPLY `billing_08` BEFORE DEPLOYING.** Without the column the link
        UPDATE throws, the function returns null, and credit purchases keep
        working with no document — but each leaves an orphan DRAFT invoice, which
        is harmless (invisible, unnumbered, never finalized) and untidy.
      - **⚠ Purchases made BEFORE this get no invoice, deliberately.** Issuing one
        today would put a number from the CURRENT financial year's series on a
        months-old sale, which is worse than no number.
      - ⚠ `app/actions/ai-credit-actions.ts` had NO tests at all before this,
        despite being a money path. It now has ten, covering the invoicing half
        only; the plan gate, the `add_ai_credits` RPC and reconcile-on-read are
        still uncovered.
    - **★★ `lib/billing/receipts.ts` — THE ACKNOWLEDGEMENTS, AND ALL THREE WERE
      REGRESSIONS.** The old path sent them (`planActivatedTemplate` from
      `confirmSubscription`, `paymentReceiptTemplate` and
      `subscriptionCancelledTemplate` from the webhook) and deleting it took them
      with it — so for a few days a merchant could subscribe, pay ₹50,000 and hear
      nothing at all, which is worse than the system it replaced. Kept SEPARATE
      from `dunning.ts`: dunning means debt collection, and a module holding both
      the chasing and the thank-yous ends up called "billing-emails-2".
      - **★★ THE RECEIPT COMES FROM `settleAttempt`**, the ONE place an invoice
        transitions to paid — so enrolment, manual payment, a plan change, a
        location purchase AND reconciliation each send exactly one, and none of
        them has to remember to. `syncInvoiceStatus` now CLAIMS that transition
        (its WHERE excludes `paid` when moving to paid) and reports it, which is
        what makes "exactly one" true. ⚠ That claim also fixed a quieter bug:
        `paid_at` used to be rewritten on every later sync, so a second attempt
        settling days afterwards moved the timestamp on an already-paid invoice.
      - **★ A CREDIT PURCHASE GETS NO SUBSCRIPTION RECEIPT.** A mail reading
        "your Pro plan is active" for a ₹59 credit pack is wrong; credits have
        their own confirmation (`ai.credits_purchased`).
      - **★ THE ACTIVATION MAIL WITHHOLDS THE RENEWAL DATE WITH NO MANDATE.** The
        template's copy says autopay is set up, so naming a date beside it
        promises a charge that never comes — and the merchant waits, and is
        downgraded. Same rule as the invoice-issued notice.
    - **★ SUBSCRIPTION FAILURES REACH THE FAILURES FEED** (§33). `FAILURE_SOURCES`
      gained a `subscription` entry reading `billing_payment_attempts` where
      `state = 'failed'`. Deliberately NOT folded into the existing `payment`
      source: that one is a SHOPPER's checkout failing (the merchant's revenue),
      this is the MERCHANT's plan payment failing (they are heading for a
      downgrade). Different audience, different consequence. It sorts on
      `resolved_at`, not `created_at` — an attempt can sit in flight for days, so
      the creation time would bury a fresh failure down a time-ordered feed.
    - **★★ THE OLD PATH IS GONE** (2026-08-13). Deleted: `subscription-actions.ts`,
      `lib/payments/subscription.ts` (the `razorpay_plans` cache,
      `resolveRazorpayPlanId`, `amountForRzpPlan`, `planForRzpPlan`,
      `mandateMaxPaise`), the five `rzp*Subscription`/`rzpCreatePlan` client calls,
      and `verifySubscriptionSignature` — a near-identical verifier with the
      REVERSE operand order sitting next to the real one is what autocomplete picks
      by mistake. The `store_subscriptions` and `razorpay_plans` TABLES remain as
      the old system's audit trail; nothing reads them.
      - **★ `createLocation` WAS STILL READING `store_subscriptions`** for the
        allowance and would have read 0 — silently refusing every merchant the
        extra locations they PAY FOR, with an error telling them to go and buy what
        they already own. Now reads `billing_subscriptions`. This is the class of
        breakage a deletion causes: the compiler is happy, because the table still
        exists.
      - **★ THE RAZORPAY WEBHOOK ROUTE IS KEPT, ACTING ON NOTHING.** It used to
        write `stores.plan` from `subscription.*` events; those now describe a
        gateway object StoreMink does not manage, so applying one would move a plan
        on the word of a timer our state machine knows nothing about. It still
        verifies the raw-body HMAC and records the exactly-once event marker —
        deleting the route would 404 every delivery (a retry storm that reads as
        our outage) and throw away the two pieces the new system's webhooks will
        need. ⚠ `billing_webhook_events` is not in §32's retention policies and
        grows one row per delivery.
    - **✅ `billing_01`…`07` ARE APPLIED** to both `storemink` and
      `storemink_staging` (2026-08-13). ⚠ They have an apply-order dependency
      (see the tree) — `billing_03`'s tables must exist before `billing_02`'s
      function is CALLED, because plpgsql resolves table names at call time, so
      the wrong order succeeds and then fails at runtime. `billing_06` was a
      no-op: `store_subscriptions` was empty in production, so there was nothing
      to migrate.
    - **⚠ Six Razorpay facts are still unverified**, and they gate AUTOPAY ONLY —
      not the system. Every path (enrolment, manual payment, plan change, location
      purchase) confirms ON SESSION against a verified one-time checkout, and the
      renewal worker issues invoices the merchant pays by hand. What is unverified:
      exact subsequent-charge
      endpoint signature, recurring webhook event names, retry and
      payment-failure behaviour, e-mandate specifics, MCC restrictions. Listed
      in the design doc's §10 rather than guessed; several need a test-mode
      account to settle.
    - **13 defects found in the current billing code while mapping it**, two of
      them live revenue bugs (`confirmSubscription` bypasses the comp floor and
      can overwrite a comp DOWNWARD; a scheduled location release never lands,
      so Razorpay bills the cheaper plan while the allowance keeps granting the
      released slots free). Ten live in code this rebuild deletes.

35. **Logistics — Shopify-shaped fulfilment, Shiprocket first.**
    `supabase/logistics_01_shiprocket.sql` deliberately separates four facts:
    `orders` are what a customer bought; `fulfilment_orders` are warehouse work
    assigned to a location; `shipments` are physical parcels/AWBs; and
    `shipment_events` are the append-only carrier history. This is the same
    separation that makes Shopify fulfilment extensible. StoreMink still ships a
    whole order from one routed location in v1, but no Shiprocket identifier is
    stored on `orders`, so later split fulfilment does not require an extraction
    migration. `shipment_items` and `fulfilment_order_items` already model the
    allocation.
    - **Checkout snapshots logistics data.** Products carry `requires_shipping`,
      grams and centimetres; variants may inherit or override. `placeOrder`
      copies SKU/HSN/physical values onto each `order_item`, then best-effort
      creates the location work object after durable lines exist. Booking calls
      `ensureFulfilmentOrder` too, which self-heals legacy orders and interrupted
      deployments.
    - **Each merchant brings their OWN Shiprocket account.** Channels verifies
      the API-user login before storing it. The password and cached token use the
      existing channel encryption key (`PAYMENT_CRED_KEY`); neither is returned.
      The connection can be paused without deleting history. The generated
      callback uses the provider-neutral `/api/webhooks/logistics/...` path
      because Shiprocket rejects webhook URLs containing its reserved provider
      keywords. Active locations
      with `online_fulfil` sync to stable Shiprocket pickup codes through
      `location_logistics_mappings`; incomplete addresses are named and skipped,
      never silently mapped to another warehouse. The pickup adapter promotes
      house/flat/road details from either saved location-address line and folds
      short secondary fragments into the primary line, matching Shiprocket's
      per-line validation without forcing existing merchants to re-enter data.
    - **Booking is a resumable state machine, not one giant API call.**
      `shipment-actions.ts` first claims a unique local idempotency key, then
      creates the Shiprocket order, assigns an AWB, generates the label and
      finally marks the fulfilment in progress. Every provider id is persisted
      immediately. If label generation times out after the AWB exists, retry
      resumes at label generation instead of creating a second parcel. Warehouse
      staff then schedule pickup and get a manifest. A manual courier fallback
      records the same provider-neutral shipment/events and marks the order
      shipped without pretending Shiprocket handled it.
      Checkout and booking share strict Indian-mobile normalization, including
      rejection of repeated placeholder numbers. Before any carrier identifier
      exists, staff may correct the frozen delivery phone in the order drawer;
      after Shiprocket accepts the parcel it is immutable in StoreMink.
    - **Carrier state is not order state.** `lib/logistics/status.ts` maps
      Shiprocket's numeric/text vocabulary to stable parcel statuses and refuses
      terminal or backwards transitions from late webhooks. The provider-neutral
      webhook route is addressed by connection UUID and authenticates
      Shiprocket's `x-api-key`
      against a SHA-256 hash; the token is shown only on creation/rotation.
      Events dedupe by content hash. Picked-up/in-transit/NDR/RTO move an eligible
      order to `shipped`; delivered moves it to `delivered` and stamps
      `delivered_at`. Cancelled orders are never revived. Customers receive only
      safe tracking fields/events after their normal owner+host check; raw
      payloads, credentials and provider IDs remain service-only.
    - **Operational UI.** The order drawer computes a parcel starting point from
      line snapshots, then supports booking, label/manifest links, pickup,
      tracking refresh, pre-pickup cancellation and NDR re-attempt/RTO. Product
      editing captures physical measurements. Customer order detail shows the
      courier, AWB, external tracking link and the latest scans.
    - **Checkout shipping policy is separate from the channel.** Channels answers
      “which provider account fulfils this”; Settings → Shipping & delivery
      answers “what does the customer pay and see.” `store_shipping_settings`
      supports always-free, one fixed order rate, or live Shiprocket choices; an
      optional merchandise-subtotal threshold makes fixed/live delivery free.
      Manual modes publish a merchant-entered day range. Live mode requests
      serviceability from the routed location with the authoritative parcel,
      declared value and COD flag, adds handling time/optional markup, and shows
      either the cheapest or five sorted couriers. `placeOrder` quotes again and
      stores the exact selected promise in `orders.shipping_option`; shipment
      booking uses that courier and carries the quoted provider cost/ETA.
      Digital-only and pickup orders remain ₹0 without a carrier call.
    - **Delivery discovery starts before checkout.** The storefront shell owns a
      host-local remembered delivery location. A signed-in shopper's default
      address fills it automatically unless they deliberately chose another PIN
      on this browser; “Use my current location” requests browser permission and
      reverse-geocodes only after a click. The header displays that destination.
      Every classic/grocery PDP can check a six-digit PIN. Its public,
      IP-rate-limited server action re-reads the published product/variant,
      online stock, physical measurements, fulfilment location and shipping
      policy, then returns the cheapest current option/ETA (or an unavailable
      reason). The product quantity participates in free-above pricing. Checkout
      still re-quotes authoritatively, especially because payment method can
      change COD serviceability. PDPs no longer claim “delivered tomorrow” or a
      hardcoded free-above amount.
    - **Deliberate v1 limits.** StoreMink does not yet expose postal zones,
      price/weight rate tables, product-specific shipping profiles, split one
      order across multiple warehouses/parcels, purchase return labels, or
      reconcile weight disputes/COD remittances. The schema and adapter boundary
      are ready for these, but claiming full Shopify parity before those workflows
      exist would be false.

## 6. Commands

> **Dev feels slow?** Read `docs/local-dev-performance.md` before tuning
> anything. It is measured, and the answer is almost never the bundler:
> compiles run 13 ms–1.5 s, while **every DB query costs ~46 ms** because
> `db:proxy` points at a Cloud SQL instance in Mumbai — so a page render spends
> 300–500 ms on network before React starts. The durable fix is a local
> Postgres (not built; the doc says what it would take). On an 8 GB machine the
> second cost is memory: the dev server grows to ~4.4 GB through a session and
> `.next/dev` to ~4 GB, so `rm -rf .next` plus a restart is the ten-second fix.

```bash
npm run dev         # next dev --turbopack (test stores via {slug}.localhost:3000)
npm run dev:lean    # ↑ with --max-old-space-size=3072. OPT-IN, not the default:
                    #   a heap cap trades CPU (more GC) for RAM, so it helps only
                    #   where RAM is the binding constraint — making it default
                    #   would slow every 16/32 GB machine to suit an 8 GB one.
npm run dev:all     # ↑ dev + the Cloud SQL Auth Proxy together (concurrently) — one command
npm run dev:all:lean # ↑ dev:all, with the heap cap
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
npm run test:shuffle # ★ the SAME suite in a different (fixed-seed) order — the only
                    #   thing that catches order-dependent tests. CI runs it.
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
      runs on so popup + email-link work — `localhost` and `storemink.com` (+ the
      staging equivalents). **ONE entry covers every subdomain**: the SDK matches
      `^(.+\.<entry>|<entry>)$`, so `storemink.com` authorises every
      `{slug}.storemink.com` and **`*.storemink.com` is neither needed nor
      accepted — Firebase rejects wildcards here.** MERCHANT custom domains are
      not covered by anything and are added automatically on verification (§30,
      `lib/auth/authorized-domains.ts`); without that, "Continue with Google" is
      dead on a merchant's own domain while email+password still works. Unlike Supabase there is NO
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
  never learned and dead addresses are mailed forever (§22). It is **per
  ENDPOINT, therefore per env** (`_RESEND_WEBHOOK_SECRET_SECRET` in
  `cloudbuild.yaml` → `RESEND_WEBHOOK_SECRET_{STAGING,PROD}`), unlike
  `RESEND_API_KEY`, which is one account-wide key. It went unwired on Cloud Run
  until 2026-08-01, so the whole suppression half of §24 was inert — the route
  degrades by logging and dropping the event, which is the failure you don't
  notice. Registration + secret creation runbook: `docs/gcp-ci-cd.md`.
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
  own Geolocation API: free, keyless, and works with the map switched off. The
  resulting current-device coordinates are reverse-geocoded client-side through
  BigDataCloud's keyless `reverse-geocode-client` endpoint to fill city/country;
  this is deliberately a same-browser call (the provider's fair-use contract)
  and Google remains the optional street-address + draggable-map enhancement.
- **Search-engine indexing** (`lib/seo/search-engines.ts`; full runbook in
  `docs/seo-indexing.md`): only the **production apex** is indexable —
  `SEARCH_INDEXABLE` in `lib/store/host.ts` (`ROOT_DOMAIN === "storemink.com" &&
NEXT_PUBLIC_NOINDEX !== "1"`) is the single gate for `robots.ts` (non-prod →
  `Disallow: /`), `sitemap.ts` (non-prod → empty), AND both notify channels, so
  staging/previews are auto-`noindex`d and never ping (no per-deploy flag; staging
  runs as `NODE_ENV=production` on Cloud Run, so the old `NODE_ENV` guard was
  insufficient). IndexNow needs no account (public key file `public/<key>.txt`;
  `INDEXNOW_KEY` overrides it, `INDEXNOW_FORCE=1` pings off-prod). Google Search
  Console submission is DORMANT until `GOOGLE_SEARCH_CONSOLE_PROPERTY` (e.g.
  `sc-domain:storemink.com`) is set — auth is then the **runtime service account
  via ADC** (nothing to store; `cloudbuild.yaml` passes the property, prod trigger
  = `sc-domain:storemink.com`), or an explicit `GOOGLE_SEARCH_CONSOLE_CREDENTIALS`
  key JSON for non-GCP hosts. One-time human setup: verify `storemink.com` as a
  Search Console Domain property (covers all `*.storemink.com`), add the
  `storemink-run@…` SA as a property user, enable the Search Console and Site
  Verification APIs, and create the `storemink-seo-refresh` Cloud Scheduler job.
  `lib/seo/store-indexing.ts` is the single store discovery pipeline: publish
  paths call it after commit, and `/api/cron/seo-refresh` registers the platform,
  help, POS, and themes sitemaps before reconciling every
  active/launched/non-demo store daily. StoreMink subdomains submit under the
  Domain property. A verified custom domain gets a Google META token in public
  `stores.settings`, an automatically verified URL-prefix property, and its own
  sitemap submission. Google's META verification response is a complete HTML
  tag, but Next metadata accepts only its `content` value; the pipeline
  normalizes that value before storage and also repairs legacy full-tag values
  so the tag cannot be escaped inside another tag. Attempt/success/error
  timestamps are persisted;
  successful stores are refreshed at most weekly, failures retry daily and make
  the cron return 503 so Cloud Scheduler's three retries engage. Full setup and
  Google-controlled limitations: `docs/seo-indexing.md`.
  **A store's public origin is always selected by `storeOrigin(store)`.** Never
  use `custom_domain ?? subdomain`. The custom domain counts only once
  `settings.custom_domain_verified === true` and the effective plan is still
  entitled to custom domains, the same two gates `lookupStoreByHost`
  (`lib/store/resolve.ts`) applies when deciding whether to serve that domain. A
  lapsed timed plan therefore falls back to the working StoreMink subdomain in
  routing, canonical, robots, sitemap and notifications together.
  `saveCustomDomain` writes `custom_domain` while clearing the verified flag, so
  every merchant passes through a state where the store is served on its
  subdomain. Pointing canonical, `og:url`, robots `Host:`, sitemap `<loc>` or an
  IndexNow ping at that unverified domain makes Google follow an unreachable
  canonical and can drop the working URL as "Alternate page with proper
  canonical tag". `getStoreUrl()` and `getStoreOriginById()` both route through
  `storeOrigin()`; regression-tested in `lib/site.test.ts`. Related: a
  store-shaped host that resolves to no store (unclaimed subdomain, suspended
  store, unseeded demo) returns `Disallow: /` plus an empty sitemap instead of
  advertising StoreMink's platform URLs.
  **`app/sitemap.ts` emits no fabricated `lastmod`.** Each URL derives it from a
  real content timestamp or omits it, guarded by `app/sitemap.test.ts`. Products
  use `products.content_updated_at`
  (`supabase/seo_01_product_content_timestamp.sql`), a trigger-maintained column
  that moves only when a visitor-visible field changes. `updated_at` is bumped
  by `_recompute_stock_aggregate` on every sale and would claim a content change
  per purchase. Pages use `published_at`, not `updated_at`, because draft
  autosave advances `updated_at` while public HTML remains unchanged.
- **A NEW STORE IS NOT INDEXABLE UNTIL ITS OWNER PUBLISHES SOMETHING**
  (`lib/store/launch.ts`). At creation a store is pure theme seed — the same
  homepage, ~17 content pages and sample catalogue as every other store on that
  template — and `createStore` used to submit exactly that to Google + IndexNow
  the moment it existed. Mass-submitting near-duplicate placeholder stores spends
  the whole `*.storemink.com` domain's reputation, and `robots.txt` cannot undo
  it (Disallow stops crawling, not indexing). `stores.settings.launched` gates
  `robots.ts` + `sitemap.ts`; `notifyStoreContentPublished()` launches from all
  page/product/blog publication paths (including bulk products, bulk blogs,
  customer direct-publish and approval), not just the single-row editors, then
  performs IndexNow + Google coverage out of band. **Absence of the flag means
  LAUNCHED** —
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
- **Each merchant has a separate Organization entity** at its canonical
  `${origin}/#organization` (`(storefront)/components/structured-data.tsx`). It
  emits the configured brand name/legal name/logo/blurb, public email/phone and
  valid Instagram/YouTube URLs; the store WebSite, Product and BlogPosting nodes
  reference that same `@id`. Missing merchant data is omitted rather than
  replaced with StoreMink/WholeSip identity.

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
