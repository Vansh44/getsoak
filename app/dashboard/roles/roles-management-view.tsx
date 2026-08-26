"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { deleteRole } from "@/app/actions/role-actions";
import { SECTIONS, roleBadgeClass } from "../lib/permissions";
import type { Role } from "../lib/access";
import { RoleEditorDialog } from "./role-editor-dialog";

type RoleRow = Role & { member_count: number };

type Props = {
  roles: RoleRow[];
  canManage: boolean;
  planLocked?: boolean;
};

function summarize(role: RoleRow) {
  let viewable = 0;
  let manageable = 0;
  for (const section of SECTIONS) {
    const granted = role.permissions[section.key] ?? [];
    if (granted.includes("manage")) {
      manageable++;
      viewable++;
    } else if (granted.includes("view")) {
      viewable++;
    }
  }
  return { viewable, manageable };
}

export function RolesManagementView({
  roles,
  canManage,
  planLocked = false,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [deleteTarget, setDeleteTarget] = useState<RoleRow | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);

  const openEditor = (role?: Role) => {
    setEditing(role ?? null);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditing(null);
  };

  const handleSaved = () => {
    closeEditor();
    router.refresh();
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteRole(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Role deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Roles &amp; Permissions</h1>
          <p>
            Define roles and control which sections of the dashboard each one
            can access.
          </p>
        </div>
        {canManage && !planLocked && (
          <button
            className="dash-btn dash-btn-primary shrink-0"
            onClick={() => openEditor()}
          >
            <Plus className="h-4 w-4" />
            New role
          </button>
        )}
      </header>

      {planLocked ? (
        <div className="dash-card mb-3.5 flex items-center justify-between gap-3 px-4 py-3.5 text-[13px]">
          <span>
            Custom roles are available on Basic and Pro. Existing roles,
            permissions and staff assignments remain safe. You can remove an
            unused custom role, but creating or editing roles requires an
            upgrade.
          </span>
          <Link
            href="/dashboard/plans"
            className="dash-btn dash-btn-primary shrink-0"
          >
            View plans
          </Link>
        </div>
      ) : null}

      <div className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">Roles</div>
            <div className="dash-card-sub">
              {roles.length} {roles.length === 1 ? "role" : "roles"}
            </div>
          </div>
        </div>

        {roles.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <KeyRound className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">No roles yet</div>
            <p className="dash-empty-text">
              Run <code>supabase/roles_table.sql</code> to seed the system
              roles, then create your own.
            </p>
          </div>
        ) : (
          <table className="dash-table dash-table-wide">
            <thead>
              <tr>
                <th>Role</th>
                <th>Description</th>
                <th>Access</th>
                <th>Admins</th>
                <th className="dash-col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => {
                const { viewable, manageable } = summarize(role);
                return (
                  <tr key={role.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span
                          className={`dash-role-pill inline-flex items-center gap-1 ${roleBadgeClass(role.color)}`}
                        >
                          {role.slug === "superadmin" ? (
                            <Zap className="h-3.5 w-3.5" />
                          ) : (
                            <KeyRound className="h-3.5 w-3.5" />
                          )}
                          {role.name}
                        </span>
                        {role.is_system && (
                          <span className="dash-badge dash-badge-grey">
                            System
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="dash-cell-sub max-w-[320px]">
                      {role.description || "—"}
                    </td>
                    <td className="dash-cell-sub">
                      {role.slug === "superadmin" ? (
                        <span>Full access</span>
                      ) : (
                        <span>
                          {viewable} view · {manageable} manage
                        </span>
                      )}
                    </td>
                    <td className="dash-cell-sub mono">{role.member_count}</td>
                    <td className="dash-col-actions">
                      {canManage ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger className="dash-row-menu">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Actions</span>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="min-w-[160px]"
                          >
                            {!planLocked && (
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => openEditor(role)}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                            )}
                            {!role.is_system && (
                              <>
                                {!planLocked && <DropdownMenuSeparator />}
                                <DropdownMenuItem
                                  variant="destructive"
                                  className="cursor-pointer"
                                  onClick={() => setDeleteTarget(role)}
                                >
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span className="dash-cell-sub">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Delete confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete role</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deleteTarget?.name}&rdquo;? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {(deleteTarget?.member_count ?? 0) > 0 && (
            <div className="py-2">
              <p className="text-sm text-[var(--dash-amber)]">
                {deleteTarget?.member_count} admin
                {deleteTarget?.member_count === 1 ? "" : "s"} currently hold
                this role. Reassign them first.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RoleEditorDialog
        open={editorOpen}
        role={editing}
        onClose={closeEditor}
        onSaved={handleSaved}
      />
    </div>
  );
}
