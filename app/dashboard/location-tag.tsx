"use client";

// The topbar's location scope tag — which shops this person covers.
//
// ── ★★ IT IS AN ANSWER, NOT A FILTER ───────────────────────────────────────
// A restricted admin sees fewer orders and less stock than their colleague, and
// without this the difference is invisible: the same screens, quietly missing
// rows, with nothing on the page to explain why. That is the single most
// confusing thing location scope can do to somebody, so the scope is stated
// where they already look for who they are — beside the role.
//
// ⚠ It does NOT change what is shown. Every scoped read derives the scope
// server-side from `admin_locations` (lib/locations/scope.ts, roadmap invariant
// 7: a filter you can pass in is not a permission boundary). Picking a name in
// the dropdown tells you what you cover; it cannot widen or narrow it, and a
// control that looked like a switch would imply otherwise.

import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";

export function LocationTag({
  locations,
}: {
  /** The shops this viewer is restricted to. EMPTY = unrestricted, and the tag
   *  renders nothing — an owner does not need telling they can see their own
   *  store, and a badge on every screen for everybody is noise. */
  locations: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  if (locations.length === 0) return null;

  // ★ ONE LOCATION IS A LABEL, NOT A MENU. A dropdown that opens to a single
  // item is a control that promises a choice and has none.
  if (locations.length === 1) {
    return (
      <span
        className="hidden shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2.5 h-[34px] text-[12.5px] font-medium text-white/85 sm:inline-flex"
        title={`You can see ${locations[0].name} only`}
      >
        <MapPin className="h-3.5 w-3.5 opacity-70" strokeWidth={2.5} />
        {locations[0].name}
      </span>
    );
  }

  return (
    <div ref={ref} className="relative hidden shrink-0 sm:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title={`You can see ${locations.length} locations`}
        className="inline-flex h-[34px] items-center gap-1.5 rounded-full bg-white/10 px-2.5 text-[12.5px] font-medium text-white/85 transition-colors hover:bg-white/20"
      >
        <MapPin className="h-3.5 w-3.5 opacity-70" strokeWidth={2.5} />
        {locations.length} locations
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1.5 w-56 overflow-hidden rounded-xl border border-white/10 bg-[#0b0f14] py-1 shadow-2xl">
          <p className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-white/40">
            You can see
          </p>
          {locations.map((l) => (
            <span
              key={l.id}
              className="block truncate px-3 py-1.5 text-[13px] text-white/85"
            >
              {l.name}
            </span>
          ))}
          {/* Says plainly that this is not a switcher. Without it, a list of
              names in a dropdown reads as something you pick from. */}
          <p className="mt-1 border-t border-white/10 px-3 py-1.5 text-[11.5px] text-white/40">
            Orders and stock are limited to these.
          </p>
        </div>
      )}
    </div>
  );
}
