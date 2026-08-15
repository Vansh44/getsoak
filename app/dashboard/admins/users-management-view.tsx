"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  KeyRound,
  MoreHorizontal,
  Trash2,
  UserCog,
  UserX,
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
import { InviteUserDialog } from "./invite-user-dialog";
import { setAdminLocations } from "@/app/actions/location-actions";
import { MapPin } from "lucide-react";
import { roleBadgeClass } from "../lib/permissions";
import type { Profile, RoleOption } from "./page";
import {
  deleteUser,
  changeUserRole,
  toggleUserSuspension,
} from "@/app/actions/user-management";
import {
  formatDisplayName,
  getAvatarBackground,
  getInitials,
  getLastActiveLabel,
  getStatusDisplay,
} from "../lib/dashboard-user-display";

type Props = {
  currentUserId: string;
  profiles: Profile[];
  roleOptions: RoleOption[];
  canManage?: boolean;
  /** The store's shops, for the invite dialog's scope picker. */
  locations?: { id: string; name: string }[];
  /** adminId → location ids. An admin ABSENT from this map is unrestricted —
   *  absence is not restriction (lib/locations/scope.ts). */
  bindings?: Record<string, string[]>;
};

export function UsersManagementView({
  currentUserId,
  profiles,
  roleOptions,
  canManage = true,
  locations = [],
  bindings = {},
}: Props) {
  const router = useRouter();
  const [selectedUser, setSelectedUser] = useState<Profile | null>(null);
  const [actionType, setActionType] = useState<
    "delete" | "role" | "suspend" | "locations" | null
  >(null);
  const [newRole, setNewRole] = useState<string>("member");
  const [newLocations, setNewLocations] = useState<string[]>([]);
  const [isPending, startTransition] = useTransition();

  const sortedProfiles = useMemo(
    () =>
      [...profiles].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [profiles],
  );

  const roleBySlug = useMemo(
    () => new Map(roleOptions.map((r) => [r.slug, r])),
    [roleOptions],
  );

  const roleDisplay = (slug: string) => {
    const r = roleBySlug.get(slug);
    if (r) {
      return {
        label: r.name,
        pillClass: roleBadgeClass(r.color),
        Icon: r.slug === "superadmin" ? Zap : KeyRound,
      };
    }
    // Unknown / unseeded slug.
    return { label: slug || "—", pillClass: "dash-badge-grey", Icon: KeyRound };
  };

  const handleAction = async () => {
    if (!selectedUser || !actionType) return;

    startTransition(async () => {
      let result: { error?: string; success?: boolean } = {};

      switch (actionType) {
        case "delete":
          result = await deleteUser(selectedUser.id);
          break;
        case "role":
          result = await changeUserRole(selectedUser.id, newRole);
          break;
        case "suspend":
          result = await toggleUserSuspension(
            selectedUser.id,
            !selectedUser.is_suspended,
          );
          break;
        case "locations":
          result = await setAdminLocations(selectedUser.id, newLocations);
          break;
      }

      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("User updated");
        closeDialog();
        router.refresh();
      }
    });
  };

  const closeDialog = () => {
    setActionType(null);
    setSelectedUser(null);
  };

  const openDialog = (user: Profile, type: typeof actionType) => {
    setSelectedUser(user);
    setActionType(type);
    if (type === "role") setNewRole(user.role);
    // Ticked to what they have today, so opening the dialog and saving is a
    // no-op rather than a silent reset to unrestricted.
    if (type === "locations") setNewLocations(bindings[user.id] ?? []);
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Admins</h1>
          <p>Manage dashboard access — only authorised admins</p>
        </div>
        {canManage && (
          <InviteUserDialog
            className="dash-btn dash-btn-primary shrink-0"
            label="Invite user"
            size="default"
            locations={locations}
          />
        )}
      </header>

      <div className="dash-card">
        <div className="dash-card-header">
          <div className="dash-card-title">Dashboard Admins</div>
        </div>
        <table className="dash-table dash-table-wide">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              <th>Last Active</th>
              <th>Status</th>
              <th className="dash-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedProfiles.map((profile) => {
              const displayName = formatDisplayName(
                profile.email,
                profile.first_name,
                profile.last_name,
              );
              const role = roleDisplay(profile.role);
              const status = getStatusDisplay(profile);

              return (
                <tr key={profile.id}>
                  <td>
                    <div className="dash-flex-row">
                      <div
                        className="dash-user-avatar"
                        style={{
                          background: getAvatarBackground(profile.email),
                        }}
                      >
                        {getInitials(
                          profile.email,
                          profile.first_name,
                          profile.last_name,
                        )}
                      </div>
                      {displayName}
                    </div>
                  </td>
                  <td className="text-muted">{profile.email}</td>
                  <td>
                    <span className={`dash-role-pill ${role.pillClass}`}>
                      <role.Icon className="h-3.5 w-3.5" />
                      {role.label}
                    </span>
                  </td>
                  <td className="text-dim font-mono-dash">
                    {getLastActiveLabel(profile, currentUserId)}
                  </td>
                  <td>
                    <span className={`dash-badge ${status.badgeClass}`}>
                      {status.label}
                    </span>
                  </td>
                  <td className="dash-col-actions">
                    {profile.id === currentUserId || !canManage ? (
                      <span className="text-dim text-[12px]">—</span>
                    ) : (
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
                            onClick={() => openDialog(profile, "role")}
                          >
                            <UserCog className="mr-2 h-4 w-4" />
                            Change role
                          </DropdownMenuItem>
                          {/* Only where there is a choice to make, and never
                              for a superadmin — they are unrestricted by
                              definition, so a scope editor there would imply a
                              limit that does not apply. */}
                          {locations.length > 1 &&
                            profile.role !== "superadmin" && (
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => openDialog(profile, "locations")}
                              >
                                <MapPin className="mr-2 h-4 w-4" />
                                Locations
                              </DropdownMenuItem>
                            )}
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onClick={() => openDialog(profile, "suspend")}
                          >
                            <UserX className="mr-2 h-4 w-4" />
                            {profile.is_suspended
                              ? "Un-suspend user"
                              : "Suspend user"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            className="cursor-pointer"
                            onClick={() => openDialog(profile, "delete")}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Remove user
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog
        open={actionType !== null}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>
              {actionType === "delete" && "Remove user"}
              {actionType === "role" && "Change role"}
              {actionType === "locations" && "Location access"}
              {actionType === "suspend" &&
                (selectedUser?.is_suspended
                  ? "Un-suspend user"
                  : "Suspend user")}
            </DialogTitle>
            <DialogDescription>
              {actionType === "delete" &&
                "Are you sure you want to remove this user? This cannot be undone."}
              {actionType === "role" && "Select a new role for this user."}
              {actionType === "locations" &&
                "Which shops this person can see. Untick everything for full access to all locations."}
              {actionType === "suspend" &&
                (selectedUser?.is_suspended
                  ? "This user will regain access."
                  : "This user will lose access immediately.")}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {actionType === "locations" && (
              <div className="flex flex-col gap-2">
                {locations.map((l) => {
                  const checked = newLocations.includes(l.id);
                  return (
                    <label
                      key={l.id}
                      className="flex cursor-pointer items-center gap-2.5 text-[14px]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isPending}
                        onChange={(e) =>
                          setNewLocations((ids) =>
                            e.target.checked
                              ? [...ids, l.id]
                              : ids.filter((id) => id !== l.id),
                          )
                        }
                        className="h-4 w-4 accent-[var(--dash-text)]"
                      />
                      {l.name}
                    </label>
                  );
                })}
                {/* ★ Said out loud, because "none ticked" reading as "sees
                    everything" is the opposite of what a merchant expects from
                    an empty checkbox list. It is the existing contract —
                    absence is not restriction — so the UI has to explain it
                    rather than quietly rely on it. */}
                {newLocations.length === 0 && (
                  <p className="mt-1 text-[12.5px] text-[var(--dash-text-3)]">
                    Nothing ticked — this person will see every location.
                  </p>
                )}
              </div>
            )}

            {actionType === "role" && (
              <Select
                value={newRole}
                onValueChange={(val) => val && setNewRole(val)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => (
                    <SelectItem key={r.slug} value={r.slug}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {(actionType === "delete" || actionType === "suspend") && (
              <p className="text-muted-foreground text-sm">
                User: {selectedUser?.email}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeDialog}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant={
                actionType === "delete" ||
                (actionType === "suspend" && !selectedUser?.is_suspended)
                  ? "destructive"
                  : "default"
              }
              onClick={handleAction}
              disabled={isPending}
            >
              {isPending ? "Saving..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
