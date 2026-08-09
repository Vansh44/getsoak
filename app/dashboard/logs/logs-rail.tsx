"use client";

// The log-type rail — the one navigation between the five logs.
//
// ★ IT RENDERS IN THE SIDEBAR, NOT BESIDE THE CONTENT. It used to be a second
// column inside the logs layout, which meant a page with THREE levels of
// navigation on screen at once: the dashboard's own nav, this rail, and the
// page's filters. The dashboard already has a pattern for "a section you are
// inside" — the sub-nav panel that replaces the nav with Back + that section's
// pages (Settings, Blogs, POS all use it) — so Logs uses it too, and the rail
// simply IS that panel's contents.
//
// It stays a component driven by LOG_TYPES rather than becoming `children` on
// the permission section, because Import and Export share a pathname and are
// told apart by `?kind=`. The sidebar's generic child matcher compares hrefs and
// ignores the query string, so it would light up both entries on either page.
// `activeLogKey` is the thing that knows better.

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Activity, AlertTriangle, Download, Mail, Upload } from "lucide-react";
import { LOG_TYPES, activeLogKey, type LogType } from "./log-types";

const ICONS = {
  activity: Activity,
  mail: Mail,
  download: Download,
  upload: Upload,
  alert: AlertTriangle,
} as const satisfies Record<LogType["icon"], React.ElementType>;

export function LogsRail() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = activeLogKey(pathname, searchParams.get("kind") ?? undefined);

  return (
    <nav aria-label="Log types" className="flex flex-col gap-0.5">
      {LOG_TYPES.map((type) => {
        const Icon = ICONS[type.icon];
        const isActive = type.key === active;
        return (
          <Link
            key={type.key}
            href={type.href}
            aria-current={isActive ? "page" : undefined}
            title={type.blurb}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] font-medium transition-colors ${
              isActive
                ? "bg-white text-[#1a1a1a] shadow-[0_1px_3px_rgba(0,0,0,0.05)]"
                : "text-[#4a4a4a] hover:bg-[#e3e3e3] hover:text-[#1a1a1a]"
            }`}
          >
            <span className="dash-nav-icon" aria-hidden>
              <Icon className="h-[17px] w-[17px]" strokeWidth={2} />
            </span>
            <span className="truncate">{type.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
