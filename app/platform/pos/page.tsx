import type { Metadata } from "next";
import { STOREMINK_LOGO } from "@/lib/brand-assets";
import Image from "next/image";
import Link from "next/link";
import posDevicesImage from "@/public/brand/storemink-pos-multidevice.png";
import { brandOgImageUrl } from "@/lib/seo/og-card";
import { PLATFORM_URL, POS_URL } from "@/lib/site";
import { PLAN_LIMITS, PLAN_META } from "@/lib/plans";
import { getPlanPricing, inr } from "@/lib/plans/pricing";
import { BrandMark } from "../brand-mark";
import { buildPosStructuredData } from "./structured-data";
import {
  ArrowRight,
  Banknote,
  Barcode,
  Building2,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  Globe2,
  MapPin,
  PackageCheck,
  ReceiptText,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Store,
  Truck,
  Users,
} from "lucide-react";

// pos.storemink.com is the public product site. The operational register lives
// at {merchant}.storemink.com/pos and is deliberately routed elsewhere.
// Claims on this page describe shipped behaviour only. In particular, StoreMink
// does not yet promise offline checkout: the catalogue is cached, but completing
// a sale still needs a connection.

const POS_OG_IMAGE = new URL(
  brandOgImageUrl({
    title: "StoreMink Point of Sale",
    subtitle: "Sell in store. Stay connected everywhere.",
    color: "#120f2d",
    logo: STOREMINK_LOGO,
    footer: "pos.storemink.com",
  }),
  PLATFORM_URL,
).toString();

export const metadata: Metadata = {
  title: "Point of Sale for connected retail | StoreMink",
  description:
    "Run fast in-store checkout, pickups, returns, multi-location stock, GST receipts and cash-up from the same StoreMink system as your website.",
  alternates: { canonical: POS_URL },
  keywords: [
    "StoreMink POS",
    "point of sale software India",
    "retail POS software",
    "multi location inventory",
    "GST billing software",
    "online and in-store inventory",
  ],
  openGraph: {
    title: "StoreMink Point of Sale",
    description:
      "One connected system for your website, checkout counter, stock and customers.",
    url: POS_URL,
    siteName: "StoreMink",
    type: "website",
    images: [
      {
        url: POS_OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "StoreMink Point of Sale",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "StoreMink Point of Sale",
    description:
      "One connected system for your website, checkout counter, stock and customers.",
    images: [POS_OG_IMAGE],
  },
};

const RETAIL_JOURNEYS = [
  {
    icon: ScanLine,
    eyebrow: "At the counter",
    title: "Move the queue, not the customer",
    body: "Scan, search or tap a product, hold a sale, add a customer and finish checkout without leaving the register.",
    href: "#checkout",
  },
  {
    icon: PackageCheck,
    eyebrow: "Across every location",
    title: "Know exactly where the stock is",
    body: "Count, receive and transfer inventory by shop while your website sells from the same live availability.",
    href: "#inventory",
  },
  {
    icon: ShoppingBag,
    eyebrow: "After the order",
    title: "Make pickup and returns feel native",
    body: "Prepare online orders at the right shop, complete collection at the counter and keep returns in the same order history.",
    href: "#fulfilment",
  },
];

const OPERATIONS = [
  {
    icon: ReceiptText,
    title: "GST-ready receipts",
    body: "Print 80mm receipts with HSN codes and a clear CGST/SGST split.",
  },
  {
    icon: Banknote,
    title: "Shifts that close cleanly",
    body: "Record float, cash drops, closing count and variance for each till.",
  },
  {
    icon: ShieldCheck,
    title: "Discounts with guardrails",
    body: "Set staff caps, require a manager PIN above them and retain the cashier trail.",
  },
  {
    icon: Smartphone,
    title: "Your hardware, your choice",
    body: "Use a modern browser on desktop, tablet or phone—there is no StoreMink terminal to buy.",
  },
  {
    icon: Users,
    title: "One customer history",
    body: "Recognise the same customer and order history whether they bought online or in store.",
  },
  {
    icon: Building2,
    title: "Authorised tills only",
    body: "Approve the devices that can sell for each location and revoke them whenever needed.",
  },
];

const FLOW = [
  {
    n: "01",
    title: "Turn on POS",
    body: "Enable it from your dashboard. Your existing catalogue and first location are already waiting.",
  },
  {
    n: "02",
    title: "Authorise a device",
    body: "Open the register on a browser and approve the till directly or pair it with a short code.",
  },
  {
    n: "03",
    title: "Bring in the team",
    body: "Invite staff by email. Each person completes setup and creates their own private PIN.",
  },
  {
    n: "04",
    title: "Open the shift",
    body: "Enter the float and start selling. In-store and online orders now share one operating system.",
  },
];

const FAQS = [
  {
    q: "Does StoreMink POS work without internet?",
    a: "Not yet, and we would rather say so than have you find out at the counter. Your catalogue is cached on the device, so searching and scanning stay fast, but completing a sale needs the connection. Offline queueing is on the roadmap.",
  },
  {
    q: "What hardware do I need?",
    a: "Anything with a modern browser—a desktop, tablet or phone. A USB or Bluetooth barcode scanner works because it behaves like a keyboard, and any 80mm thermal printer your browser can print to can produce the receipt. There is no StoreMink terminal to buy.",
  },
  {
    q: "Do I have to use StoreMink for payments?",
    a: "No. Cash, card, UPI and split payments can be recorded at the till whichever way the money moved. If you take online payments on your website, you connect your own gateway there too. StoreMink does not sit between you and your money.",
  },
  {
    q: "Can a cashier give discounts?",
    a: "Only if you allow it. Discounts and price overrides belong to the store owner by default. You can give staff a percentage cap and require a manager PIN above it, with every markdown retained against the cashier who rang it.",
  },
  {
    q: "How many locations and tills does Pro include?",
    a: `Two locations, with up to ${PLAN_LIMITS.pro.posDevicesPerLocation} authorised tills at each. Additional locations are coming as a metered add-on; until then the two included with Pro are the limit.`,
  },
  {
    q: "Is online stock separate from shop stock?",
    a: "No. Stock is counted per location, and your website promises only what sits at locations that fulfil online orders. If one of those locations sells the last unit at the counter, the website stops offering it too.",
  },
];

function ProductMark({ priority = false }: { priority?: boolean }) {
  return (
    <Link
      href={PLATFORM_URL}
      className="posx-brand"
      aria-label="StoreMink home"
    >
      <BrandMark size={29} priority={priority} />
      <span>StoreMink</span>
      <i>POS</i>
    </Link>
  );
}

function CheckoutPreview() {
  const products = [
    ["Everyday Tote", "₹2,490"],
    ["Classic Loafer", "₹3,290"],
    ["City Sneaker", "₹4,190"],
    ["Leather Belt", "₹1,890"],
  ];

  return (
    <div className="posx-ui posx-register-ui" aria-hidden="true">
      <div className="posx-ui-topbar">
        <span className="posx-ui-title">
          <Store size={14} /> Register
        </span>
        <span className="posx-ui-location">
          <MapPin size={12} /> Connaught Place
        </span>
      </div>
      <div className="posx-register-body">
        <div className="posx-products-pane">
          <div className="posx-search-row">
            <Barcode size={15} /> Search or scan a product
          </div>
          <div className="posx-product-grid">
            {products.map(([name, price], index) => (
              <div className="posx-product-card" key={name}>
                <span
                  className={`posx-product-shape posx-product-shape-${index + 1}`}
                />
                <b>{name}</b>
                <small>{price}</small>
              </div>
            ))}
          </div>
        </div>
        <div className="posx-cart-pane">
          <div className="posx-cart-head">
            <b>Current sale</b>
            <span>3 items</span>
          </div>
          <div className="posx-cart-line">
            <span>Everyday Tote × 1</span>
            <b>₹2,490</b>
          </div>
          <div className="posx-cart-line">
            <span>Classic Loafer × 1</span>
            <b>₹3,290</b>
          </div>
          <div className="posx-cart-line">
            <span>Leather Belt × 1</span>
            <b>₹1,890</b>
          </div>
          <div className="posx-cart-total">
            <span>Total</span>
            <b>₹7,670</b>
          </div>
          <div className="posx-charge">Charge ₹7,670</div>
          <div className="posx-hold">Hold sale</div>
        </div>
      </div>
    </div>
  );
}

function InventoryPreview() {
  return (
    <div className="posx-inventory-ui" aria-hidden="true">
      <div className="posx-stock-head">
        <span>
          <PackageCheck size={18} /> Inventory by location
        </span>
        <small>Updated just now</small>
      </div>
      <div className="posx-stock-product">
        <span className="posx-stock-thumb" />
        <span>
          <b>Classic Loafer · Tan</b>
          <small>SKU LOA-TAN-08</small>
        </span>
        <strong>11 available</strong>
      </div>
      <div className="posx-stock-nodes">
        <div className="posx-stock-node posx-stock-node-online">
          <Globe2 size={18} />
          <span>
            <small>Website</small>
            <b>In stock</b>
          </span>
          <i />
        </div>
        <div className="posx-stock-connector">
          <span />
          <em>one live quantity</em>
          <span />
        </div>
        <div className="posx-stock-locations">
          <div className="posx-stock-node">
            <Store size={18} />
            <span>
              <small>Connaught Place</small>
              <b>8 available</b>
            </span>
            <i />
          </div>
          <div className="posx-stock-node">
            <Store size={18} />
            <span>
              <small>Bandra West</small>
              <b>3 available</b>
            </span>
            <i />
          </div>
        </div>
      </div>
      <div className="posx-transfer-row">
        <Truck size={16} /> Transfer 4 units to Bandra West
        <ChevronRight size={16} />
      </div>
    </div>
  );
}

function FulfilmentPreview() {
  const orders = [
    ["#SM-1048", "Ready for pickup", "Anika Sharma", "2 items"],
    ["#SM-1045", "Picked up", "Rahul Mehta", "1 item"],
    ["#SM-1041", "Return started", "Meera Iyer", "3 items"],
  ];

  return (
    <div className="posx-fulfilment-ui" aria-hidden="true">
      <div className="posx-fulfilment-head">
        <span>
          <ShoppingBag size={17} /> Store pickup
        </span>
        <small>Connaught Place</small>
      </div>
      <div className="posx-order-list">
        {orders.map(([number, status, customer, items], index) => (
          <div className="posx-order-row" key={number}>
            <span className="posx-order-icon">
              {index === 2 ? (
                <RotateCcw size={17} />
              ) : (
                <PackageCheck size={17} />
              )}
            </span>
            <span className="posx-order-name">
              <b>{number}</b>
              <small>
                {customer} · {items}
              </small>
            </span>
            <strong className={`posx-order-status posx-order-status-${index}`}>
              {status}
            </strong>
          </div>
        ))}
      </div>
      <div className="posx-order-note">
        <CircleCheck size={17} /> Customer notified that order #SM-1048 is ready
      </div>
    </div>
  );
}

export default async function PosMarketingPage() {
  const pricing = await getPlanPricing();
  const proMonthlyEquivalentInr = Math.round(pricing.pro.yearlyInr / 12);
  const jsonLd = buildPosStructuredData({ proMonthlyEquivalentInr });

  return (
    <div className="stq posx">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />

      <div className="posx-nav-shell">
        <nav className="posx-nav" aria-label="Point of Sale">
          <ProductMark priority />
          <div className="posx-nav-links">
            <a href="#checkout">Checkout</a>
            <a href="#inventory">Inventory</a>
            <a href="#fulfilment">Pickup & returns</a>
            <a href="#operations">Operations</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div className="posx-nav-actions">
            <Link href={`${PLATFORM_URL}/login`} className="posx-login">
              Log in
            </Link>
            <Link
              href={`${PLATFORM_URL}/signup`}
              className="posx-button posx-button-dark"
            >
              Start free <ArrowRight size={16} />
            </Link>
          </div>
        </nav>
      </div>

      <main>
        <header className="posx-hero">
          <div className="posx-hero-glow" aria-hidden="true" />
          <div className="posx-container posx-hero-copy">
            <span className="posx-eyebrow posx-rise">
              <span>New</span> Point of Sale is included with{" "}
              {PLAN_META.pro.name}
            </span>
            <h1 className="posx-rise posx-rise-1">
              Sell in store. <em>Stay connected everywhere.</em>
            </h1>
            <p className="posx-rise posx-rise-2">
              StoreMink POS turns the devices you already own into a fast retail
              register—and keeps every checkout, pickup, return and stock
              movement in the same system as your website.
            </p>
            <div className="posx-hero-actions posx-rise posx-rise-3">
              <Link
                href={`${PLATFORM_URL}/signup`}
                className="posx-button posx-button-primary"
              >
                Start selling free <ArrowRight size={18} />
              </Link>
              <a href="#checkout" className="posx-button posx-button-secondary">
                See how it works
              </a>
            </div>
            <ul className="posx-proof posx-rise posx-rise-4">
              <li>
                <Check size={16} /> Two locations included
              </li>
              <li>
                <Check size={16} /> Desktop, tablet or phone
              </li>
              <li>
                <Check size={16} /> 0% StoreMink transaction fee
              </li>
            </ul>
          </div>

          <div className="posx-container posx-hero-visual posx-rise posx-rise-3">
            <div className="posx-image-frame">
              <Image
                src={posDevicesImage}
                alt="StoreMink Point of Sale running on a desktop, tablet and phone in a retail store"
                loading="eager"
                sizes="(max-width: 760px) 94vw, 1240px"
                className="posx-hero-image"
              />
              <span className="posx-image-badge posx-image-badge-left">
                <span className="posx-live-dot" /> Website + counter stock in
                sync
              </span>
              <span className="posx-image-badge posx-image-badge-right">
                <ReceiptText size={16} /> GST-ready checkout
              </span>
            </div>
          </div>
        </header>

        <section className="posx-journeys" aria-labelledby="retail-day-title">
          <div className="posx-container">
            <div className="posx-section-heading posx-section-heading-center">
              <span className="posx-label">One connected retail day</span>
              <h2 id="retail-day-title">
                The counter is not another channel to reconcile.
              </h2>
              <p>
                Your customer sees one business. StoreMink gives your team one
                place to run it.
              </p>
            </div>
            <div className="posx-journey-grid">
              {RETAIL_JOURNEYS.map((journey) => (
                <a
                  href={journey.href}
                  className="posx-journey-card"
                  key={journey.title}
                >
                  <span className="posx-journey-icon">
                    <journey.icon size={24} />
                  </span>
                  <small>{journey.eyebrow}</small>
                  <h3>{journey.title}</h3>
                  <p>{journey.body}</p>
                  <span className="posx-text-link">
                    Explore workflow <ArrowRight size={15} />
                  </span>
                </a>
              ))}
            </div>
          </div>
        </section>

        <section className="posx-story" id="checkout">
          <div className="posx-container posx-story-grid">
            <div className="posx-story-copy">
              <span className="posx-label">01 · In-store checkout</span>
              <h2>A register your team can learn before the queue forms.</h2>
              <p>
                Products, customer history and the current cart stay within
                reach. Scan with a barcode gun, use a phone camera or search the
                same catalogue that powers your website.
              </p>
              <ul className="posx-checklist">
                <li>
                  <CircleCheck size={19} /> Hold a sale and return to it later
                </li>
                <li>
                  <CircleCheck size={19} /> Add customers without leaving
                  checkout
                </li>
                <li>
                  <CircleCheck size={19} /> Record cash, card, UPI or split
                  tenders
                </li>
              </ul>
              <Link
                href={`${PLATFORM_URL}/signup`}
                className="posx-inline-link"
              >
                Build your store <ArrowRight size={17} />
              </Link>
            </div>
            <div className="posx-story-visual posx-story-visual-lilac">
              <span className="posx-visual-note">
                <ScanLine size={15} /> Built for the rush
              </span>
              <CheckoutPreview />
            </div>
          </div>
        </section>

        <section className="posx-inventory" id="inventory">
          <div className="posx-container posx-story-grid posx-story-grid-reverse">
            <div className="posx-story-visual posx-story-visual-dark">
              <span className="posx-visual-note posx-visual-note-dark">
                <span className="posx-live-dot" /> Synced across every place you
                sell
              </span>
              <InventoryPreview />
            </div>
            <div className="posx-story-copy posx-story-copy-light">
              <span className="posx-label posx-label-light">
                02 · Multi-location inventory
              </span>
              <h2>Every sale moves the same stock.</h2>
              <p>
                See what is available at each shop, receive new stock and
                transfer units between locations. Online availability comes from
                the locations you choose to fulfil web orders.
              </p>
              <div className="posx-quote-block">
                <strong>No nightly CSV. No duplicate catalogue.</strong>
                <span>
                  When an online-fulfilling shop sells its last unit, your
                  website stops promising it too.
                </span>
              </div>
              <Link
                href={`${PLATFORM_URL}/signup`}
                className="posx-inline-link posx-inline-link-light"
              >
                Connect your inventory <ArrowRight size={17} />
              </Link>
            </div>
          </div>
        </section>

        <section className="posx-story posx-fulfilment" id="fulfilment">
          <div className="posx-container posx-story-grid">
            <div className="posx-story-copy">
              <span className="posx-label">
                03 · Pickup, returns & store credit
              </span>
              <h2>Online orders arrive at the counter ready for action.</h2>
              <p>
                Route pickup orders to the right shop, prepare them from one
                queue and complete collection where the customer arrives.
                Returns stay connected to the original order instead of becoming
                a note beside the till.
              </p>
              <div className="posx-mini-points">
                <span>
                  <PackageCheck size={20} /> Prepare and hand over pickup
                </span>
                <span>
                  <RotateCcw size={20} /> Return to stock or store credit
                </span>
              </div>
            </div>
            <div className="posx-story-visual posx-story-visual-mint">
              <span className="posx-visual-note">
                <ShoppingBag size={15} /> One order timeline
              </span>
              <FulfilmentPreview />
            </div>
          </div>
        </section>

        <section className="posx-operations" id="operations">
          <div className="posx-container">
            <div className="posx-section-heading posx-section-heading-split">
              <div>
                <span className="posx-label">The operational details</span>
                <h2>Everything around the sale is part of the product.</h2>
              </div>
              <p>
                A checkout is only fast when the receipt, permissions, drawer
                and customer record are already in order.
              </p>
            </div>
            <div className="posx-operations-grid">
              {OPERATIONS.map((feature, index) => (
                <article
                  className={`posx-operation-card posx-operation-card-${index + 1}`}
                  key={feature.title}
                >
                  <span className="posx-operation-icon">
                    <feature.icon size={22} />
                  </span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="posx-pricing" id="pricing">
          <div className="posx-container posx-pricing-card">
            <div className="posx-pricing-copy">
              <span className="posx-label posx-label-light">StoreMink Pro</span>
              <h2>Point of Sale is included. The second bill is not.</h2>
              <p>
                Run your website and physical stores on the same plan. POS is
                not priced per terminal and StoreMink adds no transaction fee to
                a counter sale.
              </p>
              <div className="posx-pricing-actions">
                <Link
                  href={`${PLATFORM_URL}/signup`}
                  className="posx-button posx-button-light"
                >
                  Start free <ArrowRight size={17} />
                </Link>
                <Link
                  href={`${PLATFORM_URL}/#pricing`}
                  className="posx-button posx-button-outline"
                >
                  Compare plans
                </Link>
              </div>
            </div>
            <div className="posx-price-box">
              <span>Pro from</span>
              <strong>
                {inr(proMonthlyEquivalentInr)}
                <small>/month</small>
              </strong>
              <p>billed yearly</p>
              <ul>
                <li>
                  <Check size={16} /> 2 locations included
                </li>
                <li>
                  <Check size={16} /> {PLAN_LIMITS.pro.posDevicesPerLocation}{" "}
                  authorised tills per location
                </li>
                <li>
                  <Check size={16} /> Unlimited products and staff
                </li>
                <li>
                  <Check size={16} /> Storefront, orders and POS together
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="posx-setup" aria-labelledby="setup-title">
          <div className="posx-container">
            <div className="posx-section-heading posx-section-heading-center">
              <span className="posx-label">No installation day</span>
              <h2 id="setup-title">
                From dashboard to first shift in four steps.
              </h2>
              <p>
                No engineer, proprietary terminal or duplicate catalogue
                required.
              </p>
            </div>
            <div className="posx-setup-grid">
              {FLOW.map((step) => (
                <article className="posx-setup-step" key={step.n}>
                  <span>{step.n}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="posx-faq" id="faq">
          <div className="posx-container posx-faq-grid">
            <div className="posx-faq-intro">
              <span className="posx-label">Straight answers</span>
              <h2>What a store owner should know before switching on POS.</h2>
              <p>
                No vague promises about hardware, payments or internet. If
                something has a limit, it is written here.
              </p>
              <Link
                href={`${PLATFORM_URL}/signup`}
                className="posx-inline-link"
              >
                Try StoreMink free <ArrowRight size={17} />
              </Link>
            </div>
            <div className="posx-faq-list">
              {FAQS.map((faq) => (
                <details key={faq.q}>
                  <summary>{faq.q}</summary>
                  <p>{faq.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="posx-final-cta">
          <div className="posx-container posx-final-card">
            <span className="posx-final-icon">
              <Store size={27} />
            </span>
            <h2>One business should run on one system.</h2>
            <p>
              Start your StoreMink shop free today. Add Point of Sale with Pro
              when the counter is ready.
            </p>
            <div className="posx-hero-actions">
              <Link
                href={`${PLATFORM_URL}/signup`}
                className="posx-button posx-button-light"
              >
                Create your store free <ArrowRight size={18} />
              </Link>
              <Link
                href={PLATFORM_URL}
                className="posx-button posx-button-outline"
              >
                Explore StoreMink
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="posx-footer">
        <div className="posx-container posx-footer-inner">
          <div>
            <ProductMark />
            <p>
              The India-first commerce system for online and in-store retail.
            </p>
          </div>
          <div className="posx-footer-links">
            <div>
              <b>Point of Sale</b>
              <a href="#checkout">Checkout</a>
              <a href="#inventory">Inventory</a>
              <a href="#fulfilment">Pickup & returns</a>
            </div>
            <div>
              <b>StoreMink</b>
              <Link href={PLATFORM_URL}>Home</Link>
              <Link href={`${PLATFORM_URL}/#pricing`}>Pricing</Link>
              <Link href={`${PLATFORM_URL}/login`}>Log in</Link>
            </div>
          </div>
        </div>
        <div className="posx-container posx-footer-bottom">
          <span>© {new Date().getFullYear()} StoreMink</span>
          <span>
            <Clock3 size={14} /> POS that works the way your retail day does.
          </span>
        </div>
      </footer>
    </div>
  );
}
