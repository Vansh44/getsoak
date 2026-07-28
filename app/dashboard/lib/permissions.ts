// ---------------------------------------------------------------------------
// Permission catalog — the single source of truth for which dashboard sections
// exist and what can be done in each. Roles store a subset of this as their
// `permissions` map. Pure module (no server imports) so it can be shared by
// server components, server actions, and client editors alike.
// ---------------------------------------------------------------------------

import type { NavIconKey } from "../sidebar-nav-link";

export type PermissionAction = "view" | "manage";

export type SectionGroup = "Workspace" | "Content" | "Administration";

/** A nested sidebar link shown indented under its parent section. */
export interface DashboardSectionChild {
  label: string;
  href: string;
  icon?: NavIconKey;
}

export interface DashboardSection {
  /** Stable machine key, used in role permission maps and guards. */
  key: string;
  label: string;
  href: string;
  icon: NavIconKey;
  group: SectionGroup;
  /** Actions that are meaningful for this section. */
  actions: PermissionAction[];
  /** Optional sidebar badge (kept from the original static nav). */
  badge?: string;
  badgeTone?: "accent" | "amber";
  /** Optional nested links (e.g. Marketing → Coupons). */
  children?: DashboardSectionChild[];
  /** Open the link in a new tab (e.g. the full-screen Website Builder). */
  openInNewTab?: boolean;
}

// Order here drives the order roles are displayed in the editor and the nav.
export const SECTIONS: DashboardSection[] = [
  // Workspace
  {
    key: "dashboard",
    label: "Home",
    href: "/dashboard",
    icon: "home",
    group: "Workspace",
    actions: ["view"],
  },
  {
    key: "orders",
    label: "Orders",
    href: "/dashboard/orders",
    icon: "orders",
    group: "Workspace",
    actions: ["view", "manage"],
    badge: "12",
    badgeTone: "accent",
  },
  {
    key: "products",
    label: "Products",
    href: "/dashboard/products",
    icon: "products",
    group: "Workspace",
    actions: ["view", "manage"],
  },
  {
    key: "categories",
    label: "Categories",
    href: "/dashboard/categories",
    icon: "categories",
    group: "Workspace",
    actions: ["view", "manage"],
  },
  {
    key: "colors",
    label: "Colours",
    href: "/dashboard/colors",
    icon: "colors",
    group: "Workspace",
    actions: ["view", "manage"],
  },
  {
    key: "users",
    label: "Users",
    href: "/dashboard/users",
    icon: "customers",
    group: "Workspace",
    actions: ["view", "manage"],
    children: [
      {
        label: "All Users",
        href: "/dashboard/users",
        icon: "customers",
      },
      {
        label: "User Groups",
        href: "/dashboard/users/user_groups",
        icon: "user_groups",
      },
    ],
  },
  {
    key: "inventory",
    label: "Inventory",
    href: "/dashboard/inventory",
    icon: "inventory",
    group: "Workspace",
    actions: ["view", "manage"],
  },
  {
    // Point of Sale. Plan-gated (Pro): the sidebar shows an "Included in Pro"
    // upgrade state on free/basic and an "Enable POS" state on Pro until it's
    // switched on (see app/dashboard/layout.tsx). Children are only surfaced
    // once POS is enabled.
    key: "pos",
    label: "Point of Sale",
    href: "/dashboard/pos",
    icon: "pos",
    group: "Workspace",
    actions: ["view", "manage"],
    children: [
      { label: "Overview", href: "/dashboard/pos", icon: "pos" },
      {
        label: "Locations",
        href: "/dashboard/pos/locations",
        icon: "location",
      },
      { label: "Staff", href: "/dashboard/pos/staff", icon: "customers" },
      { label: "Devices", href: "/dashboard/pos/devices", icon: "channels" },
      {
        label: "POS Settings",
        href: "/dashboard/pos/settings",
        icon: "settings",
      },
    ],
  },
  {
    key: "analytics",
    label: "Analytics",
    href: "/dashboard/analytics",
    icon: "analytics",
    group: "Workspace",
    actions: ["view"],
  },
  {
    key: "enquiries",
    label: "Enquiries",
    href: "/dashboard/enquiries",
    icon: "enquiries",
    group: "Workspace",
    actions: ["view", "manage"],
  },

  // Content
  {
    key: "builder",
    label: "Website Builder",
    href: "/dashboard/builder",
    icon: "homepage",
    group: "Content",
    actions: ["view", "manage"],
    // Opens the full-screen builder in a new tab.
    openInNewTab: true,
  },
  {
    key: "navigation",
    label: "Navigation",
    href: "/dashboard/navigation",
    icon: "globe",
    group: "Content",
    actions: ["view", "manage"],
  },
  {
    key: "blogs",
    label: "Blogs",
    href: "/dashboard/blogs",
    icon: "blogs",
    group: "Content",
    actions: ["view", "manage"],
    children: [
      {
        label: "All Blogs",
        href: "/dashboard/blogs",
        icon: "blogs",
      },
      {
        label: "Blog Settings",
        href: "/dashboard/blogs/settings",
        icon: "settings",
      },
    ],
  },
  {
    key: "marketing",
    label: "Marketing",
    href: "/dashboard/marketing",
    icon: "marketing",
    group: "Content",
    actions: ["view", "manage"],
    children: [
      {
        label: "Coupons",
        href: "/dashboard/marketing/coupons",
        icon: "coupons",
      },
    ],
  },
  {
    key: "promotions",
    label: "Promotions",
    href: "/dashboard/promotions",
    icon: "promotions",
    group: "Content",
    actions: ["view", "manage"],
  },

  // Administration
  {
    key: "admins",
    label: "Admins",
    href: "/dashboard/admins",
    icon: "users",
    group: "Administration",
    actions: ["view", "manage"],
  },
  {
    key: "media",
    label: "Media Library",
    href: "/dashboard/media",
    icon: "media",
    group: "Administration",
    actions: ["view", "manage"],
  },
  {
    key: "roles",
    label: "Roles & Permissions",
    href: "/dashboard/roles",
    icon: "roles",
    group: "Administration",
    actions: ["view", "manage"],
  },
  {
    key: "activity",
    label: "Activity Logs",
    href: "/dashboard/activity",
    icon: "activity",
    group: "Administration",
    actions: ["view"],
    // Two logs, one permission: "what happened" and "what we sent about it".
    // They answer different questions but they're the same class of data, so
    // splitting them into separate permission sections would only give an owner
    // a distinction they don't want to think about.
    children: [
      {
        label: "Activity",
        href: "/dashboard/activity",
        icon: "activity",
      },
      {
        label: "Email Logs",
        href: "/dashboard/activity/email-logs",
        icon: "mail",
      },
    ],
  },
  {
    key: "branding",
    label: "Branding",
    href: "/dashboard/branding",
    icon: "colors",
    group: "Administration",
    actions: ["view", "manage"],
  },
  {
    key: "billing",
    label: "Invoices & Billing",
    href: "/dashboard/billing",
    icon: "billing",
    group: "Administration",
    actions: ["view", "manage"],
  },
  {
    key: "channels",
    label: "Channels",
    href: "/dashboard/channels",
    icon: "channels",
    group: "Administration",
    actions: ["view", "manage"],
  },
  {
    key: "ai",
    label: "Plans & Billing",
    href: "/dashboard/plans",
    icon: "plans",
    group: "Administration",
    actions: ["view", "manage"],
  },
  {
    key: "notifications",
    label: "Notifications",
    href: "/dashboard/settings/notifications",
    icon: "notifications",
    group: "Administration",
    actions: ["view", "manage"],
  },
  {
    key: "settings",
    label: "Settings",
    href: "/dashboard/settings",
    icon: "settings",
    group: "Administration",
    actions: ["view", "manage"],
    children: [
      {
        label: "Account",
        href: "/dashboard/settings/account",
        icon: "settings",
      },
      {
        label: "Notifications",
        href: "/dashboard/settings/notifications",
        icon: "notifications",
      },
      {
        label: "Policies",
        href: "/dashboard/settings/policies",
        icon: "settings",
      },
      {
        label: "Domain",
        href: "/dashboard/settings/domain",
        icon: "globe",
      },
    ],
  },
];

export const SECTION_GROUPS: SectionGroup[] = [
  "Workspace",
  "Content",
  "Administration",
];

const SECTION_BY_KEY = new Map(SECTIONS.map((s) => [s.key, s]));

export function getSection(key: string): DashboardSection | undefined {
  return SECTION_BY_KEY.get(key);
}

/** A role's permission map: section key -> granted actions. */
export type RolePermissions = Record<string, PermissionAction[]>;

export const SUPERADMIN_SLUG = "superadmin";

/**
 * Can a holder of `permissions` perform `action` on `section`?
 * Superadmins always can. "manage" implies "view".
 */
export function can(
  permissions: RolePermissions | null | undefined,
  section: string,
  action: PermissionAction,
  isSuperadmin = false,
): boolean {
  if (isSuperadmin) return true;
  const granted = permissions?.[section];
  if (!granted || granted.length === 0) return false;
  if (granted.includes(action)) return true;
  // Holding "manage" implies the ability to "view".
  if (action === "view" && granted.includes("manage")) return true;
  return false;
}

/** Sanitise an arbitrary object into a valid RolePermissions map. */
export function normalizePermissions(input: unknown): RolePermissions {
  const out: RolePermissions = {};
  if (!input || typeof input !== "object") return out;
  for (const section of SECTIONS) {
    const raw = (input as Record<string, unknown>)[section.key];
    if (!Array.isArray(raw)) continue;
    const actions = section.actions.filter((a) => raw.includes(a));
    if (actions.length > 0) out[section.key] = actions;
  }
  return out;
}

export const ROLE_COLORS = [
  "grey",
  "blue",
  "green",
  "amber",
  "violet",
] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];

const ROLE_BADGE_CLASS: Record<RoleColor, string> = {
  grey: "dash-badge-grey",
  blue: "dash-badge-blue",
  green: "dash-badge-green",
  amber: "dash-badge-amber",
  violet: "dash-role-super",
};

export function roleBadgeClass(color: string): string {
  return ROLE_BADGE_CLASS[(color as RoleColor) ?? "grey"] ?? "dash-badge-grey";
}
