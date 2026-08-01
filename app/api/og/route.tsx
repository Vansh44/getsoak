import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

/**
 * Dynamic branded Open Graph card — a 1200×630 social image generated from a
 * single `d` param, so any store gets a proper share card with zero uploaded
 * assets. Used as the default og:image for the homepage and custom pages
 * (see the storefront generateMetadata callers), which otherwise had none.
 *
 *   /api/og?d=<JSON {title, subtitle?, color?}>
 *
 * A single param (built by lib/seo/og-card.brandOgImageUrl) keeps a bare `&`
 * out of the URL — see that file and lib/og-image.ts for why. Deterministic
 * per query string, so it caches hard at the CDN.
 */

export const runtime = "nodejs";

const WIDTH = 1200;
const HEIGHT = 630;
const DEFAULT_COLOR = "#17130f"; // matches lib/store/brand.DEFAULT_PRIMARY

// Accept only a hex colour (with or without #); anything else → default. The
// value is drawn into an image, never HTML, but validating keeps the render
// predictable and avoids a broken card from a malformed param.
function normalizeColor(raw: string | null): string {
  if (!raw) return DEFAULT_COLOR;
  const hex = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex) ? hex : DEFAULT_COLOR;
}

// Pick black or white text for legibility on the brand colour (perceived
// luminance, ITU-R BT.601 weights).
function readableInk(hex: string): string {
  const h = hex.slice(1);
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#17130f" : "#ffffff";
}

function clamp(s: string | null, max: number): string {
  const t = (s ?? "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * A logo for the card, as a data URI.
 *
 * Read off disk and inlined rather than given to Satori as a URL: an <img src>
 * makes the renderer fetch over the network while a crawler waits, and a slow
 * or failed fetch produces a BROKEN share card — the one image you never get a
 * second chance at. Read once at module scope; it is a 63 KB file that never
 * changes between deploys.
 *
 * ⚠ Only a path under public/ is accepted, and only from our own callers. A
 * remote URL is deliberately NOT supported: it would let any query string make
 * this route fetch an arbitrary host (SSRF) on every crawl.
 */
const LOGO_CACHE = new Map<string, string | null>();

function localLogoDataUri(path: string | undefined): string | null {
  if (!path || !path.startsWith("/brand/")) return null;
  if (LOGO_CACHE.has(path)) return LOGO_CACHE.get(path)!;
  let uri: string | null = null;
  try {
    // No "..": the prefix check above already pins it to public/brand, but a
    // traversal attempt should fail closed rather than read something else.
    if (!path.includes("..")) {
      const buf = readFileSync(join(process.cwd(), "public", path));
      uri = `data:image/png;base64,${buf.toString("base64")}`;
    }
  } catch {
    uri = null; // a missing file must not break the card
  }
  LOGO_CACHE.set(path, uri);
  return uri;
}

function parsePayload(raw: string | null): {
  title?: string;
  subtitle?: string;
  color?: string;
  logo?: string;
  footer?: string;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function GET(request: NextRequest) {
  const data = parsePayload(request.nextUrl.searchParams.get("d"));
  const title = clamp(data.title ?? null, 60) || "Store";
  const subtitle = clamp(data.subtitle ?? null, 90);
  const color = normalizeColor(data.color ?? null);
  const ink = readableInk(color);
  const logo = localLogoDataUri(data.logo);
  // Defaults to the title, which is right for a store (its own name under the
  // rule). The platform passes its domain instead — with a logo and a headline
  // above it, a third "StoreMink" is just repetition.
  const footer = clamp(data.footer ?? null, 60) || title;
  const faint =
    ink === "#ffffff" ? "rgba(255,255,255,0.72)" : "rgba(23,19,15,0.66)";
  const rule =
    ink === "#ffffff" ? "rgba(255,255,255,0.28)" : "rgba(23,19,15,0.22)";

  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "center",
        backgroundColor: color,
        padding: "90px",
      }}
    >
      {logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          width={104}
          height={104}
          alt=""
          style={{ marginBottom: 36 }}
        />
      ) : (
        // No logo (a store that hasn't uploaded one) keeps the plain rule —
        // better an intentional mark than someone else's brand on their card.
        <div
          style={{
            width: 64,
            height: 8,
            borderRadius: 8,
            backgroundColor: ink,
            marginBottom: 40,
            display: "flex",
          }}
        />
      )}
      <div
        style={{
          fontSize: title.length > 26 ? 76 : 96,
          fontWeight: 700,
          color: ink,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
          display: "flex",
        }}
      >
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            fontSize: 38,
            color: faint,
            marginTop: 28,
            lineHeight: 1.3,
            display: "flex",
          }}
        >
          {subtitle}
        </div>
      ) : null}
      <div
        style={{
          marginTop: "auto",
          paddingTop: 48,
          borderTop: `2px solid ${rule}`,
          width: "100%",
          fontSize: 26,
          color: faint,
          display: "flex",
        }}
      >
        {footer}
      </div>
    </div>,
    {
      width: WIDTH,
      height: HEIGHT,
      headers: {
        "Cache-Control":
          "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
      },
    },
  );
}
