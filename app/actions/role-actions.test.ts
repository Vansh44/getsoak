/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  storeAllowsPlanFeature: vi.fn(async () => true),
}));

// The ported data layer: with* runners invoke the callback with the mock db.
// requireRolesManager reads via withUser; the mutations run via withService —
// both share this one mock db, so selectQueue is consumed in call order.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { createRole, updateRole, deleteRole } from "./role-actions";
import { getServerUser } from "@/lib/auth/server-user";

const validForm = {
  name: "Editor",
  description: "Can edit",
  color: "blue",
  permissions: { products: ["view", "manage"] as ("view" | "manage")[] },
};

const user = {
  id: "user-1",
  email: "a@b.c",
  phone: null,
  phoneConfirmed: true,
  metadata: {},
};

// The gate's admin-row read (superadmin passes in one select).
const SUPERADMIN = [{ role: "superadmin" }];

// Configure the shared mock db with the gate read first, then the action's
// own selects.
function setup(selectQueue: any[][], returning: any[] = [{ id: "r1" }]) {
  dbHolder.current = makeDbMock({ selectQueue, returning });
}

// role-actions.ts exposes create/update/delete for the Roles & Permissions
// section. Every call passes through requireRolesManager() — only a superadmin
// or a role granted `roles.manage` can administer roles.
describe("role-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue(user as any);
    setup([SUPERADMIN, []]);
  });

  // The shared auth gate used by all three actions, tested via createRole.
  describe("requireRolesManager", () => {
    it("rejects unauthenticated callers", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await createRole(validForm);
      expect(result.error).toMatch(/permission/i);
    });

    it("rejects callers without a profile", async () => {
      setup([[]]); // admins lookup empty
      const result = await createRole(validForm);
      expect(result.error).toMatch(/permission/i);
    });

    it("rejects a role without roles.manage permission", async () => {
      setup([[{ role: "member" }], [{ permissions: { products: ["view"] } }]]);
      const result = await createRole(validForm);
      expect(result.error).toMatch(/permission/i);
    });

    it("allows a non-superadmin role with roles.manage", async () => {
      setup([
        [{ role: "manager" }],
        [{ permissions: { roles: ["manage"] } }],
        [], // resolveUniqueSlug lookup
      ]);
      const result = await createRole(validForm);
      expect(result.success).toBe(true);
    });
  });

  describe("createRole", () => {
    it("rejects an empty name", async () => {
      const result = await createRole({ ...validForm, name: "  " });
      expect(result.error).toMatch(/name is required/i);
    });

    it("rejects a name longer than 40 chars", async () => {
      const result = await createRole({ ...validForm, name: "x".repeat(41) });
      expect(result.error).toMatch(/too long/i);
    });

    it("rejects an invalid color", async () => {
      const result = await createRole({ ...validForm, color: "rainbow" });
      expect(result.error).toMatch(/colour/i);
    });

    it("inserts with a slug derived from the name", async () => {
      setup([SUPERADMIN, []]); // gate, then resolveUniqueSlug (no collisions)
      await createRole({ ...validForm, name: "Content Editor" });
      const insert = dbHolder.current.calls.values[0];
      expect(insert.slug).toBe("content-editor");
      expect(insert.isSystem).toBe(false);
    });

    it("appends a numeric suffix when the slug is taken", async () => {
      setup([SUPERADMIN, [{ slug: "editor" }, { slug: "editor-2" }]]);
      await createRole({ ...validForm, name: "Editor" });
      expect(dbHolder.current.calls.values[0].slug).toBe("editor-3");
    });

    it("returns a friendly error on unique-violation insert", async () => {
      setup([SUPERADMIN, []]);
      dbHolder.current.db.insert = vi.fn(() => {
        throw Object.assign(new Error("dup"), { code: "23505" });
      });
      const result = await createRole(validForm);
      expect(result.error).toMatch(/already exists/i);
    });
  });

  describe("updateRole", () => {
    it("returns Role not found when the row is missing", async () => {
      setup([SUPERADMIN, []]); // gate, then existing-row lookup empty
      const result = await updateRole("missing", validForm);
      expect(result.error).toMatch(/not found/i);
    });

    // CRITICAL invariant: the superadmin role's permissions are enforced in
    // CODE, not in the DB. Edits must NOT include a permissions field.
    it("does not allow editing the superadmin role's permissions", async () => {
      setup([SUPERADMIN, [{ slug: "superadmin", is_system: true }]]);
      const result = await updateRole("super-id", validForm);
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).not.toHaveProperty("permissions");
    });

    it("updates permissions for a non-system role", async () => {
      setup([SUPERADMIN, [{ slug: "editor", is_system: false }]]);
      const result = await updateRole("editor-id", validForm);
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toHaveProperty("permissions");
    });
  });

  describe("deleteRole", () => {
    it("rejects when the role is not found", async () => {
      setup([SUPERADMIN, []]);
      const result = await deleteRole("nope");
      expect(result.error).toMatch(/not found/i);
    });

    it("refuses to delete system roles", async () => {
      setup([SUPERADMIN, [{ slug: "superadmin", is_system: true }]]);
      const result = await deleteRole("super-id");
      expect(result.error).toMatch(/system roles/i);
    });

    it("blocks deletion when admins still hold the role", async () => {
      setup([
        SUPERADMIN,
        [{ slug: "editor", is_system: false }],
        [{ n: 3 }], // holders count
      ]);
      const result = await deleteRole("editor-id");
      expect(result.error).toMatch(/3 admins still hold/i);
    });

    it("deletes a deletable role with no holders", async () => {
      setup([SUPERADMIN, [{ slug: "editor", is_system: false }], [{ n: 0 }]]);
      const result = await deleteRole("editor-id");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
    });
  });
});
