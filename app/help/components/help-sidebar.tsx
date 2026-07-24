"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { HelpNavCategory } from "@/lib/help/queries";

// Left "Topics" tree for the docs layout. Categories collapse/expand; the
// active category is open by default and the active article is highlighted.
export function HelpSidebar({
  tree,
  activeCategory,
  activeSlug,
}: {
  tree: HelpNavCategory[];
  activeCategory?: string;
  activeSlug?: string;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(tree.map((c) => [c.slug, c.slug === activeCategory])),
  );

  return (
    <nav className="hc-topics" aria-label="Help topics">
      <div className="hc-topics-title">Topics</div>
      <ul>
        {tree.map((c) => {
          const hasArticles = c.articles.length > 0;
          const isOpen = open[c.slug];
          const isActiveCat = c.slug === activeCategory;
          return (
            <li key={c.slug}>
              <div className={`hc-topics-cat${isActiveCat ? " active" : ""}`}>
                {hasArticles ? (
                  <button
                    type="button"
                    className={`hc-topics-toggle${isOpen ? " open" : ""}`}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "Collapse" : "Expand"}
                    onClick={() =>
                      setOpen((o) => ({ ...o, [c.slug]: !o[c.slug] }))
                    }
                  >
                    <ChevronRight size={15} />
                  </button>
                ) : (
                  <span className="hc-topics-spacer" />
                )}
                <Link href={`/help/${c.slug}`}>{c.title}</Link>
              </div>
              {hasArticles && isOpen && (
                <ul className="hc-topics-articles">
                  {c.articles.map((a) => (
                    <li key={a.slug}>
                      <Link
                        href={`/help/${c.slug}/${a.slug}`}
                        className={
                          isActiveCat && a.slug === activeSlug ? "active" : ""
                        }
                      >
                        {a.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
