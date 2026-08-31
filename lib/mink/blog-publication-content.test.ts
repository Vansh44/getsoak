import { describe, expect, it } from "vitest";
import {
  minkBlogReadingTime,
  renderMinkBlogMarkdown,
} from "./blog-publication-content";

describe("Mink blog publication content", () => {
  it("renders a bounded useful Markdown subset", () => {
    const html = renderMinkBlogMarkdown(
      "# Heading\n\nA **clear** paragraph.\n\n- First\n- Second",
    );
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<strong>clear</strong>");
    expect(html).toContain("<ul><li>First</li><li>Second</li></ul>");
  });

  it("escapes raw HTML and does not activate Markdown links", () => {
    const html = renderMinkBlogMarkdown(
      "<img src=x onerror=alert(1)> [Sign in](https://evil.example)",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(html).toContain("&lt;img");
    expect(html).toContain("[Sign in](https://evil.example)");
  });

  it("calculates a minimum one-minute reading time", () => {
    expect(minkBlogReadingTime("<p>Short post</p>")).toBe(1);
    expect(minkBlogReadingTime(`<p>${"word ".repeat(401)}</p>`)).toBe(3);
  });
});
