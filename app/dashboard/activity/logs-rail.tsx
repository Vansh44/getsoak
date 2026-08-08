"use client";

// The log-type rail. Vertical beside the content on desktop, a horizontal
// scroller above it on narrow screens — a rail that stacked would push the
// table below the fold on a phone.

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
    <nav
      aria-label="Log types"
      className="mb-4 shrink-0 overflow-x-auto lg:mb-0 lg:w-52 lg:overflow-x-visible"
    >
      <ul className="flex gap-1 lg:sticky lg:top-4 lg:flex-col">
        {LOG_TYPES.map((type) => {
          const Icon = ICONS[type.icon];
          const isActive = type.key === active;
          return (
            <li key={type.key}>
              <Link
                href={type.href}
                aria-current={isActive ? "page" : undefined}
                title={type.blurb}
                className={[
                  "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-[var(--dash-accent-soft,rgba(0,0,0,0.06))] font-medium text-[var(--dash-fg,inherit)]"
                    : "text-[var(--dash-fg-muted,#6b7280)] hover:bg-[var(--dash-hover,rgba(0,0,0,0.04))]",
                ].join(" ")}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {type.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
