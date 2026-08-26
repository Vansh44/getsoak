"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  UsersRound,
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
import { deleteUserGroup } from "@/app/actions/user-group-actions";
import { groupBadgeClass, type UserGroup } from "./shared";

type Props = {
  groups: UserGroup[];
  canManage?: boolean;
  planLocked?: boolean;
};

const BASE = "/dashboard/users/user_groups";

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function GroupsManagementView({
  groups,
  canManage = true,
  planLocked = false,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<UserGroup | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return groups;
    const q = search.toLowerCase();
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.description ?? "").toLowerCase().includes(q),
    );
  }, [groups, search]);

  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteUserGroup(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Group deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>User Groups</h1>
          <p>Segment customers to target coupons and marketing emails</p>
        </div>
        {canManage && (
          <Link
            href={`${BASE}/new`}
            className="dash-btn dash-btn-primary shrink-0"
          >
            <Plus className="h-4 w-4" />
            New group
          </Link>
        )}
      </header>

      {planLocked ? (
        <div className="dash-card mb-3.5 flex items-center justify-between gap-3 px-4 py-3.5 text-[13px]">
          <span>
            Customer groups are available on Basic and Pro. Your existing
            groups, members and coupon links are retained and will become
            editable again after an upgrade.
          </span>
          <Link
            href="/dashboard/plans"
            className="dash-btn dash-btn-primary shrink-0"
          >
            View plans
          </Link>
        </div>
      ) : null}

      <div className="dash-toolbar">
        <div className="dash-toolbar-actions ml-auto">
          <label className="dash-search-bar">
            <Search className="h-4 w-4 shrink-0 opacity-50" />
            <input
              type="text"
              placeholder="Search groups..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">Groups</div>
            <div className="dash-card-sub">
              {filtered.length} {filtered.length === 1 ? "group" : "groups"}
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <UsersRound className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">
              {search ? "No groups match your search" : "No groups yet"}
            </div>
            <p className="dash-empty-text">
              {search
                ? "Try a different search term."
                : "Create a group, then add customers to it."}
            </p>
            {!search && canManage && (
              <Link href={`${BASE}/new`} className="dash-btn dash-btn-primary">
                <Plus className="h-4 w-4" />
                New group
              </Link>
            )}
          </div>
        ) : (
          <table className="dash-table dash-table-wide">
            <thead>
              <tr>
                <th>Group</th>
                <th>Members</th>
                <th>Created</th>
                {canManage && <th className="dash-col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span
                        className={`dash-badge ${groupBadgeClass(g.color)}`}
                      >
                        {g.name}
                      </span>
                    </div>
                    {g.description && (
                      <div className="dash-cell-sub mt-1">{g.description}</div>
                    )}
                  </td>
                  <td>
                    {canManage ? (
                      <Link
                        href={`${BASE}/${g.id}/members`}
                        className="dash-cell-title hover:text-[#4f46e5] hover:underline"
                      >
                        {g.member_count}{" "}
                        {g.member_count === 1 ? "member" : "members"}
                      </Link>
                    ) : (
                      <span className="dash-cell-title">
                        {g.member_count}{" "}
                        {g.member_count === 1 ? "member" : "members"}
                      </span>
                    )}
                  </td>
                  <td className="text-muted">{formatDate(g.created_at)}</td>
                  {canManage && (
                    <td className="dash-col-actions">
                      <DropdownMenu>
                        <DropdownMenuTrigger className="dash-row-menu">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="min-w-[180px]"
                        >
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() =>
                              router.push(`${BASE}/${g.id}/members`)
                            }
                          >
                            <UsersRound className="mr-2 h-4 w-4" />
                            Manage members
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => router.push(`${BASE}/${g.id}/edit`)}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            className="cursor-pointer"
                            onClick={() => setDeleteTarget(g)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              ))}
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
            <DialogTitle>Delete group</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{deleteTarget?.name}&rdquo;? Members aren&rsquo;t
              deleted, but any coupons restricted to this group will revert to
              their remaining groups (or become public if none are left). This
              can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
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
    </div>
  );
}
