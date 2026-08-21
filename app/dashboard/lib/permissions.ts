// ---------------------------------------------------------------------------
// Permission catalog — the single source of truth for which dashboard sections
// exist and what can be done in each. Roles store a subset of this as their
// `permissions` map. Pure module (no server imports) so it can be shared by
// server components, server actions, and client editors alike.
// ---------------------------------------------------------------------------

import type { NavIconKey } from "../nav-icons";

export type PermissionAction = "view" | "manage";

export type SectionGroup =
  | "Workspace"
  | "Sell in person"
  | "Storefront"
  | "Marketing"
  | "Settings";

/**
 * A nested sidebar link shown indented under its parent section.
 *
 * A child SHARES its parent's permission — it is another page of the same
 * feature (Blogs → Blog settings), not a separately-gated area. Anything that
 * needs its own permission must be a full section with `parent` set instead,
 * because children are rendered without a `can()` check.
 */
export interface DashboardSectionChild {
  label: string;
  href: string;
  icon?: NavIconKey;
  badge?: string;
  badgeTone?: "accent" | "amber";
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
  /** Optional nested links sharing this section's permission. */
  children?: DashboardSectionChild[];
  /** Open the link in a new tab (e.g. the full-screen Website Builder). */
  openInNewTab?: boolean;
  /**
   * Keep this section OUT of the sidebar while leaving its permission key
   * intact. For an area that has been folded into another screen: removing the
   * section outright would strip the key from every saved role.
   */
  hiddenInNav?: boolean;
  /**
   * Display this section NESTED under another section's key, instead of at the
   * top level of its group.
   *
   * This exists so the sidebar can be organised by task without collapsing the
   * permission model. Categories, Colours and Inventory are properties of
   * Products and read as clutter beside Orders — but each is separately
   * permissioned, and `children` are rendered with no `can()` check, so
   * demoting them to plain children would show staff links they cannot open.
   * Keeping them as sections with a `parent` means the nav nests them while
   * `can(key, …)`, the role editor and every page guard carry on unchanged.
   *
   * A parent's badge is derived from its nested sections when it has none of
   * its own (app/dashboard/layout.tsx) — otherwise nesting Inventory would
   * hide the low-stock count that is the reason anyone looks at it.
   */
  parent?: string;
}

// Order here drives the order roles are displayed in the editor and the nav.
//
// GROUPING RULE: a group is a job the merchant is doing, and every top-level
// entry is a noun they already think in. The old "Workspace" group was eleven
// items with no shared idea — selling ops, product attributes, customers,
// physical retail and reporting in one pile — which is why nothing could be
// found in it. Attributes now nest under the thing they describe (`parent`),
// and everything configuration-shaped lives behind Settings.
export const SECTIONS: DashboardSection[] = [
  // --- Workspace: the daily loop -------------------------------------------
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
    // No badge. This carried a HARDCODED "12" — not an order count, just the
    // literal string, shown to every store on every plan forever. A number in
    // the nav that never moves teaches people to ignore numbers in the nav.
    actions: ["view", "manage"],
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
    // A product attribute, not a peer of Orders.
    key: "categories",
    label: "Categories",
    href: "/dashboard/categories",
    icon: "categories",
    group: "Workspace",
    actions: ["view", "manage"],
    parent: "products",
  },
  {
    // Card colours — a styling field on a product. It was a top-level
    // destination sitting between Categories and Users.
    key: "colors",
    label: "Colours",
    href: "/dashboard/colors",
    icon: "colors",
    group: "Workspace",
    actions: ["view", "manage"],
    parent: "products",
  },
  {
    // Nested, but its low-stock badge bubbles up to Products — the count is
    // the whole reason this gets opened.
    key: "inventory",
    label: "Inventory",
    href: "/dashboard/inventory",
    icon: "inventory",
    group: "Workspace",
    actions: ["view", "manage"],
    parent: "products",
  },
  {
    // Was "Users", which read as staff. This is the SHOPPER list; the people
    // who work here are Settings -> Staff.
    key: "users",
    label: "Customers",
    href: "/dashboard/users",
    icon: "customers",
    group: "Workspace",
    actions: ["view", "manage"],
    children: [
      {
        label: "All customers",
        href: "/dashboard/users",
        icon: "customers",
      },
      {
        label: "Groups",
        href: "/dashboard/users/user_groups",
        icon: "user_groups",
      },
    ],
  },
  {
    // Messages from customers belong with customers. Its badge bubbles up.
    key: "enquiries",
    label: "Enquiries",
    href: "/dashboard/enquiries",
    icon: "enquiries",
    group: "Workspace",
    actions: ["view", "manage"],
    parent: "users",
  },
  {
    key: "analytics",
    label: "Analytics",
    href: "/dashboard/analytics",
    icon: "analytics",
    group: "Workspace",
    actions: ["view"],
  },

  // --- Sell in person -------------------------------------------------------
  {
    // Locations are NOT a POS feature — POS is one capability OF a location,
    // and a warehouse is a location with POS switched off (docs/locations-ia.md).
    // Sits above Point of Sale: places first, then what you do there.
    // Hidden for stores that can't use it — see app/dashboard/layout.tsx.
    key: "locations",
    label: "Locations",
    href: "/dashboard/locations",
    icon: "location",
    group: "Sell in person",
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
    group: "Sell in person",
    actions: ["view", "manage"],
    children: [
      { label: "Overview", href: "/dashboard/pos", icon: "pos" },
      { label: "Staff", href: "/dashboard/pos/staff", icon: "customers" },
      { label: "Devices", href: "/dashboard/pos/devices", icon: "channels" },
      // Money events (Step 14) get their own page rather than a tab on
      // "Devices": an owner reconciling a drawer and an admin checking who
      // paired a browser are looking for different things.
      { label: "Money log", href: "/dashboard/pos/money", icon: "orders" },
      // Shift history + Z-reports (Step 17). Drawers are shift-shaped, which
      // is why they live here and not in Analytics — see the roadmap.
      { label: "Shifts", href: "/dashboard/pos/shifts", icon: "orders" },
      {
        label: "POS settings",
        href: "/dashboard/pos/settings",
        icon: "settings",
      },
    ],
  },

  // --- Storefront: everything a visitor sees --------------------------------
  {
    key: "builder",
    label: "Website Builder",
    href: "/dashboard/builder",
    icon: "homepage",
    group: "Storefront",
    actions: ["view", "manage"],
    // Opens the full-screen builder in a new tab.
    openInNewTab: true,
  },
  {
    // Retired as a destination — /dashboard/navigation redirects into the
    // builder, where the header and footer now live. The SECTION stays so
    // existing roles keep a meaningful permission key and the role editor
    // doesn't silently drop a grant; `hiddenInNav` keeps it out of the
    // sidebar, where a second entry pointing at the builder would just be a
    // duplicate of the one above it.
    key: "navigation",
    label: "Navigation",
    href: "/dashboard/builder",
    icon: "globe",
    hiddenInNav: true,
    group: "Storefront",
    actions: ["view", "manage"],
  },
  {
    key: "blogs",
    label: "Blogs",
    href: "/dashboard/blogs",
    icon: "blogs",
    group: "Storefront",
    actions: ["view", "manage"],
    children: [
      {
        label: "All blogs",
        href: "/dashboard/blogs",
        icon: "blogs",
      },
      {
        label: "Blog settings",
        href: "/dashboard/blogs/settings",
        icon: "settings",
      },
    ],
  },
  {
    // Moved out of Administration: branding is how the shop LOOKS, which is a
    // storefront decision, not an admin one.
    key: "branding",
    label: "Branding",
    href: "/dashboard/branding",
    icon: "colors",
    group: "Storefront",
    actions: ["view", "manage"],
  },
  {
    // Same reasoning: the media library feeds the storefront.
    key: "media",
    label: "Media",
    href: "/dashboard/media",
    icon: "media",
    group: "Storefront",
    actions: ["view", "manage"],
  },

  // --- Marketing ------------------------------------------------------------
  {
    key: "marketing",
    label: "Marketing",
    href: "/dashboard/marketing",
    icon: "marketing",
    group: "Marketing",
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
    group: "Marketing",
    actions: ["view", "manage"],
    parent: "marketing",
  },

  // --- Settings: one entry, everything configuration-shaped behind it -------
  //
  // Ten separate Administration entries were most of what made the sidebar feel
  // scattered, and none of them is opened daily. They keep their own permission
  // keys (via `parent`), so roles are unaffected.
  {
    key: "settings",
    label: "Settings",
    href: "/dashboard/settings",
    icon: "settings",
    group: "Settings",
    actions: ["view", "manage"],
    children: [
      {
        label: "Account",
        href: "/dashboard/settings/account",
        icon: "settings",
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
      {
        label: "Shipping & delivery",
        href: "/dashboard/settings/shipping",
        icon: "shipping",
      },
      {
        label: "Analytics tracking",
        href: "/dashboard/settings/analytics",
        icon: "analytics",
      },
    ],
  },
  {
    // Was "Admins". The people who work here — named to contrast with
    // Customers, which is what "Users" used to be.
    key: "admins",
    label: "Staff",
    href: "/dashboard/admins",
    icon: "users",
    group: "Settings",
    actions: ["view", "manage"],
    parent: "settings",
  },
  {
    key: "roles",
    label: "Roles & permissions",
    href: "/dashboard/roles",
    icon: "roles",
    group: "Settings",
    actions: ["view", "manage"],
    parent: "settings",
  },
  {
    // Was "Plans & Billing". Key stays `ai` for role compatibility — renaming a
    // permission key would silently revoke it for every existing role.
    key: "ai",
    label: "Plan & billing",
    href: "/dashboard/plans",
    icon: "plans",
    group: "Settings",
    actions: ["view", "manage"],
    parent: "settings",
  },
  {
    key: "channels",
    label: "Channels",
    href: "/dashboard/channels",
    icon: "channels",
    group: "Settings",
    actions: ["view", "manage"],
    parent: "settings",
  },
  {
    // Was "Invoices & Billing" — indistinguishable from "Plans & Billing" in a
    // list. This one is tax configuration and invoice templates.
    key: "billing",
    label: "Taxes & invoices",
    href: "/dashboard/billing",
    icon: "billing",
    group: "Settings",
    actions: ["view", "manage"],
    parent: "settings",
  },
  {
    // Previously listed BOTH as its own Administration entry and as a child of
    // Settings, pointing at the same page.
    key: "notifications",
    label: "Notifications",
    href: "/dashboard/settings/notifications",
    icon: "notifications",
    group: "Settings",
    actions: ["view", "manage"],
    parent: "settings",
  },
  {
    // ★ THE KEY STAYS `activity` THOUGH THE LABEL IS NOW "Logs". Roles store
    // this key, so renaming it would silently revoke every grant already saved
    // — the reason `navigation` kept its key when it folded into the builder.
    key: "activity",
    label: "Logs",
    href: "/dashboard/logs",
    icon: "activity",
    group: "Settings",
    actions: ["view"],
    // ★ NO `children`, DELIBERATELY. It used to carry one per log type, which
    // became two competing navigations for the same destinations once the hub
    // grew its own rail (app/dashboard/logs/logs-rail.tsx). The sidebar
    // links to the hub; the rail moves between logs.
    //
    // Every log stays on ONE permission: "what happened", "what we sent",
    // "what that import changed" and "what failed" answer different questions
    // but are the same class of data, and splitting them would only give an
    // owner a distinction they don't want to think about.
    //
    // ⚠ `parent` is also gone, so Logs is a top-level entry rather than a
    // third level under Settings. Five log types buried two levels deep is
    // what made them hard to find.
  },
];

export const SECTION_GROUPS: SectionGroup[] = [
  "Workspace",
  "Sell in person",
  "Storefront",
  "Marketing",
  "Settings",
];

/** A permission-filtered nav group, ready for the sidebar. */
export interface NavGroup {
  group: SectionGroup;
  items: DashboardSection[];
}

/**
 * Fold sections that declare a `parent` INTO that parent's children.
 *
 * Called AFTER the per-section permission filter, which is the entire point:
 * Categories, Inventory, Staff and the rest are separately permissioned, and
 * plain `children` render with no `can()` check, so nesting them any other way
 * would show a link its holder cannot open.
 *
 * Pure, and it never mutates its input — the caller's items come from the
 * shared SECTIONS catalog, and pushing onto their `children` in a long-lived
 * server process would grow the real catalog on every request until a merchant
 * saw the same sub-item a hundred times.
 *
 * A section whose parent is absent (filtered out by permissions, or a typo'd
 * key) stays where it is rather than disappearing from the nav entirely.
 */
export function foldNestedSections(groups: NavGroup[]): NavGroup[] {
  const cloned: NavGroup[] = groups.map((g) => ({
    group: g.group,
    items: g.items.map((s) => ({
      ...s,
      ...(s.children ? { children: [...s.children] } : {}),
    })),
  }));

  const byKey = new Map(cloned.flatMap((g) => g.items).map((s) => [s.key, s]));
  const adopted = new Set<string>();

  for (const g of cloned) {
    for (const child of g.items) {
      if (!child.parent) continue;
      const parent = byKey.get(child.parent);
      if (!parent) continue;

      // The parent's own page goes first, so its landing view stays reachable
      // once the sub-nav takes over the sidebar.
      if (!parent.children?.length) {
        parent.children = [
          { label: parent.label, href: parent.href, icon: parent.icon },
        ];
      }
      parent.children = [
        ...parent.children,
        {
          label: child.label,
          href: child.href,
          icon: child.icon,
          ...(child.badge
            ? { badge: child.badge, badgeTone: child.badgeTone }
            : {}),
        },
      ];

      // Bubble a nested badge up when the parent has none of its own —
      // otherwise nesting Inventory hides the low-stock count that is the only
      // reason anyone opens it.
      if (child.badge && !parent.badge) {
        parent.badge = child.badge;
        parent.badgeTone = child.badgeTone;
      }
      adopted.add(child.key);
    }
  }

  return cloned
    .map((g) => ({
      group: g.group,
      items: g.items.filter((s) => !adopted.has(s.key)),
    }))
    .filter((g) => g.items.length > 0);
}

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
