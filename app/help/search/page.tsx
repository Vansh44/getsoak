import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getHelpCategories, searchHelpArticles } from "@/lib/help/queries";
import { HelpSearchBox } from "../components/search-box";

// Search results are query-dependent and not worth indexing.
export const metadata: Metadata = {
  title: "Search",
  robots: { index: false, follow: true },
};

export default async function HelpSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const query = q.trim();
  const [results, categories] = await Promise.all([
    query ? searchHelpArticles(query, 30) : Promise.resolve([]),
    getHelpCategories(),
  ]);
  const catById = new Map(categories.map((c) => [c.id, c.slug]));

  return (
    <>
      <section className="hc-hero">
        <div className="hc-wrap">
          <span className="kicker">Help Centre</span>
          <h1>Search</h1>
          <HelpSearchBox autoFocus initialQuery={query} />
        </div>
      </section>

      <main className="hc-main">
        <div className="hc-wrap">
          {!query ? (
            <div className="hc-empty">Type something to search the docs.</div>
          ) : results.length === 0 ? (
            <div className="hc-empty">
              No results for “{query}”. Try different words, or email{" "}
              <a href="mailto:support@storemink.com">support@storemink.com</a>.
            </div>
          ) : (
            <>
              <h2 className="hc-section-title">
                {results.length} {results.length === 1 ? "result" : "results"}{" "}
                for “{query}”
              </h2>
              <div className="hc-list">
                {results.map((a) => {
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
