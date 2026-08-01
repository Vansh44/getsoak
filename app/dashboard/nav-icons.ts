// The sidebar icon registry.
//
// ⚠ THIS FILE MUST NOT CARRY "use client".
//
// It used to live in sidebar-nav-link.tsx, which does. Across that boundary a
// server component importing `navIcons` gets a CLIENT REFERENCE rather than the
// object — so `navIcons[key]` was `undefined` and React threw "Element type is
// invalid ... got: undefined". That is what crashed /dashboard/settings, which
// is a server component that renders these icons directly.
//
// The map is plain data (component references keyed by string), so both graphs
// can import it as long as nothing here forces it client-side. Keep it that way.

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
  Store,
  MapPin,
  type LucideIcon,
  Mail,
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
  mail: Mail,
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
  pos: Store,
  location: MapPin,
} satisfies Record<string, LucideIcon>;

export type NavIconKey = keyof typeof navIcons;
