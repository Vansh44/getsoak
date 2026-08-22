import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, Sparkles } from "lucide-react";
import { searchPublishedHelpWithAi } from "@/app/actions/help-actions";
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
  const search = query
    ? await searchPublishedHelpWithAi(query)
    : { results: [], mode: "keyword" as const };
  const { results } = search;

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
              {search.mode === "ai" && (
                <div className="hc-ai-grounding" role="status">
                  <Sparkles size={16} aria-hidden />
                  AI interpreted your question. Every result below is a real,
                  published StoreMink guide.
                </div>
              )}
              <div className="hc-list">
                {results.map((result) => (
                  <Link href={result.url} key={result.url}>
                    <div>
                      <div className="a-title">{result.title}</div>
                      {result.excerpt && (
                        <div className="a-excerpt">{result.excerpt}</div>
                      )}
                    </div>
                    <ChevronRight className="chev" size={18} />
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
