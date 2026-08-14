import { BrandMark } from "@/app/platform/brand-mark";
import "./not-found.css";

// Root 404. Reached when the (storefront) layout can't resolve the request Host
// to a real store (unclaimed subdomain / unknown custom domain) — it renders in
// the neutral root layout, with no store chrome, so it can't leak another
// store's branding. (In-store page/product misses render the storefront
// not-found instead — see app/(storefront)/not-found.tsx.)
//
// Every outbound link is ABSOLUTE to the platform origin: the Host we're being
// served on maps to no store, so a relative /signup would just 404 again here.
export const metadata = {
  title: "Store not found",
  robots: { index: false, follow: false },
};

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";
const PLATFORM = `https://${ROOT_DOMAIN}`;
const SUPPORT_EMAIL = "support@storemink.com";

export default function NotFound() {
  return (
    <main className="sm404">
      <a className="sm404-brand sm404-rise" href={PLATFORM}>
        <BrandMark size={30} priority />
        <span className="sm404-wordmark">
          Store<span>Mink</span>
        </span>
      </a>

      <div className="sm404-main">
        {/* ------------------------------ copy ------------------------------ */}
        <div>
          <span className="sm404-eyebrow sm404-rise sm404-rise-1">
            <i />
            Error 404 · Store not found
          </span>

          <h1 className="sm404-title sm404-rise sm404-rise-1">
            This storefront
            <em>doesn&rsquo;t exist</em>
          </h1>

          <p className="sm404-lede sm404-rise sm404-rise-2">
            The address you typed isn&rsquo;t tied to an active StoreMink store.
            It may have moved, been renamed, or never been set up at all. Spin
            up your own in minutes — or get in touch and we&rsquo;ll help you
            find it.
          </p>

          <div className="sm404-cta sm404-rise sm404-rise-3">
            <a
              className="sm404-btn sm404-btn-primary"
              href={PLATFORM}
              rel="noreferrer"
            >
              Explore StoreMink
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
            </a>
            <a
              className="sm404-btn sm404-btn-ghost"
              href={`mailto:${SUPPORT_EMAIL}`}
            >
              Get in touch
            </a>
          </div>

          <dl className="sm404-meta sm404-rise sm404-rise-4">
            <div>
              <dt>Support</dt>
              <dd>
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
              </dd>
            </div>
            <div>
              <dt>Platform</dt>
              <dd>
                <span className="sm404-status">
                  <i />
                  Operational
                </span>
              </dd>
            </div>
          </dl>
        </div>

        {/* ---------------------------- artwork ----------------------------
            Decorative collage: the store that isn't there (dashed, drained)
            behind the numerals, with a live preview and the way out in front. */}
        <div className="sm404-art sm404-rise sm404-rise-2">
          <div className="sm404-art-glow" aria-hidden="true" />

          <div className="sm404-win sm404-win-back" aria-hidden="true">
            <div className="sm404-win-bar">
              <span className="sm404-dot" />
              <span className="sm404-dot" />
              <span className="sm404-dot" />
              <span className="sm404-win-url">store · 404</span>
            </div>
            <div className="sm404-skel">
              <div className="sm404-skel-row">
                <div className="sm404-skel-box" />
                <div className="sm404-skel-box" />
                <div className="sm404-skel-box" />
              </div>
              <div className="sm404-skel-line" />
              <div className="sm404-skel-line is-short" />
            </div>
          </div>

          <div className="sm404-num" aria-hidden="true">
            4<span className="sm404-o" />4
          </div>

          <span className="sm404-tag sm404-tag-a" aria-hidden="true">
            No store here
          </span>
          <span className="sm404-pill" aria-hidden="true">
            Your brand
          </span>

          <div className="sm404-win sm404-win-front" aria-hidden="true">
            <div className="sm404-win-bar">
              <span className="sm404-dot" />
              <span className="sm404-dot" />
              <span className="sm404-win-url">preview</span>
            </div>
            <div className="sm404-preview">
              <div className="sm404-preview-hero" />
              <div className="sm404-preview-grid">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>

          <a className="sm404-promo" href={`${PLATFORM}/signup`}>
            <span className="sm404-promo-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#fff"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
            </span>
            <span>
              <b>Get your own storefront</b>
              <small>Live in under 5 minutes</small>
            </span>
            <svg
              className="sm404-promo-arrow"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </a>
        </div>
      </div>

      <footer className="sm404-foot">
        <span>© StoreMink · {new Date().getFullYear()}</span>
        <a href={PLATFORM}>{ROOT_DOMAIN}</a>
      </footer>
    </main>
  );
}
