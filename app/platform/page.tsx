import Link from "next/link";
import { PLATFORM_URL } from "@/lib/site";
import { PLAN_LIMITS, PLAN_META } from "@/lib/plans";
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

const FEATURES = [
  {
    icon: LayoutTemplate,
    title: "A storefront that feels yours",
    body: "Your brand, logo and colours at your-name.storemink.com — or your own domain. A homepage you compose section by section, no code.",
  },
  {
    icon: PenLine,
    title: "Blogs your customers write too",
    body: "A full blog engine with community submissions and an approval queue you control — or let posts go live instantly. Your store, your rules.",
  },
  {
    icon: Megaphone,
    title: "Marketing built in, not bolted on",
    body: "Coupons, customer groups, targeted offers and email campaigns — the tools other platforms sell as paid apps are simply here.",
  },
  {
    icon: Star,
    title: "Reviews & social proof",
    body: "Product reviews, ratings and rich product pages that build trust and rank on Google — structured data included.",
  },
  {
    icon: Users,
    title: "A real team dashboard",
    body: "Invite staff with roles and granular permissions. Enquiries, media library, analytics — one operations centre for the whole business.",
  },
  {
    icon: Building2,
    title: "D2C and B2B, one store",
    body: "Sell to shoppers and to businesses from the same place — enquiry-based selling, customer groups and wholesale workflows.",
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
];

// Derived from the canonical plan catalog (lib/plans.ts) — prices and AI
// generation counts render from PLAN_META/PLAN_LIMITS so this page can never
// drift from what the platform actually sells.
const PLANS = [
  {
    meta: PLAN_META.free,
    who: "Try everything. Launch your first store.",
    features: [
      "Storefront at you.storemink.com",
      `Up to ${PLAN_LIMITS.free.maxProducts} products`,
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
      "Everything in Free",
      "Your own custom domain",
      "Online payments — your own gateway",
      `${PLAN_LIMITS.basic.maxProducts} products & ${PLAN_LIMITS.basic.maxStaff} staff accounts`,
      `${PLAN_LIMITS.basic.aiGenerationsPerMonth} AI generations a month`,
    ],
    cta: `Choose ${PLAN_META.basic.name}`,
    popular: true,
  },
  {
    meta: PLAN_META.pro,
    who: "For growing brands ready to scale with a team.",
    features: [
      `Everything in ${PLAN_META.basic.name}`,
      "Unlimited products & staff",
      "Email campaigns",
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

export default function StoreminkLanding() {
  // One explicit Offer per plan, derived from the canonical catalog so the
  // structured data can never drift from what the page (and billing) actually
  // charge. Each carries a per-MONTH UnitPriceSpecification so Google reads the
  // exact recurring price (₹0 / ₹500 / ₹1,500) rather than scraping a figure
  // out of the prose — which is how a stale "₹399" leaked into an AI Overview.
  const planOffers = PLANS.map((plan) => ({
    "@type": "Offer",
    name: `StoreMink ${plan.meta.name}`,
    description: plan.meta.tagline,
    priceCurrency: "INR",
    price: plan.meta.monthlyInr,
    url: `${PLATFORM_URL}/#pricing`,
    availability: "https://schema.org/InStock",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      priceCurrency: "INR",
      price: plan.meta.monthlyInr,
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
      {
        "@type": "Organization",
        "@id": `${PLATFORM_URL}/#organization`,
        name: "StoreMink",
        // The one-word spelling people actually type. Declaring it as an
        // alternate name tells Google "storemink" IS the brand — a direct signal
        // against the "did you mean storelink?" spell-correction on a new brand.
        alternateName: ["Storemink", "store mink"],
        url: PLATFORM_URL,
        logo: `${PLATFORM_URL}/icon.svg`,
        description:
          "India-first no-code store builder — storefront, blogs, reviews, coupons and email campaigns included. D2C + B2B, no transaction fees.",
      },
      {
        "@type": "WebSite",
        "@id": `${PLATFORM_URL}/#website`,
        name: "StoreMink",
        alternateName: ["Storemink", "store mink"],
        url: PLATFORM_URL,
        publisher: { "@id": `${PLATFORM_URL}/#organization` },
      },
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
          highPrice: PLAN_META.pro.monthlyInr,
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
            Store<span>Mink</span>
          </Link>
          <div className="stq-nav-links">
            <a href="#features">Features</a>
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
              <span className="stq-grad">Keep 100% of every sales.</span>
            </h1>
            <p className="stq-sub stq-rise stq-rise-2">
              StoreMink is the India-first store builder with everything
              included — storefront, blogs, reviews, coupons, email campaigns
              and a full team dashboard. From{" "}
              {priceInr(PLAN_META.basic.monthlyInr)}/month. No apps to buy. No
              transaction fees. Ever.
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
            <div className="stq-mock" aria-hidden="true">
              <div className="stq-mock-bar">
                <span className="stq-mock-dot" />
                <span className="stq-mock-dot" />
                <span className="stq-mock-dot" />
                <span className="stq-mock-url">
                  🔒 <strong>yourbrand</strong>.storemink.com
                </span>
              </div>
              <div className="stq-mock-body">
                <div className="stq-mock-store-head">
                  <span className="stq-mock-logo">
                    <i /> yourbrand
                  </span>
                  <span className="stq-mock-navlinks">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
                <div className="stq-mock-hero">
                  <b>Made with care. Delivered with pride.</b>
                  <span>Fresh from our kitchen to your doorstep.</span>
                  <br />
                  <span className="stq-mock-pill">SHOP NOW</span>
                </div>
                <div className="stq-mock-grid">
                  <div className="stq-mock-card">
                    <div className="img" />
                    <div className="t" />
                    <div className="p">₹249</div>
                  </div>
                  <div className="stq-mock-card">
                    <div className="img" />
                    <div className="t" />
                    <div className="p">₹329</div>
                  </div>
                  <div className="stq-mock-card">
                    <div className="img" />
                    <div className="t" />
                    <div className="p">₹199</div>
                  </div>
                </div>
              </div>
            </div>
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
          <p>
            Start free, upgrade when you grow. Annual billing gets you two
            months free.
          </p>
        </div>
        <div className="stq-pricing">
          {PLANS.map((plan) => (
            <div
              className={`stq-price-card${plan.popular ? " popular" : ""}`}
              key={plan.meta.id}
            >
              {plan.popular && (
                <span className="stq-price-flag">Most popular</span>
              )}
              <h3>{plan.meta.name}</h3>
              <p className="who">{plan.who}</p>
              <div className="stq-price">
                {priceInr(plan.meta.monthlyInr)}
                <sub>/month</sub>
              </div>
              <ul>
                {plan.features.map((f) => (
                  <li key={f}>
                    <Check size={16} /> {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className={`stq-btn ${
                  plan.popular ? "stq-btn-primary" : "stq-btn-ghost"
                } stq-btn-block`}
              >
                {plan.cta}
              </Link>
            </div>
          ))}
        </div>
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
              Store<span>Mink</span>
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
