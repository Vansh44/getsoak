"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { SidebarNavLink, navIcons, type NavIconKey } from "./sidebar-nav-link";
import { useMobileNav } from "./dashboard-mobile-nav";

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

export function DashboardSidebar({ groups }: { groups?: Group[] }) {
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

  const activeSection =
    allItems.find((it) => matches(pathname, it.href)) ??
    allItems.find((it) => it.href === "/dashboard") ??
    allItems[0];

  const showPanel = !!activeSection?.children?.length;

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
          {showPanel ? (
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
                            className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13.5px] font-medium transition-colors ${
                              active
                                ? "bg-white text-[#1a1a1a] shadow-[0_1px_3px_rgba(0,0,0,0.05)]"
                                : "text-[#4a4a4a] hover:bg-[#e3e3e3] hover:text-[#1a1a1a]"
                            }`}
                          >
                            <span className="dash-nav-icon" aria-hidden>
                              <Icon
                                className="h-[17px] w-[17px]"
                                strokeWidth={2}
                              />
                            </span>
                            <span className="truncate">{c.label}</span>
                            {c.badge ? (
                              <span
                                className={`dash-nav-badge ${c.badgeTone ?? "accent"}`}
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
