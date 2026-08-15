"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { inviteUser } from "@/app/actions/invite-user";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader2, UserPlus } from "lucide-react";

export function InviteUserDialog({
  className,
  label = "Add User",
  locations = [],
}: {
  className?: string;
  label?: string;
  size?: "default" | "sm" | "lg";
  /** The store's shops. Empty for a single-location store, which hides the
   *  field entirely — a scope picker with one option is a decision nobody has
   *  to make. */
  locations?: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!firstName.trim()) {
      setError("First name is required.");
      return;
    }

    const formData = new FormData();
    formData.set("firstName", firstName.trim());
    formData.set("lastName", lastName.trim());
    formData.set("email", email);
    formData.set("role", role);
    // ★ append, not set — the field is multi-value, and the action reads it
    // with getAll. Skipped for a superadmin, who is unrestricted by definition.
    if (role !== "superadmin") {
      for (const id of locationIds) formData.append("locationIds", id);
    }

    startTransition(async () => {
      const result = await inviteUser(formData);
      if (result.error) {
        setError(result.error);
      } else {
        toast.success("Invitation sent", {
          description: `An invite has been sent to ${email}`,
        });
        setOpen(false);
        setFirstName("");
        setLastName("");
        setEmail("");
        setRole("member");
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={className}>
        <UserPlus className="h-4 w-4" />
        {label}
      </DialogTrigger>
      <DialogContent className="gap-6 p-8 sm:max-w-[520px] overflow-y-auto max-h-[90vh]">
        <DialogHeader className="space-y-2 p-0">
          <DialogTitle className="text-[20px] font-semibold">
            Invite user
          </DialogTitle>
          <p className="text-muted-foreground text-[14px]">
            Send an invitation to a new team member.
          </p>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="invite-first-name"
                className="text-[14px] font-medium"
              >
                First name <span className="text-[var(--dash-red)]">*</span>
              </Label>
              <Input
                id="invite-first-name"
                type="text"
                placeholder="John"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={isPending}
                className="h-11 px-3 text-[14px]"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label
                htmlFor="invite-last-name"
                className="text-[14px] font-medium"
              >
                Last name
              </Label>
              <Input
                id="invite-last-name"
                type="text"
                placeholder="Doe (optional)"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={isPending}
                className="h-11 px-3 text-[14px]"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-email" className="text-[14px] font-medium">
              Email address <span className="text-[var(--dash-red)]">*</span>
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="user@company.com"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isPending}
              className="h-11 px-3 text-[14px]"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-role" className="text-[14px] font-medium">
              Role <span className="text-[var(--dash-red)]">*</span>
            </Label>
            <Select
              value={role}
              onValueChange={(val) => setRole(val ?? "member")}
              disabled={isPending}
            >
              <SelectTrigger id="invite-role" className="h-11 px-3 text-[14px]">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Admin</SelectItem>
                <SelectItem value="superadmin">Superadmin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* ★ Hidden for a superadmin: they see every shop by definition, so
              a picker there would imply a restriction that does not apply.
              Hidden for a single-location store for the same reason. */}
          {locations.length > 1 && role !== "superadmin" && (
            <div className="flex flex-col gap-2">
              <Label className="text-[14px] font-medium">Locations</Label>
              <p className="-mt-1 text-[12.5px] text-[var(--dash-text-3)]">
                Which shops they can see. Leave all unticked for full access to
                every location.
              </p>
              <div className="flex flex-col gap-1.5 rounded-md border border-[var(--dash-border)] p-3">
                {locations.map((l) => {
                  const checked = locationIds.includes(l.id);
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
                          setLocationIds((ids) =>
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
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-[var(--dash-red)]/30 bg-[var(--dash-red)]/10 px-4 py-3">
              <p className="text-[14px] font-medium text-[var(--dash-red)]">
                {error}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                "Send invite"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
