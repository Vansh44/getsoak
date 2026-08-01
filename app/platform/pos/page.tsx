import type { Metadata } from "next";
import Link from "next/link";
import { PLATFORM_URL } from "@/lib/site";
import { PLAN_LIMITS, PLAN_META } from "@/lib/plans";
import { BrandMark } from "../brand-mark";
import { RegisterArt } from "../product-art";
import { getPlanPricing, inr } from "@/lib/plans/pricing";
import {
  ArrowRight,
  Banknote,
  CircleCheck,
  Clock,
  Building2,
  MapPin,
  Package,
  Receipt,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Store,
  Users,
} from "lucide-react";

// ---------------------------------------------------------------------------
// storemink.com/pos — the Point of Sale product page.
//
// Served on the PLATFORM host, where proxy.ts rewrites every path into
// /platform/*. There is no clash with {slug}.storemink.com/pos (the actual
// register): different hosts, different route trees.
//
// EVERY claim below is checked against what ships (CODEBASE §22/§23). The one
// thing deliberately NOT claimed anywhere is offline selling: the catalogue is
// cached on the device so search and scan need no round trip, but completing a
// sale still needs the server, and the offline outbox is unbuilt. A promise
// like that gets found out at a counter with a customer waiting.
// ---------------------------------------------------------------------------

export const metadata: Metadata = {
  title:
    "Point of Sale — one till, one catalogue, one set of books | StoreMink",
  description:
    "Turn a tablet into a till. Barcode scanning, staff PINs, shifts and cash-up, stock across shops, GST receipts and buy-online-collect-in-store — included on StoreMink Pro, with two locations.",
  alternates: { canonical: `${PLATFORM_URL}/pos` },
  openGraph: {
    title: "StoreMink Point of Sale",
    description:
      "A till for your counter that shares its catalogue, stock and customers with your website.",
    url: `${PLATFORM_URL}/pos`,
  },
};

// One line each. A grid of eight three-line paragraphs is a wall of text, and
// the icon plus the heading already carry the idea.
const CAPABILITIES = [
  {
    icon: ScanLine,
    title: "Scan and sell",
    body: "A barcode gun, or your phone's camera.",
  },
  {
    icon: Users,
    title: "Staff sign in with a PIN",
    body: "They set it themselves. You never see it.",
  },
  {
    icon: ShieldCheck,
    title: "Only tills you authorised",
    body: "Not a cashier's own phone. Revoke anytime.",
  },
  {
    icon: Banknote,
    title: "Shifts and cash-up",
    body: "Float, drops, count, variance.",
  },
  {
    icon: Package,
    title: "Stock knows which shop",
    body: "Receive, count and transfer between them.",
  },
  {
    icon: Receipt,
    title: "GST receipts",
    body: "80mm roll, CGST/SGST split, HSN codes.",
  },
  {
    icon: MapPin,
    title: "Collect in store",
    body: "Held on the shelf until they arrive.",
  },
  {
    icon: Smartphone,
    title: "Runs on what you own",
    body: "Any browser. No terminal to buy.",
  },
];
const FLOW = [
  {
    n: "1",
    title: "Switch it on",
    body: "Turn it on in your dashboard. Your first shop is already there.",
  },
  {
    n: "2",
    title: "Authorise the till",
    body: "Tap authorise on the tablet, or pair it with a code.",
  },
  {
    n: "3",
    title: "Add your staff",
    body: "Invite by email. They finish setup themselves.",
  },
  {
    n: "4",
    title: "Start ringing",
    body: "Scan, take payment, print. Same orders list as online.",
  },
];

const FAQS = [
  {
    q: "Does it work without internet?",
    a: "Not yet, and we would rather say so than have you find out at the counter. Your catalogue is cached on the device, so searching and scanning stay instant with no round trip — but completing a sale needs the connection. Offline queueing is on the roadmap.",
  },
  {
    q: "What hardware do I need?",
    a: "Anything with a modern browser — a tablet is the usual choice. A USB or Bluetooth barcode scanner works with no setup because it behaves as a keyboard, and any 80mm thermal printer your browser can print to will produce the receipt. There is nothing to buy from us.",
  },
  {
    q: "Do I have to use StoreMink for payments?",
    a: "No. Cash, card, UPI and split payments are recorded at the till whichever way the money actually moved. If you take online payments on your website you connect your own gateway there too — we never sit between you and your money.",
  },
  {
    q: "Can a cashier give discounts?",
    a: "Only if you let them. By default discounts and price overrides belong to the store owner alone — they are the one thing at a till that hands money away leaving nothing missing from the shelf to count later. You can hand discounting to staff with a percentage cap and a manager's PIN above it.",
  },
  {
    q: "How many shops and tills does Pro include?",
    a: `Two locations, and up to ${PLAN_LIMITS.pro.posDevicesPerLocation} authorised tills at each. Additional locations are coming as a metered add-on; until then Pro's two are the limit.`,
  },
  {
    q: "Is my online stock separate from the shop's?",
    a: "It is the same stock, counted per location. Your website promises only what sits at shops that fulfil online orders, so selling the last unit at the counter takes it off the website too — no overselling because two systems disagreed.",
  },
];

export default async function PosMarketingPage() {
  const pricing = await getPlanPricing();

  return (
    <div className="stq">
      {/* ------------------------------- nav ------------------------------- */}
      <div className="stq-navbar">
        <nav className="stq-nav">
          <Link href="/" className="stq-logo">
            <BrandMark size={26} priority />
            <em>
              Store<span>Mink</span>
            </em>
          </Link>
          <div className="stq-nav-links">
            <Link href="/#features">Features</Link>
            <Link href="/pos">Point of Sale</Link>
            <Link href="/#pricing">Pricing</Link>
            <Link href="/#faq">FAQ</Link>
          </div>
          <div className="stq-nav-actions">
            <Link href="/login" className="stq-btn stq-btn-outline">
              Log in
            </Link>
            <Link href="/signup" className="stq-btn stq-btn-primary">
              Start free
            </Link>
          </div>
        </nav>
      </div>

      {/* ------------------------------ hero ------------------------------- */}
      <header className="stq-hero2">
        <div className="stq-hero2-bg" />
        <div className="stq-hero2-inner">
          <div>
            <span className="stq-kicker stq-rise">
              <Store size={13} style={{ verticalAlign: "-2px" }} /> Point of
              Sale · included on {PLAN_META.pro.name}
            </span>
            <h1 className="stq-rise stq-rise-1">
              One till. <span className="stq-grad">One set of books.</span>
            </h1>
            <p className="stq-sub stq-rise stq-rise-2">
              Sell at the counter from the same catalogue, the same stock and
              the same customer list as your website — so the day&apos;s takings
              are one number, not two you reconcile on Sunday night.
            </p>
            <div className="stq-hero-cta stq-rise stq-rise-3">
              <Link href="/signup" className="stq-btn stq-btn-primary">
                Start free <ArrowRight size={17} />
              </Link>
              <Link href="/#pricing" className="stq-btn stq-btn-ghost">
                See pricing
              </Link>
            </div>
            <ul className="stq-hero-ticks stq-rise stq-rise-4">
              <li>
                <CircleCheck size={17} /> Two shops included
              </li>
              <li>
                <CircleCheck size={17} /> No terminal to buy
              </li>
              <li>
                <CircleCheck size={17} /> 0% on every sale
              </li>
            </ul>
          </div>

          {/* The register, drawn — same technique as the landing page. */}
          <div className="stq-mock-wrap stq-rise stq-rise-2">
            <RegisterArt />
            <div className="stq-float stq-float-1" aria-hidden="true">
              <CircleCheck size={17} /> Sale complete — ₹163.80
            </div>
            <div className="stq-float stq-float-2" aria-hidden="true">
              <Clock size={16} />
              <span>
                Shift open · drawer <b>₹8,420</b>
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ---------------------------- capabilities ------------------------- */}
      <section className="stq-section-lg" id="features">
        <div className="stq-sec-head">
          <span className="stq-kicker">What it does</span>
          <h2>A real register, not a payment link.</h2>
          <p>
            Everything a counter needs, on the busy days and the awkward ones.
          </p>
        </div>
        <div className="stq-grid">
          {CAPABILITIES.map((c) => (
            <div className="stq-feature" key={c.title}>
              <div className="stq-feature-icon">
                <c.icon size={20} />
              </div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------- owner-only discounts -------------------- */}
      <section className="stq-section-lg" style={{ paddingTop: 0 }}>
        <div className="stq-split">
          <div>
            <span className="stq-kicker">
              <ShieldCheck size={13} style={{ verticalAlign: "-2px" }} /> The
              part nobody else talks about
            </span>
            <h2>Giving money away stays yours to do.</h2>
            <p>
              A discount is the one thing at a till that hands money to a
              customer and leaves nothing missing from the shelf to count
              afterwards. So by default it belongs to you — not to a manager,
              and not to anyone you have given a dashboard login.
            </p>
            <ul className="stq-checklist">
              <li>
                <CircleCheck size={19} />
                <span>
                  <b>Order discounts, line markdowns and price overrides</b> are
                  the same act with different arithmetic, so the same rule
                  covers all three
                </span>
              </li>
              <li>
                <CircleCheck size={19} />
                <span>
                  <b>Hand it to staff when you want to</b> — with a percentage
                  cap, and a manager&apos;s PIN required above it
                </span>
              </li>
              <li>
                <CircleCheck size={19} />
                <span>
                  <b>Every markdown is recorded against the cashier</b> who rang
                  it, which is the whole point of having a cap
                </span>
              </li>
            </ul>
          </div>
          <div className="stq-money" aria-hidden="true">
            <div className="stq-money-row">
              <span>2 × Cold Brew</span>
              <b>₹200</b>
            </div>
            <div className="stq-money-row">
              <span>Less — damaged tin</span>
              <b style={{ color: "var(--stq-bad)" }}>−₹30</b>
            </div>
            <div className="stq-money-row">
              <span>CGST 2.5% + SGST 2.5%</span>
              <b>₹8.50</b>
            </div>
            <div className="stq-money-row stq-money-total">
              <span>Total</span>
              <b>₹178.50</b>
            </div>
            <div className="stq-money-row">
              <span>Approved by</span>
              <b>Owner</b>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------ the flow --------------------------- */}
      <section className="stq-showcase">
        <div className="stq-showcase-inner">
          <div className="stq-sec-head">
            <span className="stq-kicker">Live this afternoon</span>
            <h2>Four steps from switched off to selling.</h2>
            <p>
              No installation, no engineer, no terminal in the post. If your
              store already exists, the till is minutes away.
            </p>
          </div>
          <div className="stq-show-grid stq-flow-grid">
            {FLOW.map((f) => (
              <article className="stq-show-card" key={f.n}>
                <span className="stq-flow-num">{f.n}</span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
          <div className="stq-showcase-foot">
            <p>
              Part of {PLAN_META.pro.name}, at{" "}
              {inr(Math.round(pricing.pro.yearlyInr / 12))}/month billed yearly.
              Two shops, unlimited products and staff. Not an add-on, not per
              terminal.
            </p>
            <Link href="/signup" className="stq-btn stq-btn-light">
              Start free <ArrowRight size={17} />
            </Link>
          </div>
        </div>
      </section>

      {/* -------------------------------- FAQ ------------------------------ */}
      <section className="stq-section-lg" id="faq">
        <div className="stq-sec-head">
          <span className="stq-kicker">Straight answers</span>
          <h2>Before you ask.</h2>
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

      {/* ------------------------------- CTA ------------------------------- */}
      <section className="stq-cta-band">
        <div className="stq-cta-band-inner">
          <h2>Your counter and your website, finally the same shop.</h2>
          <p>
            Start free, add Point of Sale when you are ready. Nothing to install
            and nothing to buy.
          </p>
          <div className="stq-hero-cta" style={{ justifyContent: "center" }}>
            <Link href="/signup" className="stq-btn stq-btn-light">
              Create your store free <ArrowRight size={17} />
            </Link>
            <Link href="/" className="stq-btn stq-btn-ghost">
              Back to StoreMink
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------ footer ----------------------------- */}
      <footer className="stq-footer">
        <div className="stq-footer-simple">
          <Link href="/" className="stq-logo">
            <BrandMark size={26} />
            <em>
              Store<span>Mink</span>
            </em>
          </Link>
          <p>
            <Building2 size={14} style={{ verticalAlign: "-2px" }} /> The
            India-first store builder with everything included.
          </p>
          <p className="stq-footer-links">
            <Link href="/">Home</Link>
            <Link href="/#pricing">Pricing</Link>
            <Link href="/#faq">FAQ</Link>
            <Link href="/signup">Create your store</Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
