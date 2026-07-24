import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { JsonLd } from "@/app/(storefront)/components/json-ld";
import { breadcrumbSchema } from "@/lib/seo/schema";
import { HELP_URL } from "@/lib/site";
import {
  getHelpCategories,
  getHelpCategoryBySlug,
  getHelpArticleCardsByCategory,
  getHelpNavTree,
} from "@/lib/help/queries";
import { CategoryIcon } from "../components/category-icon";
import { HelpSidebar } from "../components/help-sidebar";

export const revalidate = 300;
export const dynamicParams = true;

export async function generateStaticParams() {
  const cats = await getHelpCategories();
  return cats.map((c) => ({ category: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category } = await params;
  const cat = await getHelpCategoryBySlug(category);
  if (!cat) return { title: "Not found" };
  return {
    title: cat.title,
    description: cat.description ?? undefined,
    alternates: { canonical: `/help/${cat.slug}` },
    openGraph: {
      title: `${cat.title} | StoreMink Help`,
      description: cat.description ?? undefined,
      url: `/help/${cat.slug}`,
      type: "website",
    },
  };
}

export default async function HelpCategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  const cat = await getHelpCategoryBySlug(category);
  if (!cat) notFound();

  const [articles, navTree] = await Promise.all([
    getHelpArticleCardsByCategory(cat.id),
    getHelpNavTree(),
  ]);

  const breadcrumbLd = breadcrumbSchema(HELP_URL, [
    { name: "Help Centre", path: "/help" },
    { name: cat.title, path: `/help/${cat.slug}` },
  ]);

  return (
    <main className="hc-main">
      <div className="hc-docs no-toc">
        {/* Left: Topics tree */}
        <aside className="hc-docs-left">
          <HelpSidebar tree={navTree} activeCategory={cat.slug} />
        </aside>

        {/* Middle: category + its articles */}
        <div className="hc-article">
          <JsonLd data={breadcrumbLd} />

          <nav className="hc-crumbs" aria-label="Breadcrumb">
            <Link href="/help">Help Centre</Link>
            <span className="sep">/</span>
            <span>{cat.title}</span>
          </nav>

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div className="ic" style={{ marginBottom: 0 }}>
              <CategoryIcon name={cat.icon} />
            </div>
            <div>
              <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>
                {cat.title}
              </h1>
              {cat.description && (
                <p style={{ color: "var(--hc-ink-soft)", margin: "4px 0 0" }}>
                  {cat.description}
                </p>
              )}
            </div>
          </div>

          <div style={{ marginTop: 28 }}>
            {articles.length === 0 ? (
              <div className="hc-empty">No articles here yet.</div>
            ) : (
              <div className="hc-list">
                {articles.map((a) => (
                  <Link href={`/help/${cat.slug}/${a.slug}`} key={a.id}>
                    <div>
                      <div className="a-title">{a.title}</div>
                      {a.excerpt && (
                        <div className="a-excerpt">{a.excerpt}</div>
                      )}
                    </div>
                    <ChevronRight className="chev" size={18} />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
