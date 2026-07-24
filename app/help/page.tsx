import Link from "next/link";
import { ChevronRight } from "lucide-react";
import {
  getHelpCategories,
  getHelpCategoryCounts,
  getPopularHelpArticles,
} from "@/lib/help/queries";
import { HelpSearchBox } from "./components/search-box";
import { CategoryIcon } from "./components/category-icon";

// Static + ISR: the help home is public and cache-friendly. Operator edits
// bust TAGS.help; this bounds staleness otherwise.
export const revalidate = 300;

export default async function HelpHome() {
  const [categories, counts, popular] = await Promise.all([
    getHelpCategories(),
    getHelpCategoryCounts(),
    getPopularHelpArticles(6),
  ]);

  // Map article id → its /help/{category}/{slug} path for the popular list.
  const catById = new Map(categories.map((c) => [c.id, c.slug]));

  return (
    <>
      <section className="hc-hero">
        <div className="hc-wrap">
          <span className="kicker">Help Centre</span>
          <h1>How can we help?</h1>
          <HelpSearchBox />
        </div>
      </section>

      <main className="hc-main">
        <div className="hc-wrap">
          <h2 className="hc-section-title">Browse by topic</h2>
          {categories.length === 0 ? (
            <div className="hc-empty">
              Articles are on their way. Meanwhile, email{" "}
              <a href="mailto:support@storemink.com">support@storemink.com</a>.
            </div>
          ) : (
            <div className="hc-grid">
              {categories.map((c) => (
                <Link href={`/help/${c.slug}`} className="hc-card" key={c.id}>
                  <div className="ic">
                    <CategoryIcon name={c.icon} />
                  </div>
                  <h3>{c.title}</h3>
                  {c.description && <p>{c.description}</p>}
                  <span className="count">
                    {counts[c.id] ?? 0}{" "}
                    {(counts[c.id] ?? 0) === 1 ? "article" : "articles"}
                  </span>
                </Link>
              ))}
            </div>
          )}

          {popular.length > 0 && (
            <>
              <h2 className="hc-section-title" style={{ marginTop: 48 }}>
                Popular articles
              </h2>
              <div className="hc-list">
                {popular.map((a) => {
                  const catSlug = a.categoryId
                    ? catById.get(a.categoryId)
                    : undefined;
                  if (!catSlug) return null;
                  return (
                    <Link href={`/help/${catSlug}/${a.slug}`} key={a.id}>
                      <div>
                        <div className="a-title">{a.title}</div>
                        {a.excerpt && (
                          <div className="a-excerpt">{a.excerpt}</div>
                        )}
                      </div>
                      <ChevronRight className="chev" size={18} />
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
