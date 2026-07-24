import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { JsonLd } from "@/app/(storefront)/components/json-ld";
import { breadcrumbSchema, helpArticleSchema } from "@/lib/seo/schema";
import { sanitizeBlogContent } from "@/lib/sanitize";
import { slugify } from "@/lib/slug";
import { HELP_URL, PLATFORM_URL } from "@/lib/site";
import {
  getHelpCategories,
  getHelpNavTree,
  getPublishedHelpArticle,
  getRelatedHelpArticles,
} from "@/lib/help/queries";
import { getHelpArticlePreview } from "@/lib/help/preview";
import { FeedbackWidget } from "../../components/feedback-widget";
import { HelpSidebar } from "../../components/help-sidebar";

// Published reads are cached (unstable_cache, tag TAGS.help) so the page is
// fast and fully crawlable via SSR; the segment stays dynamic so ?preview=1
// can serve operator-only draft content (uncached). No generateStaticParams —
// the sitemap lists articles independently.
export const revalidate = 300;

type Props = {
  params: Promise<{ category: string; slug: string }>;
  searchParams: Promise<{ preview?: string }>;
};

const isPreview = (sp: { preview?: string }) => sp.preview === "1";

export async function generateMetadata({
  params,
  searchParams,
}: Props): Promise<Metadata> {
  const [{ category, slug }, sp] = await Promise.all([params, searchParams]);

  // Draft preview is always noindex with minimal metadata.
  if (isPreview(sp)) {
    const draft = await getHelpArticlePreview(slug);
    if (draft) {
      return {
        title: `${draft.title} (preview)`,
        robots: { index: false, follow: false },
      };
    }
  }

  const article = await getPublishedHelpArticle(slug);
  if (!article) return { title: "Not found" };
  const description = article.seoDescription || article.excerpt || undefined;
  const canonical = `/help/${category}/${article.slug}`;
  return {
    title: article.seoTitle || article.title,
    description,
    alternates: { canonical },
    openGraph: {
      title: `${article.title} | StoreMink Help`,
      description,
      url: canonical,
      type: "article",
      ...(article.publishedAt ? { publishedTime: article.publishedAt } : {}),
      ...(article.updatedAt ? { modifiedTime: article.updatedAt } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: article.title,
      description,
    },
  };
}

// Inject stable ids into h2/h3 headings and collect a table of contents. Pure
// string work (no DOM) — the body is already sanitized HTML.
function buildToc(html: string): {
  html: string;
  toc: { id: string; text: string; level: 2 | 3 }[];
} {
  const toc: { id: string; text: string; level: 2 | 3 }[] = [];
  const used = new Set<string>();
  const withIds = html.replace(
    /<(h2|h3)([^>]*)>([\s\S]*?)<\/\1>/gi,
    (m, tag: string, attrs: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      if (!text) return m;
      let id = slugify(text) || "section";
      const base = id;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      used.add(id);
      toc.push({ id, text, level: tag.toLowerCase() === "h2" ? 2 : 3 });
      const hasId = /\sid=/i.test(attrs);
      return `<${tag}${attrs}${hasId ? "" : ` id="${id}"`}>${inner}</${tag}>`;
    },
  );
  return { html: withIds, toc };
}

export default async function HelpArticlePage({ params, searchParams }: Props) {
  const [{ category, slug }, sp] = await Promise.all([params, searchParams]);

  // ?preview=1 → operator-only draft view (uncached). Non-operators get null
  // and fall through to the published article (or 404), so the URL leaks
  // nothing.
  const preview = isPreview(sp);
  const draft = preview ? await getHelpArticlePreview(slug) : null;
  const isDraftPreview = Boolean(draft);
  const article = draft ?? (await getPublishedHelpArticle(slug));
  if (!article) notFound();

  const categories = await getHelpCategories();
  const cat = article.categoryId
    ? categories.find((c) => c.id === article.categoryId)
    : undefined;

  // Redirect to the canonical category path if the URL's category is wrong
  // (moved article, guessed URL) — one article, one indexable URL. Skipped in
  // preview so a draft's transient/placeholder category never bounces.
  if (!isDraftPreview && cat && cat.slug !== category) {
    redirect(`/help/${cat.slug}/${article.slug}`);
  }

  const [related, navTree] = await Promise.all([
    article.categoryId && !isDraftPreview
      ? getRelatedHelpArticles(article.categoryId, article.id, 5)
      : Promise.resolve([]),
    getHelpNavTree(),
  ]);

  const { html, toc } = buildToc(sanitizeBlogContent(article.body ?? ""));
  const hasToc = toc.length > 1;

  const canonicalPath = `/help/${cat?.slug ?? category}/${article.slug}`;
  // Structured data is for the public/indexed page only — skip it (and the
  // feedback widget) in the noindex operator preview.
  const articleLd = helpArticleSchema({
    siteUrl: HELP_URL,
    path: canonicalPath,
    title: article.title,
    description: article.seoDescription || article.excerpt,
    publishedAt: article.publishedAt,
    updatedAt: article.updatedAt,
    publisherName: "StoreMink",
    logoUrl: `${PLATFORM_URL}/icon.svg`,
  });
  const breadcrumbLd = breadcrumbSchema(HELP_URL, [
    { name: "Help Centre", path: "/help" },
    ...(cat ? [{ name: cat.title, path: `/help/${cat.slug}` }] : []),
    { name: article.title, path: canonicalPath },
  ]);

  return (
    <main className="hc-main">
      <div className={`hc-docs${hasToc ? "" : " no-toc"}`}>
        {/* Left: Topics tree */}
        <aside className="hc-docs-left">
          <HelpSidebar
            tree={navTree}
            activeCategory={cat?.slug}
            activeSlug={article.slug}
          />
        </aside>

        {/* Middle: article content */}
        <div className="hc-article">
          {isDraftPreview ? (
            <div className="hc-preview-bar" role="status">
              <span className="dot" aria-hidden />
              <span>
                Draft preview — <b className="cap">{article.status}</b>. Only
                operators can see this; it isn&apos;t public or indexed.
              </span>
            </div>
          ) : (
            <JsonLd data={[articleLd, breadcrumbLd]} />
          )}

          <nav className="hc-crumbs" aria-label="Breadcrumb">
            <Link href="/help">Help Centre</Link>
            {cat && (
              <>
                <span className="sep">/</span>
                <Link href={`/help/${cat.slug}`}>{cat.title}</Link>
              </>
            )}
            <span className="sep">/</span>
            <span>{article.title}</span>
          </nav>

          <article>
            <h1>{article.title}</h1>
            {article.excerpt && <p className="lede">{article.excerpt}</p>}
            <div
              className="hc-body"
              // Sanitized on write AND here (defense-in-depth), matching blogs.
              dangerouslySetInnerHTML={{ __html: html }}
            />

            {!isDraftPreview && <FeedbackWidget articleId={article.id} />}

            {related.length > 0 && cat && (
              <section className="hc-related">
                <h2 className="hc-section-title">Related articles</h2>
                <div className="hc-list">
                  {related.map((a) => (
                    <Link href={`/help/${cat.slug}/${a.slug}`} key={a.id}>
                      <div className="a-title">{a.title}</div>
                      <ChevronRight className="chev" size={18} />
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </article>
        </div>

        {/* Right: on-this-page TOC */}
        {hasToc && (
          <aside className="hc-toc" aria-label="On this page">
            <div className="label">On this page</div>
            <nav>
              {toc.map((h) => (
                <a key={h.id} href={`#${h.id}`} className={`lvl-${h.level}`}>
                  {h.text}
                </a>
              ))}
            </nav>
          </aside>
        )}
      </div>
    </main>
  );
}
