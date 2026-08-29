import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "app/platform/page.tsx"), "utf8");
const css = readFileSync(
  join(process.cwd(), "app/platform/homepage.css"),
  "utf8",
);

describe("StoreMink public homepage", () => {
  it("presents the connected commerce story and its conversion paths", () => {
    expect(page).toContain('id="platform"');
    expect(page).toContain('id="pricing"');
    expect(page).toContain('id="faq"');
    expect(page).toContain("Create your store.");
    expect(page).toContain("Sell everywhere.");
    expect(page).toContain("Grow with AI.");
    expect(page).toContain("Mink AI, currently in beta, helps");
    expect(page).toContain('q: "What can Mink AI do?"');
    expect(page).toContain("StoreMink Point of Sale");
    expect(page).toContain("<HomepageMobileNav");
    expect(page).toContain('href="/signup"');
    expect(page).toContain('type="application/ld+json"');
  });

  it("uses the current multidevice POS product image", () => {
    expect(page).toContain('src="/brand/storemink-pos-multidevice.png"');
    expect(page).toContain(
      'alt="StoreMink Point of Sale running on a desktop, tablet and phone"',
    );
  });

  it("keeps the redesign isolated, responsive and motion-safe", () => {
    expect(css).toContain(".smh {");
    expect(css).toMatch(/@media \(max-width: 940px\)/);
    expect(css).toMatch(/@media \(max-width: 680px\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
    expect(css).not.toMatch(/^\.(?:stq|posx)-/m);
  });
});
