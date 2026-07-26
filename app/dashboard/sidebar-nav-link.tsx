"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  LayoutGrid,
  Package,
  ShoppingBag,
  Tags,
  Palette,
  Users,
  UsersRound,
  Boxes,
  BarChart3,
  PenLine,
  Megaphone,
  Gift,
  Ticket,
  ShieldCheck,
  Images,
  KeyRound,
  History,
  Settings,
  LayoutTemplate,
  MessageSquare,
  Globe,
  Type,
  Code2,
  GalleryHorizontalEnd,
  BadgeCheck,
  LayoutDashboard,
  HelpCircle,
  Receipt,
  CreditCard,
  Gem,
  Sparkles,
  House,
  type LucideIcon,
} from "lucide-react";

export const navIcons = {
  dashboard: LayoutGrid,
  home: House,
  homepage: LayoutTemplate,
  orders: Package,
  products: ShoppingBag,
  categories: Tags,
  colors: Palette,
  customers: Users,
  user_groups: UsersRound,
  inventory: Boxes,
  analytics: BarChart3,
  enquiries: MessageSquare,
  blogs: PenLine,
  marketing: Megaphone,
  promotions: Gift,
  coupons: Ticket,
  users: ShieldCheck,
  media: Images,
  roles: KeyRound,
  activity: History,
  notifications: Bell,
  settings: Settings,
  globe: Globe,
  rich_text: Type,
  custom_code: Code2,
  hero: GalleryHorizontalEnd,
  usp: BadgeCheck,
  ticker: Megaphone,
  tiles: LayoutDashboard,
  faq: HelpCircle,
  billing: Receipt,
  channels: CreditCard,
  ai: Sparkles,
  plans: Gem,
} satisfies Record<string, LucideIcon>;

export type NavIconKey = keyof typeof navIcons;

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
