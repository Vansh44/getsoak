import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAW = readFileSync(join(process.cwd(), "app/sitemap.ts"), "utf8");

// Strip comments before matching. The file DISCUSSES `new Date()` and
// `export const revalidate` at length — explaining why neither belongs here is
// the point — so a naive scan of the raw text flags the very documentation
// that keeps the invariant from being undone.
const SOURCE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/**
 * A source-level guard, in the style of the RESERVED_PAGE_SLUGS drift test and
 * lib/email/send-coverage.test.ts.
 *
 * Testing the real sitemap() would mean standing up headers() and the whole DB
 * read path for what is really a one-line invariant: NO URL may carry a lastmod
 * derived from the current time. The bug this prevents is invisible in any
 * single response — you only see it by fetching twice and diffing, which is
 * exactly what nobody does. It cost this site its lastmod credibility site-wide:
 * every static path, every product, the help hub and every help category
 * shipped `new Date()`, so two fetches four seconds apart disagreed, and
 * Google's documented response to unreliable lastmod is to disregard it for the
 * whole site — discarding the blog and help-article dates that were accurate.
 */
describe("sitemap lastmod honesty", () => {
  it("never constructs a current-time Date", () => {
    // `new Date()` with no argument is the only way to get "now" here.
    // `new Date(someTimestamp)` is fine and is how every real lastmod is built.
    const bare = SOURCE.match(/new Date\(\s*\)/g) ?? [];
    expect(
      bare,
      "app/sitemap.ts must derive every lastModified from a real content " +
        "timestamp, or omit it — never from the request time",
    ).toEqual([]);
  });

  it("does not export a revalidate value", () => {
    // The route awaits headers(), which forces it dynamic — any `revalidate`
    // here is dead config that reads as a freshness guarantee it cannot make.
    expect(/export\s+const\s+revalidate/.test(SOURCE)).toBe(false);
  });

  it("resolves the store origin through storeOrigin(), not custom_domain", () => {
    // Guards the fix in lib/site.ts: building the origin inline from
    // `custom_domain ?? subdomain` skips the verified check and canonicalises
    // the whole store onto a domain we may not serve.
    expect(SOURCE).toContain("storeOrigin(store)");
    expect(SOURCE).not.toMatch(/custom_domain\s*\?\?/);
  });
});
