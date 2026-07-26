import { describe, it, expect } from "vitest";
import {
  DEFAULT_ROUTING,
  ineligibleTargets,
  isRoutingMode,
  normalizeRouting,
  selectRecipients,
  type RoutableRecipient,
} from "./routing";

const owner: RoutableRecipient = { id: "uid-owner", roleSlug: "superadmin" };
const ops: RoutableRecipient = { id: "uid-ops", roleSlug: "ops" };
const packer: RoutableRecipient = { id: "uid-packer", roleSlug: "ops" };
const eligible = [owner, ops, packer];

describe("normalizeRouting", () => {
  it("defaults to the permission-derived set", () => {
    expect(normalizeRouting({})).toEqual(DEFAULT_ROUTING);
  });

  it("keeps a valid role rule", () => {
    expect(
      normalizeRouting({ routing: "roles", target_roles: ["ops", "finance"] }),
    ).toEqual({ mode: "roles", roles: ["ops", "finance"], admins: [] });
  });

  it("keeps a valid people rule", () => {
    expect(
      normalizeRouting({ routing: "admins", target_admins: ["uid-ops"] }),
    ).toEqual({ mode: "admins", roles: [], admins: ["uid-ops"] });
  });

  // An unfinished selection must not black-hole a store's order alerts.
  it("falls back to permission when a targeted mode selects nobody", () => {
    expect(normalizeRouting({ routing: "roles", target_roles: [] })).toEqual(
      DEFAULT_ROUTING,
    );
    expect(normalizeRouting({ routing: "admins", target_admins: [] })).toEqual(
      DEFAULT_ROUTING,
    );
  });

  it("ignores junk stored in the column", () => {
    expect(normalizeRouting({ routing: "everyone" })).toEqual(DEFAULT_ROUTING);
    expect(normalizeRouting({ routing: 42 })).toEqual(DEFAULT_ROUTING);
    expect(normalizeRouting({ routing: "roles", target_roles: "ops" })).toEqual(
      DEFAULT_ROUTING,
    );
  });

  it("drops non-strings, blanks and duplicates from a target list", () => {
    expect(
      normalizeRouting({
        routing: "roles",
        target_roles: ["ops", "ops", "", "  ", 7, null, "finance"],
      }),
    ).toEqual({ mode: "roles", roles: ["ops", "finance"], admins: [] });
  });

  it("caps an absurdly long target list", () => {
    const many = Array.from({ length: 250 }, (_, i) => `role-${i}`);
    const rule = normalizeRouting({ routing: "roles", target_roles: many });
    expect(rule.roles).toHaveLength(100);
  });

  it("recognises modes", () => {
    expect(isRoutingMode("permission")).toBe(true);
    expect(isRoutingMode("admins")).toBe(true);
    expect(isRoutingMode("everyone")).toBe(false);
  });
});

describe("selectRecipients", () => {
  it("returns everyone eligible by default", () => {
    expect(selectRecipients(eligible)).toEqual(eligible);
    expect(selectRecipients(eligible, DEFAULT_ROUTING)).toEqual(eligible);
  });

  it("narrows to the named roles", () => {
    const picked = selectRecipients(eligible, {
      mode: "roles",
      roles: ["ops"],
      admins: [],
    });
    expect(picked.map((r) => r.id)).toEqual(["uid-ops", "uid-packer"]);
  });

  it("narrows to the named people", () => {
    const picked = selectRecipients(eligible, {
      mode: "admins",
      roles: [],
      admins: ["uid-packer"],
    });
    expect(picked.map((r) => r.id)).toEqual(["uid-packer"]);
  });

  // ── The rule that matters ────────────────────────────────────────────────
  // A notification is a preview of the thing itself, so routing must never
  // become a side channel around the permission gate.
  it("cannot add someone who isn't already eligible", () => {
    const picked = selectRecipients(eligible, {
      mode: "admins",
      roles: [],
      admins: ["uid-blog-editor", "uid-ops"],
    });
    expect(picked.map((r) => r.id)).toEqual(["uid-ops"]);
  });

  it("cannot add a whole role that isn't eligible", () => {
    const picked = selectRecipients(eligible, {
      mode: "roles",
      roles: ["blogger"],
      admins: [],
    });
    expect(picked).toEqual([]);
  });

  it("never returns anyone outside the eligible set, for any rule", () => {
    const allowed = new Set(eligible.map((r) => r.id));
    const rules = [
      DEFAULT_ROUTING,
      { mode: "roles" as const, roles: ["ops", "ghost"], admins: [] },
      { mode: "admins" as const, roles: [], admins: ["uid-owner", "ghost"] },
    ];
    for (const rule of rules) {
      for (const picked of selectRecipients(eligible, rule)) {
        expect(allowed).toContain(picked.id);
      }
    }
  });

  it("leaves the input untouched", () => {
    const before = [...eligible];
    selectRecipients(eligible, { mode: "roles", roles: ["ops"], admins: [] });
    expect(eligible).toEqual(before);
  });
});

describe("ineligibleTargets", () => {
  it("names people who were picked but can't receive the event", () => {
    expect(
      ineligibleTargets(eligible, {
        mode: "admins",
        roles: [],
        admins: ["uid-ops", "uid-blog-editor"],
      }),
    ).toEqual(["uid-blog-editor"]);
  });

  it("is empty when every pick is eligible", () => {
    expect(
      ineligibleTargets(eligible, {
        mode: "admins",
        roles: [],
        admins: ["uid-ops"],
      }),
    ).toEqual([]);
  });

  it("only applies to people-targeting", () => {
    expect(
      ineligibleTargets(eligible, {
        mode: "roles",
        roles: ["ghost"],
        admins: [],
      }),
    ).toEqual([]);
  });
});
