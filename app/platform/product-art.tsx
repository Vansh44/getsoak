// ---------------------------------------------------------------------------
// Product artwork for the marketing pages.
//
// The first version of these was grey bars standing in for content, and it
// looked exactly like what it was: a wireframe. Shopify's equivalents carry
// real product names, real prices and a real Checkout button, and that detail
// is most of why theirs read as software and ours read as a placeholder.
//
// So these carry real strings. They are still DRAWN — no screenshots to go
// stale, no photography we don't own — but everything written on them is what
// the product would actually say. Nothing here claims a feature that doesn't
// exist; the register really does scan, hold a cart, split GST and take a
// split tender.
//
// All of it is decorative: each root carries aria-hidden, and the meaning
// lives in the heading and copy beside it.
// ---------------------------------------------------------------------------

/**
 * The register — a till with a live sale on it, and the tender on a phone.
 *
 * `compact` is for the ~430px showcase card. The full composition is designed
 * for the hero's ~600px column, and squeezed into a card it collapsed: six
 * product names ellipsised down to single letters, the totals wrapping over
 * three lines, the phone landing on top of the Charge button. Fewer tiles and
 * no phone is not a lesser version — it is the one that stays legible.
 */
export function RegisterArt({ compact = false }: { compact?: boolean } = {}) {
  const tiles = [
    // Kept short on purpose: the tiles are ~90px wide at card size, and six
    // ellipsised names read as broken rather than as a busy catalogue.
    { name: "Cold Brew", price: "₹100", stock: "42" },
    { name: "Amul Taaza", price: "₹64", stock: "18" },
    { name: "Tata Salt", price: "₹28", stock: "7" },
    { name: "Basmati Rice", price: "₹185", stock: "25" },
    { name: "Ragda Mix", price: "₹90", stock: "31" },
    { name: "Cookies", price: "₹120", stock: "0" },
  ].slice(0, compact ? 4 : 6);
  return (
    <div
      className={`sm-art sm-art-register${compact ? " is-compact" : ""}`}
      aria-hidden="true"
    >
      <div className="art-tablet">
        <div className="art-status">
          <span>Main shop · Till 1</span>
          <span className="art-status-live">
            <i /> Shift open
          </span>
        </div>
        <div className="art-body">
          <div className="art-left">
            <div className="art-search">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none">
                <circle
                  cx="7"
                  cy="7"
                  r="4.4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
                <path
                  d="M10.4 10.4 14 14"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              Scan a barcode or search
            </div>
            <div className="art-tiles">
              {tiles.map((t) => (
                <div
                  className={`art-tile${t.stock === "0" ? " is-out" : ""}`}
                  key={t.name}
                >
                  <span className="art-tile-badge">
                    {t.stock === "0" ? "Sold out" : t.stock}
                  </span>
                  <b>{t.name}</b>
                  <span className="art-tile-price">{t.price}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="art-order">
            <div className="art-order-head">
              <b>New sale</b>
              <span>3 items</span>
            </div>
            <ul className="art-lines">
              <li>
                <span className="q">2</span>
                <span className="n">Amul Taaza 1L</span>
                <span className="p">₹128</span>
              </li>
              <li>
                <span className="q">1</span>
                <span className="n">Tata Salt 1kg</span>
                <span className="p">₹28</span>
              </li>
            </ul>
            <div className="art-totals">
              <div>
                <span>Subtotal</span>
                <span>₹156.00</span>
              </div>
              <div>
                {/* The full split needs the hero's width; in a card it wraps to
                    two lines and the totals stop lining up. */}
                <span>{compact ? "GST 5%" : "CGST 2.5% + SGST 2.5%"}</span>
                <span>₹7.80</span>
              </div>
              <div className="art-total-row">
                <span>Total</span>
                <span>₹163.80</span>
              </div>
            </div>
            <div className="art-charge">Charge ₹163.80</div>
          </div>
        </div>
      </div>

      {compact ? null : (
        <div className="art-phone">
          <div className="art-phone-top">Cash</div>
          <div className="art-phone-amt">₹200.00</div>
          <div className="art-phone-rows">
            <div>
              <span>Total</span>
              <span>₹163.80</span>
            </div>
            <div className="art-change">
              <span>Change</span>
              <span>₹36.20</span>
            </div>
          </div>
          <div className="art-phone-btn">Complete sale</div>
        </div>
      )}
    </div>
  );
}

/** The storefront — a browser with a real-looking shop in it. */
export function StorefrontArt() {
  const products = [
    { name: "Cold Brew Concentrate", price: "₹249", tone: "a" },
    { name: "Butter Cookies 300g", price: "₹329", tone: "b" },
    { name: "Fresh Orange Juice", price: "₹199", tone: "c" },
  ];
  return (
    <div className="sm-art sm-art-store" aria-hidden="true">
      <div className="art-browser">
        <div className="art-chrome">
          <i />
          <i />
          <i />
          <span className="art-url">
            🔒 <b>yourbrand</b>.storemink.com
          </span>
        </div>
        <div className="art-site">
          <div className="art-nav">
            <span className="art-brandmark" />
            <b>yourbrand</b>
            <span className="art-navlinks">
              <span>Shop</span>
              <span>About</span>
              <span>Contact</span>
            </span>
          </div>
          <div className="art-banner">
            <b>Made with care. Delivered with pride.</b>
            <span>Free delivery on orders over ₹499</span>
            <span className="art-cta">Shop now</span>
          </div>
          <div className="art-products">
            {products.map((p) => (
              <div className="art-product" key={p.name}>
                <span className={`art-thumb art-thumb-${p.tone}`} />
                <b>{p.name}</b>
                <span className="art-price">{p.price}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The website builder — outline, canvas, and the section being edited. */
export function BuilderArt() {
  const sections = [
    "Header",
    "Hero banner",
    "Featured products",
    "Offer tiles",
    "FAQs",
    "Footer",
  ];
  return (
    <div className="sm-art sm-art-builder" aria-hidden="true">
      <div className="art-app">
        <div className="art-app-bar">
          <span className="art-app-title">Home page</span>
          <span className="art-publish">Publish</span>
        </div>
        <div className="art-app-body">
          <div className="art-outline">
            {sections.map((s, i) => (
              <span className={`art-sec${i === 2 ? " is-on" : ""}`} key={s}>
                {s}
              </span>
            ))}
          </div>
          <div className="art-canvas">
            <div className="art-canvas-hero">Hero banner</div>
            <div className="art-canvas-row">
              <span />
              <span />
              <span />
            </div>
            <div className="art-canvas-bar" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A GST tax invoice. */
export function InvoiceArt() {
  return (
    <div className="sm-art sm-art-invoice" aria-hidden="true">
      <div className="art-sheet art-sheet-back" />
      <div className="art-sheet">
        <div className="art-inv-head">
          <span className="art-inv-logo" />
          <span className="art-inv-title">TAX INVOICE</span>
        </div>
        <div className="art-inv-meta">
          <span>ORD10011027</span>
          <span>GSTIN 27AAECS1234F1Z5</span>
        </div>
        <table className="art-inv-table">
          <tbody>
            <tr>
              <td>Cold Brew 250ml</td>
              <td>HSN 2202</td>
              <td>₹200.00</td>
            </tr>
            <tr>
              <td>Butter Cookies</td>
              <td>HSN 1905</td>
              <td>₹120.00</td>
            </tr>
          </tbody>
        </table>
        <div className="art-inv-gst">
          <div>
            <span>CGST 2.5%</span>
            <span>₹8.00</span>
          </div>
          <div>
            <span>SGST 2.5%</span>
            <span>₹8.00</span>
          </div>
        </div>
        <div className="art-inv-total">
          <span>Total</span>
          <span>₹336.00</span>
        </div>
      </div>
    </div>
  );
}
