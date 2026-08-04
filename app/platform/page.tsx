import Link from "next/link";
import { PLATFORM_URL, THEMES_URL } from "@/lib/site";
import { LEGAL_DOCS } from "@/lib/legal/documents";
import {
  BRAND_SOCIAL_LINKS,
  SUPPORT_EMAIL,
  platformOrganizationSchema,
  platformWebsiteSchema,
} from "@/lib/seo/brand-identity";
import { PLAN_LIMITS, PLAN_META } from "@/lib/plans";
import { BrandMark } from "./brand-mark";
import { PricingCards, type PricingCard } from "./pricing-cards";
import { getPlanPricing } from "@/lib/plans/pricing";
import {
  BuilderArt,
  InvoiceArt,
  RegisterArt,
  StorefrontArt,
} from "./product-art";
import {
  ArrowRight,
  Building2,
  Check,
  CircleCheck,
  Globe,
  IndianRupee,
  LayoutTemplate,
  Mail,
  Megaphone,
  PenLine,
  Rocket,
  Star,
  Users,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// storemink.com landing page. Pure server component — no client JS (the FAQ
// uses native <details>), so it stays fast and fully crawlable.
// Positioning: everything included (no app tax), 0% transaction fees (BYO
// gateway), B2B + D2C together, live in a day, dogfooded on WholeSip.
// ---------------------------------------------------------------------------

// Short on purpose. Six cards each carrying a three-line paragraph is a wall of
// text pretending to be a grid — the heading is the point, the line under it is
// a caption, not an essay.
const FEATURES = [
  {
    icon: LayoutTemplate,
    title: "Your own storefront",
    body: "Your brand, your colours, your domain.",
  },
  {
    icon: PenLine,
    title: "Blogs and community posts",
    body: "Customers can write them. You approve them.",
  },
  {
    icon: Megaphone,
    title: "Marketing built in",
    body: "Coupons, segments and email campaigns.",
  },
  {
    icon: Star,
    title: "Reviews and ratings",
    body: "Social proof, with Google-ready markup.",
  },
  {
    icon: Users,
    title: "A team, with permissions",
    body: "Staff roles down to the individual action.",
  },
  {
    icon: Building2,
    title: "D2C and B2B together",
    body: "Retail and wholesale from one store.",
  },
];
const COMPARE: {
  label: string;
  mink: { ok: boolean; text: string };
  other: { ok: boolean; text: string };
}[] = [
  {
    label: "Monthly price",
    mink: { ok: true, text: "₹0–₹1,500, in rupees" },
    other: { ok: false, text: "₹1,994+ before apps, USD-linked" },
  },
  {
    label: "Transaction fees",
    mink: { ok: true, text: "₹0 — your own gateway" },
    other: { ok: false, text: "Extra fees on third-party gateways" },
  },
  {
    label: "Blog + community posts",
    mink: { ok: true, text: "Included" },
    other: { ok: false, text: "Paid app" },
  },
  {
    label: "Product reviews",
    mink: { ok: true, text: "Included" },
    other: { ok: false, text: "Paid app" },
  },
  {
    label: "Email campaigns",
    mink: { ok: true, text: "Included" },
    other: { ok: false, text: "Paid app" },
  },
  {
    label: "Customer segments & targeted coupons",
    mink: { ok: true, text: "Included" },
    other: { ok: false, text: "Paid app" },
  },
  {
    label: "Team roles & permissions",
    mink: { ok: true, text: "Included" },
    other: { ok: false, text: "Higher plans only" },
  },
  {
    label: "B2B / wholesale selling",
    mink: { ok: true, text: "Enquiry-based selling built in" },
    other: { ok: false, text: "Enterprise plans, lakhs per month" },
  },
  {
    label: "Point of Sale (in-store till)",
    // Pro includes PLAN_LIMITS.pro.posLocationsIncluded locations.
    mink: { ok: true, text: "Included on Pro — 2 locations" },
    other: { ok: false, text: "Paid add-on, charged per location" },
  },
  {
    label: "GST invoicing",
    mink: { ok: true, text: "Included on every plan, free included" },
    other: { ok: false, text: "Paid app" },
  },
];

// Derived from the canonical plan catalog (lib/plans.ts) — prices and AI
// generation counts render from PLAN_META/PLAN_LIMITS so this page can never
// drift from what the platform actually sells.
const PLANS = [
  {
    meta: PLAN_META.free,
    who: "Try everything. Launch your first store.",
    features: [
      "Storefront on your own subdomain",
      "Website builder — every section type",
      `Up to ${PLAN_LIMITS.free.maxProducts} products`,
      "Blogs, reviews and enquiries",
      "GST invoicing and tax classes",
      "Cash on delivery checkout",
      "Full admin dashboard",
      `${PLAN_LIMITS.free.aiGenerationsPerMonth} AI generations a month`,
    ],
    cta: "Start free",
    popular: false,
  },
  {
    meta: PLAN_META.basic,
    who: "For new brands getting their first orders.",
    features: [
      "Everything in Free, plus:",
      "Your own custom domain",
      "Online payments — your own gateway, 0% to us",
      `${PLAN_LIMITS.basic.maxProducts} products`,
      `${PLAN_LIMITS.basic.maxStaff} staff accounts with roles`,
      "Coupons and customer groups",
      "Media library",
      `${PLAN_LIMITS.basic.aiGenerationsPerMonth} AI generations a month`,
    ],
    cta: `Choose ${PLAN_META.basic.name}`,
    popular: true,
  },
  {
    meta: PLAN_META.pro,
    who: "For growing brands, a team, and a counter.",
    features: [
      `Everything in ${PLAN_META.basic.name}, plus:`,
      "Point of Sale — till, staff PINs, shifts",
      `${PLAN_LIMITS.pro.posLocationsIncluded} shop locations, ${PLAN_LIMITS.pro.posDevicesPerLocation} tills each`,
      "Stock per location, and transfers",
      "Buy online, collect in store",
      "Email campaigns",
      "Unlimited products and staff",
      `${PLAN_LIMITS.pro.aiGenerationsPerMonth} AI generations a month`,
    ],
    cta: `Choose ${PLAN_META.pro.name}`,
    popular: false,
  },
];
const priceInr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

const FAQS = [
  {
    q: "Do you take a cut of my sales?",
    a: "No. Zero. You connect your own payment gateway (like Razorpay or Cashfree), so money from every order settles directly into your bank account. StoreMink never sits between you and your revenue — you only ever pay the flat monthly plan.",
  },
  {
    q: "How is StoreMink different from Shopify or StoreHippo?",
    a: "Shopify's real cost isn't the plan — it's the apps. Blogs, reviews, email campaigns and customer segments are all paid add-ons, billed in dollars. On StoreMink they're built in. StoreHippo is enterprise-shaped: sales calls, setup fees, implementation timelines. On StoreMink you sign up and your store exists the same minute.",
  },
  {
    q: "Do I need to know how to code?",
    a: "Not at all. StoreMink is fully no-code: pick a name, brand your storefront, add products and go live from a single dashboard. If you ever want help, the help centre and support are right there.",
  },
  {
    q: "Can I use my own domain?",
    a: "Yes — on the Basic plan and above you can connect your own domain (like yourbrand.com) with guided DNS verification. Until then your store lives at your-name.storemink.com.",
  },
  {
    q: "Can I sell B2B and D2C from the same store?",
    a: "Yes — that's one of the main reasons StoreMink exists. Enquiry-based selling and wholesale customer groups sit on top of your regular storefront, so distributors and retail customers are served from one place.",
  },
  {
    q: "What happens when I outgrow my plan?",
    a: "Upgrade anytime from your dashboard — your store, data and customers carry over untouched. Annual billing gets you two months free.",
  },
];

export default async function StoreminkLanding() {
  // Operator-set prices, folded onto the code defaults. Cached + tag-busted on
  // save, so a change in the console shows here immediately.
  const pricing = await getPlanPricing();

  // One explicit Offer per plan, derived from the canonical catalog so the
  // structured data can never drift from what the page (and billing) actually
  // charge. Each carries a per-MONTH UnitPriceSpecification so Google reads the
  // exact recurring price (₹0 / ₹500 / ₹1,500) rather than scraping a figure
  // out of the prose — which is how a stale "₹399" leaked into an AI Overview.
  // "From ₹X/month" in the hero must track the operator's prices too, or the
  // headline contradicts the cards further down the same page.
  const cheapestPaidInr = Math.min(
    ...PLANS.map((p) => pricing[p.meta.id].monthlyInr).filter((n) => n > 0),
  );

  const pricingCards: PricingCard[] = PLANS.map((plan) => ({
    id: plan.meta.id,
    name: plan.meta.name,
    who: plan.who,
    features: plan.features,
    cta: plan.cta,
    popular: plan.popular,
    ...pricing[plan.meta.id],
  }));

  const planOffers = PLANS.map((plan) => ({
    "@type": "Offer",
    name: `StoreMink ${plan.meta.name}`,
    description: plan.meta.tagline,
    priceCurrency: "INR",
    price: pricing[plan.meta.id].monthlyInr,
    url: `${PLATFORM_URL}/#pricing`,
    availability: "https://schema.org/InStock",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      priceCurrency: "INR",
      price: pricing[plan.meta.id].monthlyInr,
      // Recurring monthly subscription (P1M = one-month billing period).
      billingDuration: 1,
      billingIncrement: 1,
      unitCode: "MON",
      referenceQuantity: {
        "@type": "QuantitativeValue",
        value: 1,
        unitCode: "MON",
      },
    },
  }));

  // Organization + SoftwareApplication JSON-LD so search engines understand
  // what StoreMink is and its price range (₹0 up to the Pro monthly price).
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      // Organization + WebSite come from lib/seo/brand-identity.ts because the
      // help centre emits the SAME nodes under the same @id. Two hand-written
      // copies would drift, and a contradictory entity is worse than none.
      platformOrganizationSchema(),
      platformWebsiteSchema(),
      {
        "@type": "SoftwareApplication",
        "@id": `${PLATFORM_URL}/#software`,
        name: "StoreMink",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: PLATFORM_URL,
        publisher: { "@id": `${PLATFORM_URL}/#organization` },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "INR",
          lowPrice: 0,
          highPrice: pricing.pro.monthlyInr,
          offerCount: PLANS.length,
          offers: planOffers,
        },
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="stq-navbar">
        <nav className="stq-nav">
          <Link href="/" className="stq-logo">
            <BrandMark size={26} priority />
            <em>
              Store<span>Mink</span>
            </em>
          </Link>
          <div className="stq-nav-links">
            <a href="#features">Features</a>
            <a href={THEMES_URL}>Themes</a>
            <Link href="/pos">Point of Sale</Link>
            <a href="#compare">Compare</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="stq-nav-actions">
            <Link href="/login" className="stq-btn stq-btn-ghost">
              Log in
            </Link>
            <Link href="/signup" className="stq-btn stq-btn-primary">
              Start free
            </Link>
          </div>
        </nav>
      </div>

      {/* ------------------------------ hero ------------------------------ */}
      <header className="stq-hero2">
        <div className="stq-hero2-bg" />
        <div className="stq-hero2-inner">
          <div>
            <span className="stq-kicker stq-rise">
              Built for India 🇮🇳 · D2C + B2B
            </span>
            <h1 className="stq-rise stq-rise-1">
              Launch your store in a day.{" "}
              <span className="stq-grad">Keep 100% of every sale.</span>
            </h1>
            <p className="stq-sub stq-rise stq-rise-2">
              StoreMink is the India-first store builder with everything
              included — storefront, blogs, reviews, coupons, email campaigns
              and a full team dashboard. From {priceInr(cheapestPaidInr)}/month.
              No apps to buy. No transaction fees. Ever.
            </p>
            <div className="stq-hero-cta stq-rise stq-rise-3">
              <Link href="/signup" className="stq-btn stq-btn-primary">
                Create your store free <ArrowRight size={17} />
              </Link>
              <a href="#pricing" className="stq-btn stq-btn-ghost">
                See pricing
              </a>
            </div>
            <ul className="stq-hero-ticks stq-rise stq-rise-4">
              <li>
                <CircleCheck size={17} /> Free plan forever
              </li>
              <li>
                <CircleCheck size={17} /> No credit card to start
              </li>
              <li>
                <CircleCheck size={17} /> Live the same day
              </li>
            </ul>
          </div>

          <div className="stq-mock-wrap stq-rise stq-rise-2">
            <StorefrontArt />
            <div className="stq-float stq-float-1" aria-hidden="true">
              <CircleCheck size={17} /> Order received — ₹648
            </div>
            <div className="stq-float stq-float-2" aria-hidden="true">
              <IndianRupee size={16} />
              <span>
                Platform fee on this sale: <b>₹0</b>
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* --------------------------- stats strip --------------------------- */}
      <div className="stq-strip">
        <div className="stq-strip-inner">
          <div className="stq-stat">
            <b>0%</b>
            <span>transaction fees, on every plan</span>
          </div>
          <div className="stq-stat">
            <b>Everything</b>
            <span>included — no paid apps</span>
          </div>
          <div className="stq-stat">
            <b>1 day</b>
            <span>from signup to selling</span>
          </div>
          <div className="stq-stat">
            <b>D2C + B2B</b>
            <span>from a single store</span>
          </div>
        </div>
      </div>

      {/* ---------------------------- features ---------------------------- */}
      <section className="stq-section-lg" id="features">
        <div className="stq-sec-head">
          <span className="stq-kicker">Everything included</span>
          <h2>
            The tools others sell as apps? They&apos;re just&hellip; here.
          </h2>
          <p>
            One monthly price. Every feature. Your store gets more powerful
            every time we ship — at no extra cost.
          </p>
        </div>
        <div className="stq-grid">
          {FEATURES.map((f) => (
            <div className="stq-feature" key={f.title}>
              <div className="stq-feature-icon">
                <f.icon size={20} />
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* --------------------------- comparison --------------------------- */}
      <section
        className="stq-section-lg"
        id="compare"
        style={{ paddingTop: 0 }}
      >
        <div className="stq-sec-head">
          <span className="stq-kicker">The app tax ends here</span>
          <h2>Do the maths before you pay it.</h2>
          <p>
            On legacy platforms the plan is just the entry fee — real
            functionality is sold back to you app by app, in dollars.
          </p>
        </div>
        <div className="stq-compare-wrap">
          <table className="stq-compare">
            <thead>
              <tr>
                <th></th>
                <th>StoreMink</th>
                <th>Legacy platforms*</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>
                    <span className="stq-cell-yes">
                      <Check size={16} /> {row.mink.text}
                    </span>
                  </td>
                  <td>
                    <span className="stq-cell-no">
                      <X size={16} /> {row.other.text}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="stq-compare-note">
          *Typical global store-builder setup with equivalent paid apps, billed
          in USD.
        </p>
      </section>

      {/* --------------------------- 0% fees split -------------------------- */}
      <section className="stq-section-lg" style={{ paddingTop: 0 }}>
        <div className="stq-split">
          <div>
            <span className="stq-kicker">Your money stays yours</span>
            <h2>We never touch your revenue.</h2>
            <p>
              Connect your own payment gateway — Razorpay, Cashfree, whichever
              you trust. Customers pay you, money settles straight into your
              bank account, and StoreMink takes exactly nothing from it.
            </p>
            <ul className="stq-checklist">
              <li>
                <CircleCheck size={19} />
                <span>
                  <b>0% commission,</b> on every order, on every plan
                </span>
              </li>
              <li>
                <CircleCheck size={19} />
                <span>
                  <b>Direct settlement</b> — no platform wallet, no payout
                  delays
                </span>
              </li>
              <li>
                <CircleCheck size={19} />
                <span>
                  <b>One flat monthly price</b> that never scales with your
                  success
                </span>
              </li>
            </ul>
          </div>
          <div className="stq-money" aria-hidden="true">
            <div className="stq-money-row">
              <span>Order value</span>
              <b>₹10,000</b>
            </div>
            <div className="stq-money-row">
              <span>Marketplace commission</span>
              <b style={{ textDecoration: "line-through", opacity: 0.45 }}>
                −₹2,500
              </b>
            </div>
            <div className="stq-money-row">
              <span>Platform transaction fee</span>
              <b style={{ textDecoration: "line-through", opacity: 0.45 }}>
                −₹200
              </b>
            </div>
            <div className="stq-money-row stq-money-total">
              <span>You keep</span>
              <b>₹10,000</b>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------- product showcase ----------------------- */}
      {/* A dark band, because the page was white end to end and had no rhythm
          for a visual to sit against. Each card's artwork is DRAWN IN CSS (see
          platform.css) rather than photographed — we have no brand photography,
          and stock imagery is the look of a product with nothing to show. What
          these depict is real: the register, the builder, GST invoicing. */}
      <section className="stq-showcase" id="showcase">
        <div className="stq-showcase-inner">
          <div className="stq-sec-head">
            <span className="stq-kicker">Not a roadmap</span>
            <h2>The parts other people charge extra for.</h2>
            <p>All in the same plan. All working today.</p>
          </div>

          <div className="stq-show-grid">
            {/* --- register --- */}
            <article className="stq-show-card">
              <RegisterArt compact />
              <h3>Sell at the counter</h3>
              <p>Your counter, sharing one catalogue with your website.</p>
              <ul className="stq-show-list">
                <li>
                  <Check size={15} /> Barcode scanner, or your phone&apos;s
                  camera
                </li>
                <li>
                  <Check size={15} /> Shifts, cash drops and an end-of-day count
                </li>
                <li>
                  <Check size={15} /> Stock per shop, and transfers between them
                </li>
                <li>
                  <Check size={15} /> Buy online, collect in store
                </li>
              </ul>
              <span className="stq-show-tag">Pro · 2 locations included</span>
              <p className="stq-show-more">
                <Link href="/pos">
                  Everything in Point of Sale <ArrowRight size={15} />
                </Link>
              </p>
            </article>

            {/* --- builder --- */}
            <article className="stq-show-card">
              <BuilderArt />
              <h3>Build the site yourself</h3>
              <p>Every page, section by section. No code, ever.</p>
              <ul className="stq-show-list">
                <li>
                  <Check size={15} /> Twelve section types, drag to reorder
                </li>
                <li>
                  <Check size={15} /> Live preview as you type
                </li>
                <li>
                  <Check size={15} /> Draft and publish, with undo
                </li>
                <li>
                  <Check size={15} /> Your own domain from Basic up
                </li>
              </ul>
              <span className="stq-show-tag">Every plan</span>
            </article>

            {/* --- GST --- */}
            <article className="stq-show-card">
              <InvoiceArt />
              <h3>GST that works itself out</h3>
              <p>Set a rate once. Every invoice after that is correct.</p>
              <ul className="stq-show-list">
                <li>
                  <Check size={15} /> Tax classes per product, 5% / 12% / 18%
                </li>
                <li>
                  <Check size={15} /> Prices inclusive or exclusive — your call
                </li>
                <li>
                  <Check size={15} /> Printable invoices customers can download
                </li>
                <li>
                  <Check size={15} /> Place of supply decides the split
                </li>
              </ul>
              <span className="stq-show-tag">Every plan, Free included</span>
            </article>
          </div>

          <div className="stq-showcase-foot">
            <p>No add-ons. No upgrade tier. No app store.</p>
            <Link href="/signup" className="stq-btn stq-btn-light">
              Create your store free <ArrowRight size={17} />
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------ steps ------------------------------ */}
      <section className="stq-section-lg" style={{ paddingTop: 0 }}>
        <div className="stq-sec-head">
          <span className="stq-kicker">
            <Rocket size={13} style={{ verticalAlign: "-2px" }} /> Live in a day
          </span>
          <h2>Three steps. No agency. No developer.</h2>
        </div>
        <div className="stq-steps">
          <div className="stq-step">
            <span className="stq-step-num">1</span>
            <h3>Claim your store</h3>
            <p>
              Pick a name and sign up — your storefront and dashboard exist the
              same minute at your-name.storemink.com.
            </p>
          </div>
          <div className="stq-step">
            <span className="stq-step-num">2</span>
            <h3>Make it yours</h3>
            <p>
              Add your logo, colours and products. Compose your homepage from
              ready-made sections — all from the dashboard.
            </p>
          </div>
          <div className="stq-step">
            <span className="stq-step-num">3</span>
            <h3>Start selling</h3>
            <p>
              Share your link, take enquiries and orders, and grow with built-in
              blogs, coupons and email campaigns.
            </p>
          </div>
        </div>
      </section>

      {/* --------------------------- founder proof -------------------------- */}
      {/* <section className="stq-section-lg" style={{ paddingTop: 0 }}>
        <div className="stq-founder">
          <span className="stq-kicker">
            <ShieldCheck size={13} style={{ verticalAlign: "-2px" }} /> We use
            it ourselves
          </span>
          <blockquote>
            “We didn&apos;t build StoreMink to sell software. We built it to run
            WholeSip — our own D2C brand. Every store here runs on the exact
            platform we depend on ourselves, every single day.”
          </blockquote>
          <cite> */}
      {/* <b>Vansh Gupta</b> — Founder, StoreMink &amp; WholeSip */}
      {/* </cite>
          <br />
          <a
            href="https://wholesip.com"
            target="_blank"
            rel="noopener noreferrer"
            className="stq-founder-link"
          >
            See WholeSip live on StoreMink <ArrowRight size={15} />
          </a>
        </div>
      </section> */}

      {/* ----------------------------- pricing ----------------------------- */}
      <section
        className="stq-section-lg"
        id="pricing"
        style={{ paddingTop: 0 }}
      >
        <div className="stq-sec-head">
          <span className="stq-kicker">Simple, honest pricing</span>
          <h2>Priced in rupees. Not in surprises.</h2>
          <p>Start free. Upgrade when you grow.</p>
        </div>
        <PricingCards plans={pricingCards} />
        <p className="stq-price-note">
          Every plan: <b>0% transaction fees</b> — connect your own Razorpay or
          Cashfree and keep everything you earn.
        </p>
      </section>

      {/* ------------------------------- FAQ ------------------------------- */}
      <section className="stq-section-lg" id="faq" style={{ paddingTop: 0 }}>
        <div className="stq-sec-head">
          <span className="stq-kicker">Questions, answered</span>
          <h2>Frequently asked questions</h2>
        </div>
        <div className="stq-faq">
          {FAQS.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ----------------------------- CTA band ----------------------------- */}
      <section className="stq-cta-band">
        <div className="stq-cta-band-inner">
          <h2>Your brand deserves its own home.</h2>
          <p>
            Not a marketplace listing. Not a monthly app bill. A store that is
            completely, permanently yours — live today.
          </p>
          <div className="stq-hero-cta">
            <Link href="/signup" className="stq-btn stq-btn-light">
              Create your store free <ArrowRight size={17} />
            </Link>
            <Link href="/login" className="stq-btn stq-btn-outline">
              Log in to your store
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------ footer ------------------------------ */}
      <footer className="stq-footer2">
        <div className="stq-footer2-inner">
          <div className="stq-footer2-brand">
            <Link href="/" className="stq-logo">
              <BrandMark size={26} />
              <em>
                Store<span>Mink</span>
              </em>
            </Link>
            <p>
              The India-first store builder with everything included. Launch
              your D2C or B2B store in a day and keep 100% of every sale.
            </p>
          </div>
          <div>
            <h4>Product</h4>
            <nav>
              <a href="#features">Features</a>
              <a href={THEMES_URL}>Themes</a>
              <a href="#compare">Compare</a>
              <a href="#pricing">Pricing</a>
            </nav>
          </div>
          <div>
            <h4>Get started</h4>
            <nav>
              <Link href="/signup">Create your store</Link>
              <Link href="/login">Log in</Link>
            </nav>
          </div>
          <div>
            <h4>Support</h4>
            <nav>
              <a href="https://help.storemink.com">Help Centre</a>
              <a href="#faq">FAQ</a>
              <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </nav>
          </div>
          <div>
            <h4>Follow</h4>
            {/* The visible half of the `sameAs` claim in the JSON-LD above —
                same list, one source (lib/seo/brand-identity.ts), so a profile
                can never be asserted in schema but missing from the page.
                rel="me" is the standard "this account is us" annotation. */}
            <nav>
              {BRAND_SOCIAL_LINKS.map((s) => (
                <a key={s.href} href={s.href} rel="me noopener" target="_blank">
                  {s.label}
                </a>
              ))}
            </nav>
          </div>
          <div>
            <h4>Legal</h4>
            {/* Previously reachable only from inside the signup form, so both
                the sitemap entry and the crawler had no path to them. */}
            <nav>
              {LEGAL_DOCS.map((d) => (
                <Link key={d.slug} href={`/legal/${d.slug}`}>
                  {d.title}
                </Link>
              ))}
            </nav>
          </div>
        </div>
        <div className="stq-footer2-base">
          <span>
            © {new Date().getFullYear()} StoreMink. Made in India{" "}
            <Globe size={13} style={{ verticalAlign: "-2px" }} />
          </span>
          <span>
            <Mail size={13} style={{ verticalAlign: "-2px" }} /> Questions?
            Visit the <a href="https://help.storemink.com">Help Centre</a>
          </span>
        </div>
      </footer>
    </>
  );
}
