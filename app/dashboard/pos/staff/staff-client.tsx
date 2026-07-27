"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, Pencil, Trash2, Loader2, X, Mail } from "lucide-react";
import {
  inviteStaff,
  updateStaff,
  resendInvite,
  setStaffActive,
  deleteStaff,
  type PosStaffRow,
} from "@/app/actions/pos-staff-actions";

interface LocationOpt {
  id: string;
  name: string;
}

interface FormState {
  id: string | null; // null = inviting
  name: string;
  email: string;
  role: "cashier" | "manager";
  locationIds: string[];
}

const BLANK: FormState = {
  id: null,
  name: "",
  email: "",
  role: "cashier",
  locationIds: [],
};

const INPUT_CLS =
  "w-full rounded-lg border border-[rgba(17,24,39,0.12)] bg-white px-3 py-2 text-sm text-[#111827] outline-none transition-colors placeholder:text-[#9ca3af] focus:border-[#111827] disabled:bg-[#f6f7f9] disabled:text-[#9aa1ab]";

export function StaffClient({
  initialStaff,
  locations,
  canManage,
}: {
  initialStaff: PosStaffRow[];
  locations: LocationOpt[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<FormState | null>(null);

  const locName = (id: string) =>
    locations.find((l) => l.id === id)?.name ?? "";

  const openCreate = () => setForm({ ...BLANK });
  const openEdit = (s: PosStaffRow) =>
    setForm({
      id: s.id,
      name: s.name,
      email: s.email,
      role: s.role,
      locationIds: [...s.locationIds],
    });

  const toggleLoc = (id: string) =>
    setForm((f) =>
      f
        ? {
            ...f,
            locationIds: f.locationIds.includes(id)
              ? f.locationIds.filter((x) => x !== id)
              : [...f.locationIds, id],
          }
        : f,
    );

  const save = () => {
    if (!form) return;
    start(async () => {
      if (form.id) {
        const res = await updateStaff(form.id, {
          name: form.name,
          role: form.role,
          locationIds: form.locationIds,
        });
        if (res.error) {
          toast.error(res.error);
          return;
        }
        toast.success("Staff updated");
      } else {
        const res = await inviteStaff({
          name: form.name,
          email: form.email,
          role: form.role,
          locationIds: form.locationIds,
        });
        if (res.error) {
          toast.error(res.error);
          return;
        }
        toast.success("Invitation sent");
      }
      setForm(null);
      router.refresh();
    });
  };

  const resend = (s: PosStaffRow) =>
    start(async () => {
      const res = await resendInvite(s.id);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Invitation resent");
    });

  const toggleActive = (s: PosStaffRow) =>
    start(async () => {
      const res = await setStaffActive(s.id, !s.active);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      router.refresh();
    });

  const remove = (s: PosStaffRow) => {
    if (!confirm(`Remove "${s.name}"? Their account will be deleted.`)) return;
    start(async () => {
      const res = await deleteStaff(s.id);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Staff removed");
      router.refresh();
    });
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header flex items-start justify-between gap-4">
        <div>
          <h1>POS Staff</h1>
          <p>
            Invite cashiers and managers. They finish setup from an email link
            (verify phone, set a password + 8-digit PIN) and can only access
            /pos on an authorized device — never the dashboard.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openCreate}
            disabled={pending}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <UserPlus className="h-4 w-4" strokeWidth={2} />
            Invite staff
          </button>
        )}
      </header>

      <div className="mt-5 max-w-3xl space-y-3">
        {initialStaff.length === 0 && (
          <p className="rounded-xl border border-dashed border-[#e5e5e5] bg-white p-6 text-center text-sm text-[#9aa1ab]">
            No staff yet. Invite a cashier or manager to get started.
          </p>
        )}
        {initialStaff.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between rounded-xl border border-[#e5e5e5] bg-white p-4"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[#111827]">{s.name}</span>
                <span className="rounded-full bg-[#111827]/5 px-2 py-0.5 text-[11px] font-semibold capitalize text-[#5b6472]">
                  {s.role}
                </span>
                {s.status === "invited" && (
                  <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-blue-600">
                    Invited
                  </span>
                )}
                {!s.active && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600">
                    Inactive
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-[#5b6472]">
                {s.email} ·{" "}
                {s.locationIds.length
                  ? s.locationIds.map(locName).filter(Boolean).join(", ")
                  : "No locations"}
              </div>
            </div>
            {canManage && (
              <div className="flex items-center gap-1">
                {s.status === "invited" && (
                  <button
                    type="button"
                    onClick={() => resend(s)}
                    disabled={pending}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[#5b6472] transition-colors hover:bg-[#f2f3f5]"
                  >
                    <Mail className="h-3.5 w-3.5" strokeWidth={2} />
                    Resend
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => toggleActive(s)}
                  disabled={pending}
                  className="rounded-md px-2 py-1 text-xs font-medium text-[#5b6472] transition-colors hover:bg-[#f2f3f5]"
                >
                  {s.active ? "Deactivate" : "Activate"}
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(s)}
                  className="rounded-md p-2 text-[#5b6472] transition-colors hover:bg-[#f2f3f5] hover:text-[#111827]"
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={() => remove(s)}
                  className="rounded-md p-2 text-[#b42318] transition-colors hover:bg-[#fef3f2]"
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {form && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={() => !pending && setForm(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-bold text-[#111827]">
                {form.id ? "Edit staff" : "Invite staff"}
              </h2>
              <button
                type="button"
                onClick={() => setForm(null)}
                className="rounded-md p-1.5 text-[#5b6472] hover:bg-[#f2f3f5]"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[#5b6472]">
                  Name
                </span>
                <input
                  className={INPUT_CLS}
                  value={form.name}
                  maxLength={80}
                  placeholder="e.g. Priya"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[#5b6472]">
                  Email {form.id && "(can't be changed)"}
                </span>
                <input
                  className={INPUT_CLS}
                  value={form.email}
                  type="email"
                  disabled={!!form.id}
                  placeholder="staff@example.com"
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-[#5b6472]">
                  Role
                </span>
                <select
                  className={INPUT_CLS}
                  value={form.role}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      role: e.target.value as "cashier" | "manager",
                    })
                  }
                >
                  <option value="cashier">Cashier — ring sales</option>
                  <option value="manager">
                    Manager — sales, refunds, inventory
                  </option>
                </select>
              </label>

              <div>
                <span className="mb-1 block text-xs font-medium text-[#5b6472]">
                  Locations
                </span>
                <div className="flex flex-wrap gap-2">
                  {locations.map((l) => {
                    const on = form.locationIds.includes(l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => toggleLoc(l.id)}
                        className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                          on
                            ? "border-[#111827] bg-[#111827] text-white"
                            : "border-[rgba(17,24,39,0.15)] text-[#5b6472] hover:bg-[#f2f3f5]"
                        }`}
                      >
                        {l.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setForm(null)}
                disabled={pending}
                className="rounded-lg px-3.5 py-2 text-sm font-medium text-[#5b6472] hover:bg-[#f2f3f5] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={
                  pending ||
                  !form.name.trim() ||
                  (!form.id && !form.email.includes("@"))
                }
                className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                {form.id ? "Save" : "Send invite"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
