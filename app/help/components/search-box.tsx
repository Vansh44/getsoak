"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  suggestHelpArticles,
  type HelpSuggestion,
} from "@/app/actions/help-actions";

export function HelpSearchBox({
  autoFocus = false,
  initialQuery = "",
  compact = false,
}: {
  autoFocus?: boolean;
  initialQuery?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);
  const [suggestions, setSuggestions] = useState<HelpSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // A results page starts with the submitted query already populated. Do not
  // immediately reopen its autocomplete dropdown over the completed results;
  // suggestions resume as soon as the reader edits the query.
  const [suggestionsEnabled, setSuggestionsEnabled] = useState(
    !initialQuery.trim(),
  );
  const boxRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // Debounced suggestions. All state updates happen inside the timeout (async),
  // never synchronously in the effect body.
  useEffect(() => {
    if (!suggestionsEnabled) return;
    const term = q.trim();
    const id = ++seq.current;
    const t = setTimeout(async () => {
      if (term.length < 2) {
        if (id === seq.current) {
          setSuggestions([]);
          setOpen(false);
        }
        return;
      }
      const res = await suggestHelpArticles(term);
      if (id !== seq.current) return; // ignore out-of-order responses
      setSuggestions(res);
      setOpen(true);
      setActive(-1);
    }, 180);
    return () => clearTimeout(t);
  }, [q, suggestionsEnabled]);

  // Close on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function go(url: string) {
    // Invalidate an autocomplete request that may still be in flight so it
    // cannot reopen the menu while navigation is starting.
    ++seq.current;
    setSuggestionsEnabled(false);
    setOpen(false);
    router.push(url);
  }

  function submit() {
    const term = q.trim();
    if (term) go(`/help/search?q=${encodeURIComponent(term)}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || suggestions.length === 0) {
      if (e.key === "Enter") submit();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) go(suggestions[active].url);
      else submit();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div
      className={`hc-search${compact ? " hc-search-compact" : ""}`}
      ref={boxRef}
    >
      <Search className="icon" size={20} aria-hidden />
      <input
        type="search"
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSuggestionsEnabled(true);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder={
          compact
            ? "Search help or ask a question…"
            : "Ask in any language — payments, domains, products…"
        }
        aria-label="Search the help centre"
        enterKeyHint="search"
      />
      <button type="button" className="hc-search-submit" onClick={submit}>
        Search
      </button>
      {open && (
        <div className="hc-suggest" role="listbox">
          {suggestions.length === 0 ? (
            <div className="s-empty">
              No title match. Select Search for AI-assisted results.
            </div>
          ) : (
            suggestions.map((s, i) => (
              <a
                key={s.url}
                href={s.url}
                data-active={i === active}
                role="option"
                aria-selected={i === active}
                onClick={(e) => {
                  e.preventDefault();
                  go(s.url);
                }}
              >
                <div>{s.title}</div>
                {s.excerpt && <div className="s-excerpt">{s.excerpt}</div>}
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}
