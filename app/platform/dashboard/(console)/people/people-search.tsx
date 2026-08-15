"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import type { PersonKind } from "@/lib/platform/people";
import { peopleHref } from "@/lib/platform/people-links";

/**
 * The People search box.
 *
 * ★ IT CARRIES THE OTHER FILTERS THROUGH. Searching used to be the one action
 * that could silently widen a filtered list — submit a term while looking at
 * one store's staff and you would land on every store's. The kind and store
 * params ride along; the page resets to 1, because a term that matches four
 * people has no page 3.
 */
export function PeopleSearch({
  initial,
  kind,
  storeId,
}: {
  initial: string;
  kind: PersonKind | "";
  storeId: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // page omitted: a new term resets paging, or a search matching four
    // people lands on page 4 and reads as "no results".
    router.push(peopleHref({ q: value.trim(), kind, store: storeId }));
  }

  return (
    <form className="relative w-full sm:max-w-sm" onSubmit={submit}>
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 pl-9 text-sm shadow-sm outline-none transition-all placeholder:text-slate-400 focus:border-slate-300 focus:ring-4 focus:ring-slate-100"
        placeholder="Search by name, email or store…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}
