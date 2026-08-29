"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowRight, Search, Store, Menu, X } from "lucide-react";
import { TopbarProfile, formatRole } from "./topbar-profile";
import { useMobileNav } from "./dashboard-mobile-nav";
import { useChat } from "./chat-context";
import { NotificationBell } from "./components/notification-bell";
import { LocationTag } from "./location-tag";
import { MinkMark } from "./mink-mark";

// Plan pill styling on the dark topbar — neutral for free, brand-tinted as the
// plan climbs, mirroring the console's plan colours.
const PLAN_PILL: Record<string, string> = {
  free: "bg-white/10 text-[#d1d5db]",
  basic: "bg-sky-400/20 text-sky-200",
  pro: "bg-[#7F4AFA]/25 text-[#c9b8fb]",
};

export interface DashboardSearchGroup {
  group: string;
  items: {
    label: string;
    href: string;
    openInNewTab?: boolean;
    children?: { label: string; href: string }[];
  }[];
}

interface DashboardSearchItem {
  label: string;
  href: string;
  context: string;
  openInNewTab: boolean;
  searchText: string;
}

/**
 * Flatten the ALREADY permission-filtered sidebar into one command list.
 *
 * Parent landing links often repeat as their first child (Customers / All
 * customers, POS / Overview). Keep one visible result per href while retaining
 * every duplicate label as a search alias.
 */
function searchItemsFor(groups: DashboardSearchGroup[]): DashboardSearchItem[] {
  const byHref = new Map<string, DashboardSearchItem>();

  const add = (input: {
    label: string;
    href: string;
    context: string;
    openInNewTab?: boolean;
  }) => {
    const alias =
      `${input.label} ${input.context} ${input.href.replaceAll("/", " ")}`.toLocaleLowerCase();
    const existing = byHref.get(input.href);
    if (existing) {
      existing.searchText += ` ${alias}`;
      return;
    }
    byHref.set(input.href, {
      label: input.label,
      href: input.href,
      context: input.context,
      openInNewTab: input.openInNewTab === true,
      searchText: alias,
    });
  };

  for (const group of groups) {
    for (const item of group.items) {
      add({
        label: item.label,
        href: item.href,
        context: group.group,
        openInNewTab: item.openInNewTab,
      });
      for (const child of item.children ?? []) {
        add({
          label: child.label,
          href: child.href,
          context: `${item.label} · ${group.group}`,
        });
      }
    }
  }

  return [...byHref.values()];
}

export function DashboardTopbar({
  email,
  role,
  firstName,
  lastName,
  storeName,
  planId,
  planName,
  scopedLocations = [],
  searchGroups = [],
}: {
  email: string;
  role: string;
  firstName?: string | null;
  lastName?: string | null;
  // Store context (store dashboards only). Absent on the platform operator
  // console, which manages every store rather than one.
  storeName?: string;
  planId?: string;
  planName?: string;
  /** The shops this viewer is restricted to. EMPTY = unrestricted, and the tag
   *  renders nothing — the platform console passes nothing at all. */
  scopedLocations?: { id: string; name: string }[];
  /** The same permission-filtered navigation rendered by the sidebar. Search
   *  can therefore never reveal a destination hidden from this viewer. */
  searchGroups?: DashboardSearchGroup[];
}) {
  const router = useRouter();
  const { setOpen } = useMobileNav();
  const { isChatOpen, toggleChat } = useChat();
  const planPill = PLAN_PILL[planId ?? "free"] ?? PLAN_PILL.free;
  const desktopSearchRef = useRef<HTMLDivElement>(null);
  const mobileSearchRef = useRef<HTMLDivElement>(null);
  const desktopInputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeResult, setActiveResult] = useState(0);

  const allSearchItems = useMemo(
    () => searchItemsFor(searchGroups),
    [searchGroups],
  );
  const searchResults = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return allSearchItems;
    return allSearchItems
      .filter((item) => words.every((word) => item.searchText.includes(word)))
      .sort((a, b) => {
        const aStarts = a.label.toLocaleLowerCase().startsWith(words[0]);
        const bStarts = b.label.toLocaleLowerCase().startsWith(words[0]);
        return Number(bStarts) - Number(aStarts);
      });
  }, [allSearchItems, query]);

  const openSearch = () => {
    setSearchOpen(true);
    setActiveResult(0);
    requestAnimationFrame(() => {
      const mobile = window.innerWidth < 768;
      (mobile ? mobileInputRef : desktopInputRef).current?.focus();
    });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setActiveResult(0);
  };

  const chooseResult = (item: DashboardSearchItem) => {
    closeSearch();
    setQuery("");
    if (item.openInNewTab) {
      window.open(item.href, "_blank", "noopener,noreferrer");
      return;
    }
    // href comes exclusively from the server-owned navigation registry, never
    // from the query or another untrusted string.
    router.push(item.href);
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const item = searchResults[activeResult] ?? searchResults[0];
    if (item) chooseResult(item);
  };

  const searchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResult((current) =>
        Math.min(current + 1, Math.max(0, searchResults.length - 1)),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResult((current) => Math.max(0, current - 1));
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      } else if (event.key === "Escape" && searchOpen) {
        closeSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !desktopSearchRef.current?.contains(target) &&
        !mobileSearchRef.current?.contains(target)
      ) {
        closeSearch();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [searchOpen]);

  const resultList = (listId: string) => (
    <div
      id={listId}
      role="listbox"
      aria-label="Dashboard pages"
      className="max-h-[min(360px,60vh)] overflow-y-auto p-1.5"
    >
      {searchResults.length > 0 ? (
        searchResults.map((item, index) => (
          <button
            key={item.href}
            id={`${listId}-${index}`}
            type="button"
            role="option"
            aria-selected={index === activeResult}
            onMouseEnter={() => setActiveResult(index)}
            onClick={() => chooseResult(item)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
              index === activeResult
                ? "bg-[var(--dash-accent-soft)] text-[var(--dash-text)]"
                : "text-[var(--dash-text)] hover:bg-[var(--dash-surface-2)]"
            }`}
          >
            <Search className="h-4 w-4 shrink-0 text-[var(--dash-text-3)]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {item.label}
              </span>
              <span className="block truncate text-xs text-[var(--dash-text-3)]">
                {item.context}
              </span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-[var(--dash-text-3)]" />
          </button>
        ))
      ) : (
        <p className="px-3 py-8 text-center text-sm text-[var(--dash-text-3)]">
          No dashboard pages match “{query.trim()}”.
        </p>
      )}
    </div>
  );

  return (
    <header className="dash-topbar relative z-40 flex items-center justify-between px-2 sm:px-4 h-14 bg-[#3f3f46] text-white">
      {/* Left */}
      <div className="flex items-center gap-1 sm:gap-3 shrink-0">
        <button
          type="button"
          className="md:hidden flex items-center justify-center w-10 h-10 -ml-1 sm:-ml-2 rounded-md text-white hover:bg-slate-700 shrink-0"
          aria-label="Open navigation menu"
          onClick={() => setOpen(true)}
        >
          <Menu className="h-6 w-6" />
        </button>

        <Link
          href="/dashboard"
          className="flex items-center gap-2 no-underline hover:opacity-80 transition-opacity shrink-0 pr-1"
        >
          <div className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-md bg-white/10">
            <Image
              src="/brand/storemink-mark.png"
              alt="StoreMink logo"
              width={20}
              height={20}
              className="h-5 w-5 object-contain"
            />
          </div>
          <span className="hidden xs:inline-block sm:inline-block text-[17px] font-semibold tracking-tight text-white">
            StoreMink
          </span>
        </Link>

        {storeName && (
          <div className="hidden items-center gap-2 lg:flex shrink-0">
            <span className="h-5 w-px bg-white/15" aria-hidden />
            <span
              className="max-w-[160px] truncate text-[13px] font-medium text-white/90"
              title={storeName}
            >
              {storeName}
            </span>

            {planName && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${planPill}`}
                title={`This store is on the ${planName} plan`}
              >
                {planName}
              </span>
            )}
            <span className="hidden sm:inline-flex items-center rounded-full bg-white/10 px-2.5 h-[34px] text-[12.5px] font-medium text-white/85 shrink-0">
              {formatRole(role)}
            </span>
            {/* Immediately right of the role: both answer "who am I here", and
                for a restricted admin the second is the one that explains why
                their screens look different from a colleague's. */}
            <LocationTag locations={scopedLocations} />
          </div>
        )}
      </div>

      {/* Perfectly centered search */}
      <div className="absolute inset-0 hidden md:flex items-center justify-center pointer-events-none">
        <div
          ref={desktopSearchRef}
          className="pointer-events-auto relative w-full max-w-md"
        >
          <form
            onSubmit={submitSearch}
            className={`group flex h-[34px] items-center gap-2 rounded-lg border px-3 transition-colors ${
              searchOpen
                ? "border-slate-400 bg-slate-600"
                : "border-transparent bg-slate-700 hover:border-slate-500 hover:bg-slate-600"
            }`}
          >
            <Search className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-white" />
            <input
              ref={desktopInputRef}
              type="search"
              role="combobox"
              aria-label="Search dashboard"
              aria-expanded={searchOpen}
              aria-controls="dashboard-search-results"
              aria-activedescendant={
                searchOpen && searchResults[activeResult]
                  ? `dashboard-search-results-${activeResult}`
                  : undefined
              }
              autoComplete="off"
              placeholder="Search"
              value={query}
              onFocus={openSearch}
              onChange={(event) => {
                setQuery(event.target.value);
                setSearchOpen(true);
                setActiveResult(0);
              }}
              onKeyDown={searchKeyDown}
              className="flex-1 bg-transparent border-none outline-none text-white text-[13px] placeholder:text-slate-400"
            />
            <kbd className="shrink-0 bg-slate-800 border border-slate-600 text-slate-400 text-[10px] font-medium px-1.5 py-0.5 rounded">
              ⌘ K
            </kbd>
          </form>
          {searchOpen && (
            <div className="absolute left-0 right-0 top-[calc(100%+8px)] overflow-hidden rounded-xl border border-[var(--dash-border)] bg-[var(--dash-surface)] text-[var(--dash-text)] shadow-[var(--dash-shadow-lg)]">
              {resultList("dashboard-search-results")}
            </div>
          )}
        </div>
      </div>

      {/* Right */}
      <div className="flex items-center gap-0.5 sm:gap-3 shrink-0 justify-end">
        <button
          type="button"
          onClick={() => window.open("/", "_blank")}
          className="hidden sm:flex items-center gap-2 text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 h-[34px] px-3 rounded-lg text-[13px] font-medium transition-colors shrink-0"
        >
          <Store className="h-4 w-4" />
          My Store
        </button>

        <button
          type="button"
          onClick={openSearch}
          className="md:hidden relative text-slate-300 hover:text-white w-8 h-8 rounded-md flex items-center justify-center transition-colors hover:bg-slate-700 shrink-0"
          aria-label="Open dashboard search"
        >
          <Search className="h-[18px] w-[18px]" />
        </button>

        <button
          type="button"
          onClick={toggleChat}
          className={`relative text-slate-300 hover:text-white w-8 h-8 rounded-md flex items-center justify-center transition-colors hover:bg-slate-700 shrink-0 ${
            isChatOpen ? "bg-slate-700 text-white" : ""
          }`}
          aria-label="Mink AI"
        >
          <MinkMark size="sm" />
        </button>

        <NotificationBell />

        <div className="shrink-0 ml-1">
          <TopbarProfile
            email={email}
            role={role}
            firstName={firstName}
            lastName={lastName}
            storeName={storeName}
            planName={planName}
          />
        </div>
      </div>

      {searchOpen && (
        <div
          className="fixed inset-0 z-[80] bg-black/55 p-3 md:hidden"
          onClick={closeSearch}
        >
          <div
            ref={mobileSearchRef}
            role="dialog"
            aria-modal="true"
            aria-label="Search dashboard"
            className="mx-auto mt-2 max-w-lg overflow-hidden rounded-xl border border-[var(--dash-border)] bg-[var(--dash-surface)] text-[var(--dash-text)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <form
              onSubmit={submitSearch}
              className="flex items-center gap-2 border-b border-[var(--dash-border)] px-3 py-2.5"
            >
              <Search className="h-4 w-4 shrink-0 text-[var(--dash-text-3)]" />
              <input
                ref={mobileInputRef}
                type="search"
                role="combobox"
                aria-label="Search dashboard pages"
                aria-expanded="true"
                aria-controls="dashboard-mobile-search-results"
                aria-activedescendant={
                  searchResults[activeResult]
                    ? `dashboard-mobile-search-results-${activeResult}`
                    : undefined
                }
                autoComplete="off"
                placeholder="Search dashboard"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveResult(0);
                }}
                onKeyDown={searchKeyDown}
                className="min-w-0 flex-1 bg-transparent py-1 text-base outline-none placeholder:text-[var(--dash-text-3)]"
              />
              <button
                type="button"
                onClick={closeSearch}
                aria-label="Close search"
                className="rounded-lg p-2 text-[var(--dash-text-2)] hover:bg-[var(--dash-surface-2)]"
              >
                <X className="h-4 w-4" />
              </button>
            </form>
            {resultList("dashboard-mobile-search-results")}
          </div>
        </div>
      )}
    </header>
  );
}
