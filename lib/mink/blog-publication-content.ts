import "server-only";

import { sanitizeBlogContent } from "@/lib/sanitize";

const MAX_PARAGRAPHS = 500;

/**
 * Render Mink's deliberately small Markdown subset into blog HTML.
 *
 * Raw HTML is escaped first. The generated markup is then passed through the
 * same sanitizer used by every other blog write and again by the storefront,
 * giving the model no path to scripts, event handlers, data URLs or arbitrary
 * attributes. Links are intentionally left as escaped text in Phase 5D; an AI
 * draft must not smuggle an unreviewed external destination into a live post.
 */
export function renderMinkBlogMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    blocks.push(
      `<${tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`,
    );
    list = null;
  };

  for (const rawLine of lines.slice(0, MAX_PARAGRAPHS)) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const ordered = line.match(/^\d{1,3}[.)]\s+(.+)$/);
    const unordered = line.match(/^[-*+]\s+(.+)$/);
    if (ordered || unordered) {
      const nextOrdered = Boolean(ordered);
      if (list && list.ordered !== nextOrdered) flushList();
      list ??= { ordered: nextOrdered, items: [] };
      list.items.push(inline(ordered?.[1] ?? unordered![1]));
      continue;
    }
    flushList();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^>\s+/.test(line)) {
      blocks.push(
        `<blockquote><p>${inline(line.replace(/^>\s+/, ""))}</p></blockquote>`,
      );
      continue;
    }
    blocks.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  return sanitizeBlogContent(blocks.join("\n"));
}

export function minkBlogReadingTime(html: string): number {
  const words = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`\n]{1,200})`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]{1,500})\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]{1,500})__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]{1,500})\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_([^_\n]{1,500})_(?!_)/g, "<em>$1</em>");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
