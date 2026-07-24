// Help Centre domain types + row mappers. Pure (no I/O), shared by the public
// read layer (lib/help/queries.ts), the operator actions (app/actions/help-actions.ts)
// and the routes. The help centre is platform-global — no store_id anywhere.

export type HelpStatus = "draft" | "published";

export interface HelpCategory {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  icon: string | null;
  position: number;
}

/** List/card shape — everything except the heavy HTML body. */
export interface HelpArticleCard {
  id: string;
  categoryId: string | null;
  slug: string;
  title: string;
  excerpt: string | null;
  status: HelpStatus;
  position: number;
  viewCount: number;
  updatedAt: string | null;
  publishedAt: string | null;
}

/** Full article, including the rendered body. */
export interface HelpArticle extends HelpArticleCard {
  body: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  helpfulYes: number;
  helpfulNo: number;
  createdAt: string | null;
}

// Drizzle row → domain shapes. Kept explicit so a schema change surfaces here.

type CategoryRow = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  icon: string | null;
  position: number;
};

export function toHelpCategory(r: CategoryRow): HelpCategory {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    icon: r.icon,
    position: r.position,
  };
}

type ArticleRow = {
  id: string;
  categoryId: string | null;
  slug: string;
  title: string;
  excerpt: string | null;
  body?: string | null;
  status: string;
  position: number;
  viewCount: number;
  helpfulYes?: number;
  helpfulNo?: number;
  seoTitle?: string | null;
  seoDescription?: string | null;
  createdAt?: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
};

export function toHelpCard(r: ArticleRow): HelpArticleCard {
  return {
    id: r.id,
    categoryId: r.categoryId,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    status: r.status === "published" ? "published" : "draft",
    position: r.position,
    viewCount: r.viewCount,
    updatedAt: r.updatedAt,
    publishedAt: r.publishedAt,
  };
}

export function toHelpArticle(r: ArticleRow): HelpArticle {
  return {
    ...toHelpCard(r),
    body: r.body ?? null,
    seoTitle: r.seoTitle ?? null,
    seoDescription: r.seoDescription ?? null,
    helpfulYes: r.helpfulYes ?? 0,
    helpfulNo: r.helpfulNo ?? 0,
    createdAt: r.createdAt ?? null,
  };
}
