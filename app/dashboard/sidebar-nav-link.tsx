"use client";

import Link from "next/link";
import { navIcons, type NavIconKey } from "./nav-icons";
import { usePathname } from "next/navigation";

export function SidebarNavLink({
  href,
  label,
  icon,
  badge,
  badgeTone = "accent",
  openInNewTab = false,
}: {
  href: string;
  label: string;
  icon: NavIconKey;
  badge?: string;
  badgeTone?: "accent" | "amber";
  openInNewTab?: boolean;
}) {
  const pathname = usePathname();
  const isActive =
    !openInNewTab &&
    (pathname === href ||
      (href !== "/dashboard" && pathname.startsWith(`${href}/`)));
  const Icon = navIcons[icon];

  return (
    <Link
      href={href}
      className={`dash-nav-item ${isActive ? "active" : ""}`}
      {...(openInNewTab
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
    >
      <span className="dash-nav-icon" aria-hidden>
        <Icon className="h-[17px] w-[17px]" strokeWidth={2} />
      </span>
      <span className="truncate">{label}</span>
      {badge && <span className={`dash-nav-badge ${badgeTone}`}>{badge}</span>}
    </Link>
  );
}

export type SidebarNavItem = {
  href: string;
  label: string;
  icon: NavIconKey;
  badge?: string;
  badgeTone?: "accent" | "amber";
};
