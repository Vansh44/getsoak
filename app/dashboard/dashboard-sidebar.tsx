"use client";

import { useEffect, useState, useRef, useCallback, Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { SidebarNavLink } from "./sidebar-nav-link";
import { navIcons, type NavIconKey } from "./nav-icons";
import { useMobileNav } from "./dashboard-mobile-nav";
import { LogsRail } from "./logs/logs-rail";
import type { LogType } from "./logs/log-types";

type Child = {
  label: string;
  href: string;
  icon?: NavIconKey;
  badge?: string;
  badgeTone?: "accent" | "amber";
};
type Item = {
  href: string;
  label: string;
  icon: NavIconKey;
  badge?: string;
  badgeTone?: "accent" | "amber";
  children?: Child[];
  openInNewTab?: boolean;
};
type Group = { group: string; items: Item[] };

function matches(pathname: string, href: string): boolean {
  return (
    pathname === href ||
    (href !== "/dashboard" && pathname.startsWith(`${href}/`))
  );
}

/**
 * Which top-level section owns this path — i.e. whose sub-nav panel to show.
 *
 * ★ THE PANEL FOLLOWS THE OWNING SECTION, NOT A URL PREFIX. `items` is
 * TOP-LEVEL only: `foldNestedSections` turns a section declaring a `parent`
 * (Staff, Roles, Billing, Channels, Inventory, Categories, Colours, Groups,
 * Coupons — twelve of them) into a CHILD of that parent, so it is absent here.
 *
 * This used to try a direct href match and then fall straight back to
 * `/dashboard`, so navigating Settings → Staff matched no top-level item and
 * landed on HOME: the Settings sub-nav was replaced by the root nav mid-journey,
 * the section just opened wasn't highlighted, and the only route back to its
 * siblings was the browser's Back button. It affected every nested section, not
 * just Settings.
 *
 * Nesting is precisely where a URL prefix cannot help — `/dashboard/admins` is a
 * child of Settings but lives at a top-level path, so `startsWith` will never
 * relate the two. The parent has to be found through the tree.
 *
 * Pure and exported so the precedence is testable without mounting the sidebar.
 */
export function resolveActiveSection<
  T extends { href: string; children?: { href: string }[] },
>(items: T[], pathname: string): T | undefined {
  return (
    // A DIRECT match wins first, and that order is load-bearing:
    // `/dashboard/users` must open the Customers panel rather than being claimed
    // by some parent that happens to list a child beneath that path.
    items.find((it) => matches(pathname, it.href)) ??
    items.find((it) => it.children?.some((c) => matches(pathname, c.href))) ??
    items.find((it) => it.href === "/dashboard") ??
    items[0]
  );
}

export function DashboardSidebar({
  groups,
  logTypes,
  logsBasePath = "/dashboard/logs",
}: {
  groups?: Group[];
  /** The log registry for THIS console. Absent = the merchant's (LogsRail's
   *  own default) — the operator console passes its own, which has no
   *  import/export and adds announcements. */
  logTypes?: LogType[];
  /** Which path prefix opens the logs panel. Both consoles use /dashboard/logs
   *  today; it is a prop so a future third console cannot silently inherit the
   *  wrong one. */
  logsBasePath?: string;
}) {
  const pathname = usePathname();
  const { open, setOpen } = useMobileNav();
  const allItems = groups ? groups.flatMap((g) => g.items) : [];

  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("sm-sidebar-width");
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 200 && parsed <= 400) {
        requestAnimationFrame(() => setSidebarWidth(parsed));
      }
    }
  }, []);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      let newWidth = e.clientX;
      if (newWidth < 200) newWidth = 200;
      if (newWidth > 400) newWidth = 400;
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = (e: MouseEvent) => {
      setIsResizing(false);
      let finalWidth = e.clientX;
      if (finalWidth < 200) finalWidth = 200;
      if (finalWidth > 400) finalWidth = 400;
      localStorage.setItem("sm-sidebar-width", String(finalWidth));
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  const activeSection = resolveActiveSection(allItems, pathname);
  // Logs has no `children` (see permissions.ts) — its five entries live in
  // LOG_TYPES, because Import and Export share a pathname and only `?kind=`
  // tells them apart, which the generic child matcher below cannot see. So it
  // gets the same panel treatment through its own rail.
  const inLogs = pathname.startsWith(logsBasePath);

  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  return (
    <>
      <div
        className={`dash-sidebar-overlay ${open ? "open" : ""}`}
        onClick={() => setOpen(false)}
        aria-hidden
      />

      <aside
        ref={sidebarRef}
        className={`dash-sidebar shrink-0 flex flex-col justify-between py-3 ${open ? "dash-sidebar--open" : ""}`}
        style={{ width: open ? undefined : sidebarWidth }}
      >
        <div
          className={`dash-sidebar-resizer ${isResizing ? "is-resizing" : ""}`}
          onMouseDown={startResizing}
          aria-hidden="true"
        />

        <div className="dash-primary" style={{ width: "100%" }}>
          {inLogs ? (
            <div className="dash-nav-scroll px-3">
              <Link
                href="/dashboard"
                className="dash-nav-item dash-subnav-back"
              >
                <span className="dash-nav-icon" aria-hidden>
                  <ArrowLeft className="h-[17px] w-[17px]" strokeWidth={2} />
                </span>
                <span className="truncate">Back</span>
              </Link>
              <div className="pt-1">
                <div className="dash-nav-label mb-2 px-2.5 text-xs font-semibold text-[#8a8a8a]">
                  Logs
                </div>
                {/* useSearchParams needs a boundary, or this opts the whole
                    sidebar into a client-side bailout during rendering. */}
                <Suspense fallback={<div className="h-[164px]" />}>
                  <LogsRail types={logTypes} />
                </Suspense>
              </div>
            </div>
          ) : activeSection?.children?.length ? (
            (() => {
              const activeChildHref = activeSection
                .children!.filter((c) => matches(pathname, c.href))
                .sort((a, b) => b.href.length - a.href.length)[0]?.href;
              return (
                <div className="dash-nav-scroll px-3">
                  <Link
                    href="/dashboard"
                    className="dash-nav-item dash-subnav-back"
                  >
                    <span className="dash-nav-icon" aria-hidden>
                      <ArrowLeft
                        className="h-[17px] w-[17px]"
                        strokeWidth={2}
                      />
                    </span>
                    <span className="truncate">Back</span>
                  </Link>
                  <div className="pt-1">
                    <div className="dash-nav-label text-xs font-semibold text-[#8a8a8a] mb-2 px-2.5">
                      {activeSection.label}
                    </div>
                    <nav className="flex flex-col gap-0.5">
                      {activeSection.children!.map((c) => {
                        const Icon = navIcons[c.icon ?? activeSection.icon];
                        const active = c.href === activeChildHref;
                        return (
                          <Link
                            key={c.href}
                            href={c.href}
                            className={`flex items-start gap-2.5 px-2.5 py-2 rounded-md text-[13.5px] font-medium transition-colors ${
                              active
                                ? "bg-white text-[#1a1a1a] shadow-[0_1px_3px_rgba(0,0,0,0.05)]"
                                : "text-[#4a4a4a] hover:bg-[#e3e3e3] hover:text-[#1a1a1a]"
                            }`}
                          >
                            <span className="dash-nav-icon mt-0.5" aria-hidden>
                              <Icon
                                className="h-[17px] w-[17px]"
                                strokeWidth={2}
                              />
                            </span>
                            <span className="min-w-0 flex-1 whitespace-normal break-words leading-5">
                              {c.label}
                            </span>
                            {c.badge ? (
                              <span
                                className={`dash-nav-badge mt-0.5 shrink-0 ${c.badgeTone ?? "accent"}`}
                              >
                                {c.badge}
                              </span>
                            ) : null}
                          </Link>
                        );
                      })}
                    </nav>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="dash-nav-scroll px-3 flex-1 flex flex-col gap-0.5 mt-1">
              {groups?.map((g) => (
                <div key={g.group} className="pt-1">
                  <div className="text-xs font-semibold text-[#8a8a8a] mb-2 px-2.5 mt-2">
                    {g.group}
                  </div>
                  <nav className="flex flex-col gap-0.5">
                    {g.items.map((item) => (
                      <SidebarNavLink
                        key={item.href}
                        href={item.href}
                        label={item.label}
                        icon={item.icon}
                        badge={item.badge}
                        badgeTone={item.badgeTone}
                        openInNewTab={item.openInNewTab}
                      />
                    ))}
                  </nav>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
