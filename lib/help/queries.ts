import { unstable_cache } from "next/cache";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { withAnon } from "@/lib/db/client";
import { helpArticles, helpCategories } from "@/drizzle/schema";
import { TAGS } from "@/lib/storefront/tags";
import {
  toHelpArticle,
  toHelpCard,
  toHelpCategory,
  type HelpArticle,
  type HelpArticleCard,
  type HelpCategory,
} from "@/lib/help/types";

// ---------------------------------------------------------------------------
// Cached PUBLIC help-centre reads (help.storemink.com). All run through the
// anonymous DB scope (withAnon) so RLS returns only published articles, then
// wrap in `unstable_cache` tagged TAGS.help — operator edits call
// revalidateTag(TAGS.help) so changes appear near-instantly; the time-based
// revalidate is just a safety net. Reads tolerate a missing table / transient
// error by returning empty so a cold deploy never crashes the help site.
//
// Platform-global: no store_id anywhere (unlike lib/storefront/queries.ts).
// ---------------------------------------------------------------------------

const REVALIDATE = 300;

const CATEGORY_COLS = {
  id: helpCategories.id,
  slug: helpCategories.slug,
  title: helpCategories.title,
  description: helpCategories.description,
  icon: helpCategories.icon,
  position: helpCategories.position,
};

const CARD_COLS = {
  id: helpArticles.id,
  categoryId: helpArticles.categoryId,
  slug: helpArticles.slug,
  title: helpArticles.title,
  excerpt: helpArticles.excerpt,
  status: helpArticles.status,
  position: helpArticles.position,
  viewCount: helpArticles.viewCount,
  updatedAt: helpArticles.updatedAt,
  publishedAt: helpArticles.publishedAt,
};

const PUBLISHED = eq(helpArticles.status, "published");

/** All categories, ordered for display. */
export const getHelpCategories = unstable_cache(
  async (): Promise<HelpCategory[]> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select(CATEGORY_COLS)
          .from(helpCategories)
          .orderBy(asc(helpCategories.position), asc(helpCategories.title)),
      );
      return rows.map(toHelpCategory);
    } catch {
      return [];
    }
  },
  ["help-categories"],
  { tags: [TAGS.help], revalidate: REVALIDATE },
);

/** Published-article count per category id (home page card counts). */
export const getHelpCategoryCounts = unstable_cache(
  async (): Promise<Record<string, number>> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select({
            categoryId: helpArticles.categoryId,
            count: sql<number>`count(*)::int`,
          })
          .from(helpArticles)
          .where(PUBLISHED)
          .groupBy(helpArticles.categoryId),
      );
      const out: Record<string, number> = {};
      for (const r of rows) if (r.categoryId) out[r.categoryId] = r.count;
      return out;
    } catch {
      return {};
    }
  },
  ["help-category-counts"],
  { tags: [TAGS.help], revalidate: REVALIDATE },
);

export interface HelpNavCategory {
  slug: string;
  title: string;
  articles: { slug: string; title: string }[];
}

/** The full Topics tree — every category with its published articles, ordered.
 *  Powers the left docs sidebar. */
export const getHelpNavTree = unstable_cache(
  async (): Promise<HelpNavCategory[]> => {
    try {
      const [cats, arts] = await Promise.all([
        withAnon((db) =>
          db
            .select(CATEGORY_COLS)
            .from(helpCategories)
            .orderBy(asc(helpCategories.position), asc(helpCategories.title)),
        ),
        withAnon((db) =>
          db
            .select({
              categoryId: helpArticles.categoryId,
              slug: helpArticles.slug,
              title: helpArticles.title,
            })
            .from(helpArticles)
            .where(PUBLISHED)
            .orderBy(asc(helpArticles.position), asc(helpArticles.title)),
        ),
      ]);
      return cats.map((c) => ({
        slug: c.slug,
        title: c.title,
        articles: arts
          .filter((a) => a.categoryId === c.id)
          .map((a) => ({ slug: a.slug, title: a.title })),
      }));
    } catch {
      return [];
    }
  },
  ["help-nav-tree"],
  { tags: [TAGS.help], revalidate: REVALIDATE },
);

/** One category by slug (null if unknown). */
export async function getHelpCategoryBySlug(
  slug: string,
): Promise<HelpCategory | null> {
  const all = await getHelpCategories();
  return all.find((c) => c.slug === slug) ?? null;
}

/** Published article cards in a category, ordered for display. */
export const getHelpArticleCardsByCategory = unstable_cache(
  async (categoryId: string): Promise<HelpArticleCard[]> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select(CARD_COLS)
          .from(helpArticles)
          .where(and(PUBLISHED, eq(helpArticles.categoryId, categoryId)))
          .orderBy(asc(helpArticles.position), asc(helpArticles.title)),
      );
      return rows.map(toHelpCard);
    } catch {
      return [];
    }
  },
  ["help-articles-by-category"],
  { tags: [TAGS.help], revalidate: REVALIDATE },
);

/** A published article by slug, with its full body (null if unknown/draft). */
export const getPublishedHelpArticle = unstable_cache(
  async (slug: string): Promise<HelpArticle | null> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select()
          .from(helpArticles)
          .where(and(PUBLISHED, eq(helpArticles.slug, slug)))
          .limit(1),
      );
      return rows[0] ? toHelpArticle(rows[0]) : null;
    } catch {
      return null;
    }
  },
  ["help-article-by-slug"],
  { tags: [TAGS.help], revalidate: REVALIDATE },
);

/** Most-viewed published articles (home page "Popular" list). */
export const getPopularHelpArticles = unstable_cache(
  async (limit = 6): Promise<HelpArticleCard[]> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select(CARD_COLS)
          .from(helpArticles)
          // See searchHelpArticles: exclude orphaned (category-less) articles so
          // the Popular list never shows an unlinkable card.
          .innerJoin(
            helpCategories,
            eq(helpArticles.categoryId, helpCategories.id),
          )
          .where(PUBLISHED)
          .orderBy(desc(helpArticles.viewCount), desc(helpArticles.publishedAt))
          .limit(limit),
      );
      return rows.map(toHelpCard);
    } catch {
      return [];
    }
  },
  ["help-articles-popular"],
  { tags: [TAGS.help], revalidate: REVALIDATE },
);

/** Other published articles in the same category (article page "Related"). */
export const getRelatedHelpArticles = unstable_cache(
  async (
    categoryId: string,
    excludeId: string,
    limit = 5,
  ): Promise<HelpArticleCard[]> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select(CARD_COLS)
          .from(helpArticles)
          .where(
            and(
              PUBLISHED,
              eq(helpArticles.categoryId, categoryId),
              ne(helpArticles.id, excludeId),
            ),
          )
          .orderBy(asc(helpArticles.position), asc(helpArticles.title))
          .limit(limit),
      );
      return rows.map(toHelpCard);
    } catch {
      return [];
    }
  },
  ["help-articles-related"],
  { tags: [TAGS.help], revalidate: REVALIDATE },
);

/** Every published (categorySlug, slug) pair — for generateStaticParams + sitemap. */
export const getPublishedHelpArticleParams = unstable_cache(
  async (): Promise<
    { categorySlug: string; slug: string; updatedAt: string | null }[]
  > => {
    try {
      const rows = await withAnon((db) =>
        db
          .select({
            slug: helpArticles.slug,
            updatedAt: helpArticles.updatedAt,
            categorySlug: helpCategories.slug,
          })
          .from(helpArticles)
          .innerJoin(
            helpCategories,
            eq(helpArticles.categoryId, helpCategories.id),
          )
          .where(PUBLISHED),
      );
      return rows.map((r) => ({
        categorySlug: r.categorySlug,
        slug: r.slug,
        updatedAt: r.updatedAt,
      }));
    } catch {
      return [];
    }
  },
  ["help-articles-params"],
  { tags: [TAGS.help], revalidate: REVALIDATE },
);

/**
 * Full-text search over published articles. NOT cached — the query string
 * varies per request. Ranks by weighted tsvector match then popularity, and
 * falls back to an ILIKE prefix scan when the query has no lexemes (e.g. a very
 * short term) so the box never feels dead.
 */
export async function searchHelpArticles(
  query: string,
  limit = 20,
): Promise<HelpArticleCard[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const tsq = sql`websearch_to_tsquery('english', ${q})`;
    const rows = await withAnon((db) =>
      db
        .select(CARD_COLS)
        .from(helpArticles)
        // INNER JOIN: only articles with a live category are reachable (a
        // deleted category sets category_id NULL — orphaning the article, which
        // then has no URL). Excluding them here keeps the result count honest
        // and never surfaces an unlinkable hit. Mirrors getPublishedHelpArticleParams.
        .innerJoin(
          helpCategories,
          eq(helpArticles.categoryId, helpCategories.id),
        )
        .where(
          and(
            PUBLISHED,
            sql`(search @@ ${tsq} OR ${helpArticles.title} ILIKE ${"%" + q + "%"})`,
          ),
        )
        .orderBy(
          desc(sql`ts_rank(search, ${tsq})`),
          desc(helpArticles.viewCount),
        )
        .limit(limit),
    );
    return rows.map(toHelpCard);
  } catch {
    return [];
  }
}
