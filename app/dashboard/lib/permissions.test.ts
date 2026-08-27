import { describe, it, expect } from "vitest";
import {
  can,
  normalizePermissions,
  getSection,
  roleBadgeClass,
  SECTIONS,
  ROLE_COLORS,
  foldNestedSections,
  type DashboardSection,
} from "./permissions";

// can() is the central RBAC predicate. Every server-action gate (via
// getManagerUserId) and every page guard funnels through this function, so
// these tests pin down the exact authorization rules.
describe("can", () => {
  // Escape hatch — superadmins bypass the permission map entirely.
  it("superadmin always passes", () => {
    expect(can({}, "anything", "manage", true)).toBe(true);
    expect(can(null, "anything", "view", true)).toBe(true);
  });

  // No permissions → no access. Defensive default.
  it("denies when no permissions map", () => {
    expect(can(null, "products", "view")).toBe(false);
    expect(can(undefined, "products", "view")).toBe(false);
  });

  // Holding permissions on one section grants nothing on another.
  it("denies when the section is missing", () => {
    expect(can({ products: ["view"] }, "blogs", "view")).toBe(false);
  });

  // Happy path — granted action allowed.
  it("allows the exact granted action", () => {
    expect(can({ products: ["view"] }, "products", "view")).toBe(true);
    expect(can({ products: ["manage"] }, "products", "manage")).toBe(true);
  });

  // 'manage' is the stronger right and implies the ability to view. This
  // matches the role editor UI where ticking 'manage' auto-ticks 'view'.
  it("manage implies view", () => {
    expect(can({ products: ["manage"] }, "products", "view")).toBe(true);
  });

  // The reverse must NOT hold — a viewer can't manage. Critical invariant.
  it("view does NOT imply manage", () => {
    expect(can({ products: ["view"] }, "products", "manage")).toBe(false);
  });

  // An entry present but empty (e.g. cleared in the editor) means no access.
  it("denies when the granted actions list is empty", () => {
    expect(can({ products: [] }, "products", "view")).toBe(false);
  });
});

// normalizePermissions() is the input sanitiser between the DB JSON and the
// runtime predicate. It enforces the schema: only known sections, only known
// actions, only non-empty action lists.
describe("normalizePermissions", () => {
  // Defensive against garbage from old DB rows or hand-edited JSON.
  it("returns {} for non-object input", () => {
    expect(normalizePermissions(null)).toEqual({});
    expect(normalizePermissions(undefined)).toEqual({});
    expect(normalizePermissions("nope")).toEqual({});
    expect(normalizePermissions(42)).toEqual({});
  });

  // Unknown actions ('delete') and unknown sections ('bogus') are dropped —
  // we never want a typo'd action to become an unintended grant.
  it("keeps only valid actions for known sections", () => {
    const result = normalizePermissions({
      products: ["view", "manage", "delete"], // 'delete' is not a real action
      bogus: ["view"], // not a real section
    });
    expect(result.products?.sort()).toEqual(["manage", "view"]);
    expect(result.bogus).toBeUndefined();
  });

  // If the only requested actions are invalid for the section, the section
  // is omitted entirely rather than left as an empty array.
  it("omits sections whose action list is empty after filtering", () => {
    const result = normalizePermissions({
      dashboard: ["delete"], // dashboard only supports 'view'
    });
    expect(result.dashboard).toBeUndefined();
  });

  // The schema says actions are arrays; a string instead is ignored.
  it("ignores non-array values", () => {
    const result = normalizePermissions({ products: "view" });
    expect(result.products).toBeUndefined();
  });
});

// getSection() is the section-catalog lookup used by the role editor UI.
describe("getSection", () => {
  // Happy path — known keys resolve to their config.
  it("returns the matching section by key", () => {
    expect(getSection("products")?.label).toBe("Products");
    expect(getSection("blogs")?.group).toBe("Storefront");
  });

  // Unknown keys must not crash callers; return undefined.
  it("returns undefined for an unknown key", () => {
    expect(getSection("nope")).toBeUndefined();
  });

  it("keeps fulfilment reachable from the Locations panel", () => {
    expect(
      getSection("locations")?.children?.map((child) => child.href),
    ).toEqual(["/dashboard/locations", "/dashboard/locations/fulfilment"]);
  });
});

// The sidebar nests some sections under others (`parent`) so it can be
// organised by task without collapsing the permission model. These guard the
// two ways that goes wrong.
describe("section nesting", () => {
  it("every parent key refers to a real section", () => {
    const keys = new Set(SECTIONS.map((s) => s.key));
    const dangling = SECTIONS.filter((s) => s.parent && !keys.has(s.parent));
    expect(dangling.map((s) => `${s.key} -> ${s.parent}`)).toEqual([]);
  });

  // A nested section renders inside its parent's sub-nav, so a parent that is
  // itself nested would be two levels deep and simply never appear.
  it("no section nests under another nested section", () => {
    const nested = new Set(SECTIONS.filter((s) => s.parent).map((s) => s.key));
    const twoDeep = SECTIONS.filter((s) => s.parent && nested.has(s.parent));
    expect(twoDeep.map((s) => s.key)).toEqual([]);
  });

  // THE reason `parent` exists rather than reusing `children`. Children are
  // rendered with no can() check, so anything needing its own permission must
  // stay a section. If someone ever moves one of these into a parent's
  // `children` array, staff without the permission get a link that denies them.
  it("keeps separately-permissioned areas as sections, not plain children", () => {
    for (const key of ["categories", "colors", "inventory", "enquiries"]) {
      const s = getSection(key);
      expect(s, `${key} must remain a section`).toBeDefined();
      expect(s?.actions.length).toBeGreaterThan(0);
      expect(s?.parent).toBeTruthy();
    }
  });

  // Renaming a permission key silently revokes it for every existing role, so
  // the label may drift but the key may not. `ai` is labelled "Plan & billing".
  it("keeps the legacy `ai` key for the plan section", () => {
    expect(getSection("ai")?.href).toBe("/dashboard/plans");
  });
});

describe("foldNestedSections", () => {
  const sec = (
    key: string,
    extra: Partial<DashboardSection> = {},
  ): DashboardSection => ({
    key,
    label: key,
    href: `/dashboard/${key}`,
    icon: "home",
    group: "Workspace",
    actions: ["view"],
    ...extra,
  });

  it("moves a nested section into its parent's children and off the top level", () => {
    const [g] = foldNestedSections([
      {
        group: "Workspace",
        items: [sec("products"), sec("categories", { parent: "products" })],
      },
    ]);
    expect(g.items.map((i) => i.key)).toEqual(["products"]);
    // The parent's own page is inserted first so it stays reachable once the
    // sub-nav replaces the sidebar.
    expect(g.items[0].children?.map((c) => c.href)).toEqual([
      "/dashboard/products",
      "/dashboard/categories",
    ]);
  });

  // THE case the whole mechanism exists for: the permission filter runs before
  // this, so a section the viewer can't see simply isn't in the input — and it
  // must not reappear as an ungated child link.
  it("cannot surface a section the caller already filtered out", () => {
    const [g] = foldNestedSections([
      { group: "Workspace", items: [sec("products")] },
    ]);
    expect(g.items[0].children ?? []).toEqual([]);
  });

  // A nested section whose parent was filtered out must stay reachable rather
  // than vanish from the nav with no way in.
  it("leaves an orphan at the top level when its parent is absent", () => {
    const [g] = foldNestedSections([
      {
        group: "Workspace",
        items: [sec("categories", { parent: "products" })],
      },
    ]);
    expect(g.items.map((i) => i.key)).toEqual(["categories"]);
  });

  it("bubbles a nested badge up to a parent that has none", () => {
    const [g] = foldNestedSections([
      {
        group: "Workspace",
        items: [
          sec("products"),
          sec("inventory", {
            parent: "products",
            badge: "2",
            badgeTone: "amber",
          }),
        ],
      },
    ]);
    expect(g.items[0].badge).toBe("2");
    expect(g.items[0].badgeTone).toBe("amber");
    // and it survives on the child row too
    expect(g.items[0].children?.at(-1)?.badge).toBe("2");
  });

  it("does not overwrite a badge the parent already has", () => {
    const [g] = foldNestedSections([
      {
        group: "Workspace",
        items: [
          sec("orders", { badge: "12", badgeTone: "accent" }),
          sec("inventory", { parent: "orders", badge: "2" }),
        ],
      },
    ]);
    expect(g.items[0].badge).toBe("12");
  });

  // The input items come from the shared module-level SECTIONS catalog. Pushing
  // onto their `children` would grow the real catalog on every request until a
  // merchant saw the same sub-item a hundred times.
  it("never mutates the input", () => {
    const products = sec("products");
    const groups = [
      {
        group: "Workspace" as const,
        items: [products, sec("categories", { parent: "products" })],
      },
    ];
    foldNestedSections(groups);
    foldNestedSections(groups);
    expect(products.children).toBeUndefined();
    expect(groups[0].items.length).toBe(2);
  });

  it("drops a group left empty after folding", () => {
    const out = foldNestedSections([
      { group: "Workspace", items: [sec("products")] },
      { group: "Settings", items: [sec("roles", { parent: "products" })] },
    ]);
    expect(out.map((g) => g.group)).toEqual(["Workspace"]);
  });
});

// roleBadgeClass() maps a stored role color string to its CSS class. The
// badge appears next to every admin's name in the users table.
describe("roleBadgeClass", () => {
  // Verifies the mapping for both a normal color and the special 'violet'
  // which is the superadmin gold badge.
  it("returns the matching class for known colors", () => {
    expect(roleBadgeClass("blue")).toBe("dash-badge-blue");
    expect(roleBadgeClass("violet")).toBe("dash-role-super");
  });

  // Old or hand-edited rows might have unknown colors — fall back to grey
  // rather than rendering an undefined class.
  it("falls back to grey for unknown colors", () => {
    expect(roleBadgeClass("rainbow")).toBe("dash-badge-grey");
    expect(roleBadgeClass("")).toBe("dash-badge-grey");
  });
});

// Invariants on the SECTIONS catalog itself — these break if someone adds a
// duplicate or empty entry.
describe("SECTIONS catalog", () => {
  // Section keys are used as DB JSON keys in role.permissions — duplicates
  // would silently overwrite each other.
  it("has unique section keys", () => {
    const keys = SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // A section with no actions can't ever be granted — likely a config bug.
  it("every section's actions are non-empty", () => {
    for (const s of SECTIONS) {
      expect(s.actions.length).toBeGreaterThan(0);
    }
  });

  // Sanity check the role-color palette stayed in sync with the badge map.
  it("ROLE_COLORS includes expected palette", () => {
    expect(ROLE_COLORS).toContain("grey");
    expect(ROLE_COLORS).toContain("violet");
  });
});
