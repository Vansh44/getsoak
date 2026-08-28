import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ★★ A `loading.tsx` ABOVE A PUBLIC ROUTE TURNS EVERY 404 INTO A SOFT 404.
//
// `app/loading.tsx` used to exist, and it wrapped the ENTIRE app in one
// Suspense boundary. Next then flushes the shell — with the HTTP status already
// committed as 200 — before the layout beneath it runs, so a later
// `notFound()` renders the correct page into a response that has already said
// "200 OK". Measured on the deployed environments 2026-08-29, all three of
// these served the right body under the wrong status:
//
//   unclaimed store subdomain        -> 200  (should be 404)
//   real store, missing page         -> 200  (should be 404)
//   real store, missing product      -> 200  (should be 404)
//   help centre, missing article     -> 200  (should be 404)
//
// That is precisely the soft-404 Google penalises, and it is invisible in a
// browser: the page LOOKS like a 404, so nobody thinks to check the status.
// `x-robots-tag: noindex` limited the damage but is not the contract —
// `lib/seo/disallow.ts` and app/sitemap.ts both assume a real 404 here.
//
// The rule, and the reason this test exists rather than a comment: NEVER put a
// loading.tsx above a publicly indexable route. Auth-gated, noindex areas
// (dashboard / platform / pos) may have one — they gain the navigation
// feedback and no crawler ever sees their status codes.
//
// Same shape as app/pos/idle-lock-coverage.test.ts: a structural rule the type
// system cannot express, so a test holds it instead.

const APP_DIR = join(process.cwd(), "app");

/**
 * Route areas that are served to anonymous visitors and indexed by search
 * engines. A Suspense boundary at or above any of these re-introduces the soft
 * 404. `""` is the app root itself — the boundary that caused this.
 */
const PUBLIC_AREAS = [
  "", // app/loading.tsx — the original offender; covers EVERY route.
  "(storefront)", // merchant storefronts: unknown store, missing page/product
  "help", // help.storemink.com — public and crawled
  "themes", // themes.storemink.com — public and crawled
];

/** Areas allowed a boundary: auth-gated and noindex, so status codes are unobserved. */
const ALLOWED_AREAS = ["dashboard", "platform", "pos"];

/**
 * Boundaries inside a public area that are nonetheless safe, each with the
 * reason it cannot produce a soft 404 on an indexable URL. An entry earns its
 * place by BOTH being noindex and containing no `notFound()` — the test below
 * re-checks the noindex half, so making one of these pages indexable fails here
 * rather than quietly reintroducing the bug.
 */
const PUBLIC_EXCEPTIONS: { file: string; page: string }[] = [
  // /help/search sets `robots: { index: false }` and never calls notFound() —
  // it renders results or an empty state. Search is genuinely slow, so the
  // boundary is doing real work.
  { file: "help/search/loading.tsx", page: "help/search/page.tsx" },
];

const isException = (f: string) => PUBLIC_EXCEPTIONS.some((e) => e.file === f);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (entry === "loading.tsx") out.push(full);
  }
  return out;
}

describe("loading boundary coverage", () => {
  const found = walk(APP_DIR).map((f) => relative(APP_DIR, f));

  it("finds the app directory at all (the walk must not silently pass)", () => {
    // A guard whose walk quietly matches nothing reports success forever.
    expect(existsSync(join(APP_DIR, "layout.tsx"))).toBe(true);
    expect(readdirSync(APP_DIR).length).toBeGreaterThan(5);
  });

  it("has NO root app/loading.tsx — it soft-404s every route in the app", () => {
    expect(found).not.toContain("loading.tsx");
  });

  it.each(PUBLIC_AREAS.filter(Boolean))(
    "has no loading.tsx anywhere under the public area %s",
    (area) => {
      const offenders = found.filter(
        (f) =>
          (f === `${area}/loading.tsx` || f.startsWith(`${area}/`)) &&
          !isException(f),
      );
      expect(offenders).toEqual([]);
    },
  );

  it("still keeps the loading UI for the auth-gated areas", () => {
    // The other direction: this fix moved the boundary rather than deleting the
    // idea, and silently losing it would regress navigation feedback on the
    // heaviest screens in the product with nothing to catch it.
    for (const area of ALLOWED_AREAS) {
      expect(found).toContain(`${area}/loading.tsx`);
    }
  });

  it("every loading.tsx that exists sits under an allowed area", () => {
    // Catches a boundary added to a NEW public surface — the next themes/help.
    const stray = found.filter(
      (f) =>
        !ALLOWED_AREAS.some((a) => f.startsWith(`${a}/`)) && !isException(f),
    );
    expect(stray).toEqual([]);
  });

  it.each(PUBLIC_EXCEPTIONS)(
    "exception $file is still noindex, which is what makes it safe",
    ({ file, page }) => {
      // The exception is justified by the page being noindex. If that ever
      // changes, the boundary starts soft-404ing a crawled URL — so the
      // justification is asserted, not just written down.
      expect(found).toContain(file);
      const src = readFileSync(join(APP_DIR, page), "utf8");
      expect(src).toMatch(/index:\s*false/);
    },
  );
});
