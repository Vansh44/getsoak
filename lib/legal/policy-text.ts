// ---------------------------------------------------------------------------
// Plain text ⇄ simple HTML, for the Settings → Policies editor.
//
// A merchant writing a refund policy should type prose, not markup. So the
// editor is a textarea: paragraphs in, <p> blocks out.
//
// THE ONE RULE: never silently flatten something we didn't write. The same
// page can be opened in the website builder, where a merchant may add
// headings, lists or links. Loading that into a plain textarea and saving
// would destroy it without warning, so `htmlToPlain` returns null for anything
// richer than paragraphs and the editor sends them to the builder instead.
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

function unescapeHtml(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" doesn't become "<"
}

/** Blank-line-separated prose → escaped <p> blocks. */
export function plainToHtml(text: string): string {
  return (text ?? "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`)
    .join("\n");
}

/**
 * The inverse — but ONLY for content this editor could have produced.
 *
 * Returns null when the HTML contains anything beyond paragraphs and line
 * breaks, which is the signal to hand the merchant to the builder rather than
 * quietly destroying their headings and lists.
 */
export function htmlToPlain(html: string): string | null {
  const source = (html ?? "").trim();
  if (!source) return "";

  // Any tag that isn't <p>, </p> or <br> means this came from somewhere else.
  const tags = source.match(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g) ?? [];
  for (const tag of tags) {
    const name = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (name !== "p" && name !== "br") return null;
  }

  return unescapeHtml(
    source
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<\/?p[^>]*>/gi, ""),
  ).trim();
}

/** Is there anything a shopper could actually read? */
export function policyHasContent(html: string): boolean {
  return (html ?? "").replace(/<[^>]*>/g, "").trim().length > 0;
}

// --- Section ids ----------------------------------------------------------
// A policy page is TWO sections: a heading the storefront renders as the <h1>,
// and the merchant's text. They must be separate — folding the heading into
// the body would put an <h1> in front of htmlToPlain, which refuses anything
// richer than paragraphs, so every policy would be sent to the builder and
// become uneditable here.

export const POLICY_HEADING_SECTION_ID = "policy-heading";
export const POLICY_BODY_SECTION_ID = "policy-body";

/**
 * The merchant's text out of a policy page, BY SECTION ID.
 *
 * Never "the first rich_text section" — that is the heading, and a reader
 * taking it would show the editor an <h1> and hash the title instead of the
 * policy. Two modules independently made that assumption; this is the one
 * place that knows.
 */
export function policyBodyHtml(sections: unknown): string {
  if (!Array.isArray(sections)) return "";
  for (const section of sections) {
    const s = section as { id?: string; config?: { html?: string } };
    if (
      s?.id === POLICY_BODY_SECTION_ID &&
      typeof s.config?.html === "string"
    ) {
      return s.config.html;
    }
  }
  // Written before headings existed: one unnamed rich_text section.
  for (const section of sections) {
    const s = section as { type?: string; config?: { html?: string } };
    if (s?.type === "rich_text" && typeof s.config?.html === "string") {
      return s.config.html;
    }
  }
  return "";
}
