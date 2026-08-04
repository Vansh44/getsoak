import { describe, it, expect } from "vitest";
import { readdirSync } from "fs";
import { join } from "path";
import {
  CODE_MAX_CHARS,
  EMPTY_CONFIG,
  MAX_PAGE_SECTIONS,
  RESERVED_PAGE_SLUGS,
  clampCodeHeight,
  validateConfig,
  validatePageSlug,
  validateSections,
  validateSectionStyle,
  summarizeSection,
  type CustomCodeConfig,
  type PageSectionItem,
  type RichTextConfig,
} from "./registry";

// ---------------------------------------------------------------------------
// New section types (rich_text / custom_code)
// ---------------------------------------------------------------------------

describe("rich_text validation", () => {
  it("accepts html and normalises width", () => {
    const r = validateConfig("rich_text", { html: "<p>Hi</p>", width: "x" });
    expect("config" in r && (r.config as RichTextConfig).width).toBe(
      "contained",
    );
  });

  it("rejects empty content", () => {
    const r = validateConfig("rich_text", { html: "   " });
    expect("error" in r && r.error).toMatch(/content/i);
  });

  it("rejects oversized content", () => {
    const r = validateConfig("rich_text", { html: "x".repeat(129 * 1024) });
    expect("error" in r && r.error).toMatch(/too large/i);
  });
});

describe("custom_code validation", () => {
  it("accepts code and defaults height mode to auto", () => {
    const r = validateConfig("custom_code", { html: "<div>w</div>" });
    expect("config" in r).toBe(true);
    const c = (r as { config: CustomCodeConfig }).config;
    expect(c.height_mode).toBe("auto");
    expect(c.css).toBe("");
    expect(c.js).toBe("");
  });

  it("requires at least one of html/css/js", () => {
    const r = validateConfig("custom_code", { html: " ", css: "", js: "" });
    expect("error" in r && r.error).toMatch(/html, css or javascript/i);
  });

  it("caps each field at 64 KB", () => {
    const r = validateConfig("custom_code", {
      js: "x".repeat(CODE_MAX_CHARS + 1),
    });
    expect("error" in r && r.error).toMatch(/javascript is too large/i);
  });

  it("clamps fixed heights into range", () => {
    expect(clampCodeHeight(1)).toBe(40);
    expect(clampCodeHeight(999999)).toBe(4000);
    expect(clampCodeHeight(NaN)).toBe(EMPTY_CONFIG.custom_code.fixed_height);
    const r = validateConfig("custom_code", {
      html: "<b>x</b>",
      height_mode: "fixed",
      fixed_height: 7,
    });
    expect((r as { config: CustomCodeConfig }).config.fixed_height).toBe(40);
  });

  it("summarizes which languages are present", () => {
    const r = validateConfig("custom_code", { html: "<b>x</b>", js: "1;" });
    const summary = summarizeSection({
      type: "custom_code",
      config: (r as { config: CustomCodeConfig }).config,
    });
    expect(summary).toBe("Custom code · HTML + JS");
  });
});

// ---------------------------------------------------------------------------
// Shared per-section style + draft/publish validation modes
// ---------------------------------------------------------------------------

describe("validateSectionStyle", () => {
  it("accepts strict colors, padding, width and anchors", () => {
    expect(
      validateSectionStyle({
        background: "#F6F7F9",
        padding_y: "md",
        width: "full",
        anchor: "Our-Story",
      }),
    ).toEqual({
      background: "#F6F7F9",
      padding_y: "md",
      width: "full",
      anchor: "our-story",
    });
    expect(
      validateSectionStyle({ background: "rgba(10, 20, 30, 0.5)" }),
    ).toEqual({ background: "rgba(10, 20, 30, 0.5)" });
  });

  it("rejects CSS-injection backgrounds (inline style attr safety)", () => {
    for (const bad of [
      "url(https://evil.example/x)",
      "red; position: fixed",
      "expression(alert(1))",
      "linear-gradient(#fff, #000)", // not in the strict allowlist
      "#zzz",
    ]) {
      expect(validateSectionStyle({ background: bad }), bad).toBeUndefined();
    }
  });

  it("drops invalid anchors and padding values", () => {
    expect(validateSectionStyle({ anchor: "1-leading-digit" })).toBeUndefined();
    expect(validateSectionStyle({ anchor: "has space" })).toBeUndefined();
    expect(validateSectionStyle({ padding_y: "xl" })).toBeUndefined();
  });

  it("returns undefined for empty/garbage input (key omitted from JSON)", () => {
    expect(validateSectionStyle(undefined)).toBeUndefined();
    expect(validateSectionStyle("nope")).toBeUndefined();
    expect(validateSectionStyle({})).toBeUndefined();
  });
});

describe("draft vs publish validation modes", () => {
  it("draft mode saves incomplete sections that publish mode rejects", () => {
    const incomplete: [string, unknown][] = [
      ["featured_products", { source: "manual", product_ids: [] }],
      ["shop_by_category", { source: "selected", category_ids: [] }],
      ["latest_blogs", { source: "manual", blog_ids: [] }],
      ["rich_text", { html: "" }],
      ["custom_code", { html: "", css: "", js: "" }],
      ["promo_banner", { heading: "", image_url: "" }],
      ["media_text", { heading: "", body: "", image_url: "" }],
      ["gallery", { items: [] }],
      ["testimonials", { items: [] }],
    ];
    for (const [type, raw] of incomplete) {
      expect(
        "error" in validateConfig(type as never, raw, "publish"),
        `${type} publish`,
      ).toBe(true);
      expect(
        "config" in validateConfig(type as never, raw, "draft"),
        `${type} draft`,
      ).toBe(true);
    }
  });

  it("draft mode still enforces SAFETY rules (caps + href scheme)", () => {
    const oversized = validateConfig(
      "custom_code",
      { js: "x".repeat(CODE_MAX_CHARS + 1) },
      "draft",
    );
    expect("error" in oversized).toBe(true);

    const unsafeHref = validateConfig(
      "promo_banner",
      { heading: "Hi", cta_label: "Go", cta_href: "javascript:alert(1)" },
      "draft",
    );
    expect(
      ("config" in unsafeHref &&
        (unsafeHref.config as { cta_href: string }).cta_href) as string,
    ).toBe("");
  });

  it("validateSections passes the mode through and keeps valid style", () => {
    const draftItem = {
      id: "a",
      type: "rich_text",
      enabled: true,
      config: { html: "" }, // incomplete
      style: { background: "#fff", padding_y: "sm" },
    };
    expect("error" in validateSections([draftItem])).toBe(true); // publish
    const r = validateSections([draftItem], { mode: "draft" });
    expect("sections" in r).toBe(true);
    const s = (r as { sections: PageSectionItem[] }).sections[0];
    expect(s.style).toEqual({ background: "#fff", padding_y: "sm" });
  });

  it("validateSections omits the style key entirely when invalid/empty", () => {
    const r = validateSections([
      {
        id: "a",
        type: "rich_text",
        enabled: true,
        config: { html: "<p>x</p>" },
        style: { background: "url(evil)" },
      },
    ]);
    const s = (r as { sections: PageSectionItem[] }).sections[0];
    expect("style" in s).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Page sections array
// ---------------------------------------------------------------------------

function item(overrides: Partial<PageSectionItem> = {}): PageSectionItem {
  return {
    id: crypto.randomUUID(),
    type: "rich_text",
    enabled: true,
    config: { html: "<p>Hello</p>", width: "contained" },
    ...overrides,
  } as PageSectionItem;
}

describe("validateSections", () => {
  it("normalises a valid list", () => {
    const r = validateSections([item(), item({ enabled: false })]);
    expect("sections" in r).toBe(true);
    const sections = (r as { sections: PageSectionItem[] }).sections;
    expect(sections).toHaveLength(2);
    expect(sections[1].enabled).toBe(false);
  });

  it("rejects non-arrays, missing ids, duplicate ids, unknown types", () => {
    expect("error" in validateSections({})).toBe(true);
    expect(
      (validateSections([item({ id: "" })]) as { error: string }).error,
    ).toMatch(/missing id/i);
    const dup = item({ id: "same" });
    expect(
      (validateSections([dup, item({ id: "same" })]) as { error: string })
        .error,
    ).toMatch(/duplicate/i);
    expect(
      (
        validateSections([
          item({ type: "hero_3000" as PageSectionItem["type"] }),
        ]) as { error: string }
      ).error,
    ).toMatch(/unknown section type/i);
  });

  it("surfaces per-section config errors with their position", () => {
    const bad = item({ config: { html: "" } as RichTextConfig });
    const r = validateSections([item(), bad]);
    expect((r as { error: string }).error).toMatch(/^Section 2 \(rich_text\)/);
  });

  it("caps the section count", () => {
    const many = Array.from({ length: MAX_PAGE_SECTIONS + 1 }, () => item());
    expect((validateSections(many) as { error: string }).error).toMatch(
      /at most/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Page slugs
// ---------------------------------------------------------------------------

describe("validatePageSlug", () => {
  it("accepts and normalises good slugs", () => {
    expect(validatePageSlug("About-Us")).toEqual({ slug: "about-us" });
    expect(validatePageSlug("faq-2")).toEqual({ slug: "faq-2" });
  });

  it("rejects bad shapes", () => {
    for (const bad of [
      "",
      "  ",
      "About Us",
      "-lead",
      "trail-",
      "a--b",
      "café",
      "a/b",
    ]) {
      expect("error" in validatePageSlug(bad), bad).toBe(true);
    }
  });

  it("rejects reserved slugs", () => {
    for (const reserved of ["shop", "blogs", "dashboard", "api"]) {
      const r = validatePageSlug(reserved);
      expect("error" in r && r.error, reserved).toMatch(/reserved/i);
    }
  });

  it("rejects overlong slugs", () => {
    expect("error" in validatePageSlug("a".repeat(61))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Drift guard: every real static route under app/(storefront)/(pages)/ must be
// reserved, or a future merchant page with that slug would save fine but never
// render (static routes beat the [pageSlug] dynamic route).
// ---------------------------------------------------------------------------

describe("RESERVED_PAGE_SLUGS drift guard", () => {
  it("reserves every static route directory in (storefront)/(pages)", () => {
    const pagesDir = join(process.cwd(), "app", "(storefront)", "(pages)");
    const routeDirs = readdirSync(pagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      // dynamic segments ([pageSlug]) and route groups are not static slugs
      .filter((name) => !name.startsWith("[") && !name.startsWith("("));
    for (const dir of routeDirs) {
      expect(
        RESERVED_PAGE_SLUGS.has(dir),
        `app/(storefront)/(pages)/${dir} exists but is not in RESERVED_PAGE_SLUGS — a merchant page with this slug would never render. Add it to lib/sections/registry.ts.`,
      ).toBe(true);
    }
  });
});
