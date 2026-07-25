import Link from "next/link";
import "./not-found.css";

// In-store 404 — the store exists but this page/product/blog doesn't. Renders
// INSIDE the storefront layout (Header/Footer + the store's branding). Distinct
// from the root not-found, which is for an unknown STORE (unresolved host).
//
// Everything is styled off --sm-* theme tokens, so this page re-skins with the
// store's theme rather than shipping a palette of its own.
export const metadata = { title: "Page not found" };

export default function StorefrontNotFound() {
  return (
    <main className="sf404">
      <div className="sf404-art" aria-hidden="true">
        4<span className="sf404-o" />4
        <span className="sf404-tag">
          <i />
          Page not found
        </span>
      </div>

      <h1 className="sf404-title">We can&rsquo;t find that page</h1>
      <p className="sf404-lede">
        The link may be broken, or the page may have been moved or removed.
        Search for what you were after, or pick up where you left off below.
      </p>

      {/* Plain GET form — /shop reads ?q= and filters the grid, so search works
          here with no client JS. */}
      <form className="sf404-search" action="/shop" method="get" role="search">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          name="q"
          placeholder="Search for a product…"
          aria-label="Search products"
        />
        <button type="submit">Search</button>
      </form>

      <div className="sf404-links">
        <Link href="/">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V21h14V9.5" />
          </svg>
          Back to home
        </Link>
        <Link href="/shop">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 8V6.5a4 4 0 0 1 8 0V8" />
            <path d="M4.5 8h15l-.9 11.2a2 2 0 0 1-2 1.8H7.4a2 2 0 0 1-2-1.8L4.5 8Z" />
          </svg>
          Browse all products
        </Link>
      </div>
    </main>
  );
}
