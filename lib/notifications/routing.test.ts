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
    ).toEqual({
      mode: "roles",
      scope: "store" as const,
      roles: ["ops", "finance"],
      admins: [],
    });
  });

  it("keeps a valid people rule", () => {
    expect(
      normalizeRouting({ routing: "admins", target_admins: ["uid-ops"] }),
    ).toEqual({
      mode: "admins",
      scope: "store" as const,
      roles: [],
      admins: ["uid-ops"],
    });
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
    ).toEqual({
      mode: "roles",
      scope: "store" as const,
      roles: ["ops", "finance"],
      admins: [],
    });
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
      scope: "store" as const,
      roles: ["ops"],
      admins: [],
    });
    expect(picked.map((r) => r.id)).toEqual(["uid-ops", "uid-packer"]);
  });

  it("narrows to the named people", () => {
    const picked = selectRecipients(eligible, {
      mode: "admins",
      scope: "store" as const,
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
      scope: "store" as const,
      roles: [],
      admins: ["uid-blog-editor", "uid-ops"],
    });
    expect(picked.map((r) => r.id)).toEqual(["uid-ops"]);
  });

  it("cannot add a whole role that isn't eligible", () => {
    const picked = selectRecipients(eligible, {
      mode: "roles",
      scope: "store" as const,
      roles: ["blogger"],
      admins: [],
    });
    expect(picked).toEqual([]);
  });

  it("never returns anyone outside the eligible set, for any rule", () => {
    const allowed = new Set(eligible.map((r) => r.id));
    const rules = [
      DEFAULT_ROUTING,
      {
        mode: "roles" as const,
        scope: "store" as const,
        roles: ["ops", "ghost"],
        admins: [],
      },
      {
        mode: "admins" as const,
        scope: "store" as const,
        roles: [],
        admins: ["uid-owner", "ghost"],
      },
    ];
    for (const rule of rules) {
      for (const picked of selectRecipients(eligible, rule)) {
        expect(allowed).toContain(picked.id);
      }
    }
  });

  it("leaves the input untouched", () => {
    const before = [...eligible];
    selectRecipients(eligible, {
      mode: "roles",
      scope: "store" as const,
      roles: ["ops"],
      admins: [],
    });
    expect(eligible).toEqual(before);
  });
});

describe("ineligibleTargets", () => {
  it("names people who were picked but can't receive the event", () => {
    expect(
      ineligibleTargets(eligible, {
        mode: "admins",
        scope: "store" as const,
        roles: [],
        admins: ["uid-ops", "uid-blog-editor"],
      }),
    ).toEqual(["uid-blog-editor"]);
  });

  it("is empty when every pick is eligible", () => {
    expect(
      ineligibleTargets(eligible, {
        mode: "admins",
        scope: "store" as const,
        roles: [],
        admins: ["uid-ops"],
      }),
    ).toEqual([]);
  });

  it("only applies to people-targeting", () => {
    expect(
      ineligibleTargets(eligible, {
        mode: "roles",
        scope: "store" as const,
        roles: ["ghost"],
        admins: [],
      }),
    ).toEqual([]);
  });
});

// Phase D+ — location scope COMPOSES with the mode; it never becomes a fourth
// one, and it can only ever narrow.
describe("selectRecipients — location scope", () => {
  const owner = { id: "uid-owner", roleSlug: "superadmin", locationIds: null };
  const delhi = {
    id: "uid-delhi",
    roleSlug: "ops",
    locationIds: ["loc-delhi"],
  };
  const mumbai = {
    id: "uid-mumbai",
    roleSlug: "ops",
    locationIds: ["loc-mumbai"],
  };
  const unassigned = { id: "uid-new", roleSlug: "ops", locationIds: null };
  const all = [owner, delhi, mumbai, unassigned];
  const scoped = { ...DEFAULT_ROUTING, scope: "event_location" as const };

  it("changes nothing under the default store scope", () => {
    expect(selectRecipients(all, DEFAULT_ROUTING, "loc-delhi")).toHaveLength(4);
  });

  // THE point of the feature: Mumbai's manager stops being emailed about a
  // Delhi sale.
  it("keeps only staff assigned to the event's location", () => {
    const got = selectRecipients(all, scoped, "loc-delhi").map((r) => r.id);
    expect(got).toContain("uid-delhi");
    expect(got).not.toContain("uid-mumbai");
  });

  // Absence is not restriction — the same contract as lib/locations/scope.ts.
  it("still reaches unrestricted staff", () => {
    const got = selectRecipients(all, scoped, "loc-delhi").map((r) => r.id);
    expect(got).toContain("uid-owner");
    expect(got).toContain("uid-new");
  });

  // An online order before fulfilment routing, a blog comment, a plan change:
  // narrowing by a location it doesn't have would black-hole the alert.
  it("does not narrow an event with no location", () => {
    expect(selectRecipients(all, scoped, null)).toHaveLength(4);
    expect(selectRecipients(all, scoped)).toHaveLength(4);
  });

  it("composes with a targeted mode rather than replacing it", () => {
    const rule = {
      mode: "admins" as const,
      scope: "event_location" as const,
      roles: [],
      admins: ["uid-delhi", "uid-mumbai"],
    };
    // Named BOTH, but only the one at that location is reached.
    expect(selectRecipients(all, rule, "loc-delhi").map((r) => r.id)).toEqual([
      "uid-delhi",
    ]);
  });

  it("never widens beyond what the mode selected", () => {
    const rule = {
      mode: "admins" as const,
      scope: "event_location" as const,
      roles: [],
      admins: ["uid-delhi"],
    };
    const got = selectRecipients(all, rule, "loc-delhi");
    expect(got.map((r) => r.id)).toEqual(["uid-delhi"]);
  });
});

describe("normalizeRouting — scope", () => {
  it("defaults to store", () => {
    expect(normalizeRouting({}).scope).toBe("store");
    expect(normalizeRouting({ routing_scope: "nonsense" }).scope).toBe("store");
  });

  it("accepts event_location", () => {
    expect(normalizeRouting({ routing_scope: "event_location" }).scope).toBe(
      "event_location",
    );
  });

  // Scope is independent of mode, so it must survive a mode that falls back to
  // the default for having no targets chosen.
  it("survives a mode falling back", () => {
    const r = normalizeRouting({
      routing: "roles",
      target_roles: [],
      routing_scope: "event_location",
    });
    expect(r.mode).toBe("permission");
    expect(r.scope).toBe("event_location");
  });
});
