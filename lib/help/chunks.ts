import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";

export const HELP_CHUNK_TARGET_CHARS = 1_400;
export const HELP_CHUNK_MAX_CHARS = 1_900;
// Bump this whenever parsing, metadata, or chunk-boundary semantics change.
// The durable worker includes it in reconciliation, so an unchanged article is
// still rebuilt after a chunker release instead of keeping structurally stale
// vectors forever.
export const HELP_CHUNK_INDEX_VERSION = 1;

const HELP_CHUNK_METADATA_MAX_CHARS = 500;

export interface HelpChunkSource {
  title: string;
  excerpt: string | null;
  categoryTitle: string;
  body: string | null;
}

export interface HelpArticleChunkDraft {
  chunkIndex: number;
  heading: string | null;
  headingAnchor: string | null;
  headingLevel: number | null;
  content: string;
  tokenCount: number;
  contentHash: string;
  embeddingText: string;
}

interface Section {
  heading: string | null;
  headingLevel: number | null;
  paragraphs: string[];
}

function plainText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyHeading(value: string): string | null {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return slug || null;
}

function articleSections(body: string | null): Section[] {
  if (!body?.trim()) return [];
  const marked = body
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level: string, inner: string) =>
        `\n\n__SM_HELP_HEADING_${level}__${plainText(inner)}\n\n`,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|li|ol|ul|blockquote|pre|table|tr)>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " · ");

  const text = sanitizeHtml(marked, {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return [];

  const sections: Section[] = [
    { heading: null, headingLevel: null, paragraphs: [] },
  ];
  let current = sections[0];
  for (const block of text.split(/\n{2,}/)) {
    const value = block.replace(/\s+/g, " ").trim();
    if (!value) continue;
    const heading = value.match(/^__SM_HELP_HEADING_([1-6])__(.+)$/);
    if (heading) {
      current = {
        heading: heading[2].trim().slice(0, 300) || null,
        headingLevel: Number(heading[1]),
        paragraphs: [],
      };
      sections.push(current);
      continue;
    }
    current.paragraphs.push(value);
  }
  return sections.filter((section) => section.paragraphs.length > 0);
}

function splitLongText(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value];
  const sentences = value.split(/(?<=[.!?])\s+(?=[\p{L}\p{N}])/u);
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) parts.push(current);
      current = "";
      for (let start = 0; start < sentence.length; start += maxChars) {
        parts.push(sentence.slice(start, start + maxChars).trim());
      }
      continue;
    }
    if (current && current.length + sentence.length + 1 > maxChars) {
      parts.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) parts.push(current);
  return parts.filter(Boolean);
}

function sectionChunks(section: Section): string[] {
  const result: string[] = [];
  let current = "";
  for (const paragraph of section.paragraphs.flatMap((value) =>
    splitLongText(value, HELP_CHUNK_MAX_CHARS),
  )) {
    if (
      current &&
      (current.length >= HELP_CHUNK_TARGET_CHARS ||
        current.length + paragraph.length + 2 > HELP_CHUNK_MAX_CHARS)
    ) {
      result.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) result.push(current);
  return result;
}

function approximateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedMetadata(value: string | null, max: number): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Turn a published Help article into small, section-aware retrieval units.
 * Metadata is included in the embedding input but not duplicated in `content`,
 * so answer generation receives concise source text rather than search labels.
 */
export function buildHelpArticleChunks(
  source: HelpChunkSource,
): HelpArticleChunkDraft[] {
  const articleTitle =
    boundedMetadata(source.title, HELP_CHUNK_METADATA_MAX_CHARS) ||
    "StoreMink Help Centre";
  const categoryTitle = boundedMetadata(
    source.categoryTitle,
    HELP_CHUNK_METADATA_MAX_CHARS,
  );
  const excerpt = boundedMetadata(
    source.excerpt,
    HELP_CHUNK_METADATA_MAX_CHARS,
  );
  const sections = articleSections(source.body);
  if (sections.length === 0) {
    // A published title is useful retrieval evidence even before the operator
    // has written a body. Persist one deterministic chunk so the reconciler can
    // mark the revision complete instead of selecting the same empty article on
    // every cron heartbeat.
    const fallback = [
      articleTitle,
      categoryTitle ? `Category: ${categoryTitle}` : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n");
    sections.push({
      heading: null,
      headingLevel: null,
      paragraphs: [excerpt || fallback],
    });
  }

  const drafts: HelpArticleChunkDraft[] = [];
  for (const section of sections) {
    for (const content of sectionChunks(section)) {
      const metadata = [
        "StoreMink Help Centre",
        categoryTitle ? `Category: ${categoryTitle}` : null,
        `Article: ${articleTitle}`,
        section.heading ? `Section: ${section.heading}` : null,
        excerpt ? `Summary: ${excerpt}` : null,
      ].filter((value): value is string => Boolean(value));
      const embeddingText = `${metadata.join("\n")}\n\n${content}`;
      drafts.push({
        chunkIndex: drafts.length,
        heading: section.heading,
        headingAnchor: section.heading ? slugifyHeading(section.heading) : null,
        headingLevel: section.headingLevel,
        content,
        tokenCount: approximateTokens(embeddingText),
        contentHash: sha256(embeddingText),
        embeddingText,
      });
    }
  }
  return drafts;
}
