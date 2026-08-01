import { describe, it, expect } from "vitest";
import { plainToHtml, htmlToPlain, policyHasContent } from "./policy-text";
import { STORE_POLICIES, checkoutPolicies } from "./store-policies";

describe("plainToHtml", () => {
  it("turns blank-line-separated prose into paragraphs", () => {
    expect(plainToHtml("One.\n\nTwo.")).toBe("<p>One.</p>\n<p>Two.</p>");
  });

  it("keeps a single newline as a line break inside a paragraph", () => {
    expect(plainToHtml("Line one\nLine two")).toBe(
      "<p>Line one<br />Line two</p>",
    );
  });

  it("escapes markup so a policy can never inject HTML", () => {
    // A merchant typing "<script>" into a textarea must not get a script tag.
    expect(plainToHtml("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("drops empty blocks rather than emitting blank paragraphs", () => {
    expect(plainToHtml("A.\n\n\n\n\nB.")).toBe("<p>A.</p>\n<p>B.</p>");
    expect(plainToHtml("   \n\n  ")).toBe("");
  });
});

describe("htmlToPlain", () => {
  it("round-trips anything the editor itself wrote", () => {
    const cases = [
      "Returns within 7 days.\n\nPerishables excluded.",
      'Email <help@shop.in> for R&D queries "urgent"',
      "Line one\nLine two\n\nNext para",
    ];
    for (const plain of cases) {
      expect(htmlToPlain(plainToHtml(plain))).toBe(plain);
    }
  });

  it("REFUSES content richer than paragraphs", () => {
    // The signal that says "send them to the builder". Without it, opening a
    // page with headings in a textarea and saving would silently destroy them.
    expect(htmlToPlain("<h2>Returns</h2><p>7 days.</p>")).toBeNull();
    expect(htmlToPlain("<ul><li>a</li></ul>")).toBeNull();
    expect(htmlToPlain('<p>See <a href="/x">this</a></p>')).toBeNull();
  });

  it("treats empty as empty, not as rich content", () => {
    // "" must be editable (a policy nobody has written yet); null would send
    // every unwritten policy to the builder instead of showing a textarea.
    expect(htmlToPlain("")).toBe("");
    expect(htmlToPlain("   ")).toBe("");
  });
});

describe("policyHasContent", () => {
  it("sees through empty markup", () => {
    expect(policyHasContent("<p></p>")).toBe(false);
    expect(policyHasContent("<p>  </p>")).toBe(false);
    expect(policyHasContent("<p>Real text</p>")).toBe(true);
    expect(policyHasContent("")).toBe(false);
  });
});

describe("the store policy registry", () => {
  it("has unique kinds and slugs", () => {
    const kinds = STORE_POLICIES.map((p) => p.kind);
    const slugs = STORE_POLICIES.map((p) => p.slug);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("names terms and refunds at checkout, and nothing else", () => {
    // The checkout box binds what money touches. Widening it dilutes the one
    // sentence a shopper might actually read.
    expect(
      checkoutPolicies()
        .map((p) => p.slug)
        .sort(),
    ).toEqual(["refund-policy", "terms"]);
  });

  it("gives every policy prompts, because nobody can fill in a blank box", () => {
    for (const policy of STORE_POLICIES) {
      expect(policy.prompts.length, policy.kind).toBeGreaterThan(0);
    }
  });
});
