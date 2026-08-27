"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MapPin, Plus, Pencil, Trash2, Loader2, X, Boxes } from "lucide-react";
import {
  createLocation,
  updateLocation,
  deleteLocation,
  type LocationInput,
} from "@/app/actions/location-actions";
import Link from "next/link";
import type { LocationWithCapabilities } from "@/app/actions/location-actions";
import {
  LOCATION_TYPES,
  LOCATION_TYPE_LABEL,
  enabledCapabilityLabels,
  type LocationType,
} from "@/lib/locations/capabilities";
import type { Plan } from "@/lib/plans";
import type { LocationBillingState } from "@/lib/billing/invoice-types";
import { LocationBillingCard } from "./location-billing-card";

interface FormState {
  id: string | null; // null = creating
  name: string;
  type: LocationType;
  gstin: string;
  stateCode: string;
  receiptPrefix: string;
}

const BLANK: FormState = {
  id: null,
  name: "",
  type: "shop",
  gstin: "",
  stateCode: "",
  receiptPrefix: "",
};

const INPUT_CLS =
  "w-full rounded-lg border border-[rgba(17,24,39,0.12)] bg-white px-3 py-2 text-sm text-[#111827] outline-none transition-colors placeholder:text-[#9ca3af] focus:border-[#111827]";

export function LocationsClient({
  initialLocations,
  plan,
  canManage,
  locationsIncluded,
  billing,
}: {
  initialLocations: LocationWithCapabilities[];
  plan: Plan;
  canManage: boolean;
  locationsIncluded: number;
  billing: LocationBillingState | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<FormState | null>(null);

  const count = initialLocations.length;
  // The ceiling is what the plan includes PLUS what the store pays for
  // (roadmap Step 5), so "Add location" stays enabled for a merchant who has
  // bought one. Falls back to the included count if the billing read failed —
  // the server enforces the real cap either way (invariant 5).
  const allowance = billing?.allowance ?? locationsIncluded;
  const atCap = count >= allowance;

  const openCreate = () => setForm({ ...BLANK });
  const save = () => {
    if (!form) return;
    const payload: LocationInput = {
      name: form.name,
      type: form.type,
      gstin: form.gstin,
      stateCode: form.stateCode,
      receiptPrefix: form.receiptPrefix,
    };
    start(async () => {
      const res = form.id
        ? await updateLocation(form.id, payload)
        : await createLocation(payload);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(form.id ? "Location updated" : "Location added");
      setForm(null);
      router.refresh();
    });
  };

  const remove = (l: LocationWithCapabilities) => {
    if (!confirm(`Delete "${l.name}"? This can't be undone.`)) return;
    start(async () => {
      const res = await deleteLocation(l.id);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Location deleted");
      router.refresh();
    });
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header flex items-start justify-between gap-4">
        <div>
          <h1>Locations</h1>
          <p>
            Set up the places that hold stock. Open a location&apos;s inventory
            to count or adjust what is physically there.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openCreate}
            disabled={atCap || pending}
            title={
              atCap
                ? `You're using all ${allowance} of your locations — add another below`
                : undefined
            }
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            Add location
          </button>
        )}
      </header>

      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href="/dashboard/inventory"
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#111827] px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          <Boxes className="h-4 w-4" strokeWidth={2} />
          Open inventory
        </Link>
      </div>

      {/* The count and the buy/release controls live together in one card —
          the line that used to sit here said "coming soon", which was the only
          thing between a merchant and a location they wanted to pay for. */}
      {billing ? (
        <LocationBillingCard state={billing} canManage={canManage} />
      ) : (
        <div className="mt-2 text-xs font-medium text-[#9aa1ab]">
          {count} of {allowance} locations used
        </div>
      )}

      <div className="mt-5 max-w-3xl space-y-3">
        {initialLocations.map((l) => (
          <div
            key={l.id}
            className="flex flex-col gap-3 rounded-xl border border-[#e5e5e5] bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#111827]/5 text-[#111827]">
                <MapPin className="h-5 w-5" strokeWidth={1.75} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[#111827]">{l.name}</span>
                  {l.isDefault && (
                    <span className="rounded-full bg-[#111827]/5 px-2 py-0.5 text-[11px] font-semibold text-[#5b6472]">
                      Main
                    </span>
                  )}
                  <span className="text-[11px] uppercase tracking-wide text-[#9aa1ab]">
                    {LOCATION_TYPE_LABEL[l.type] ?? l.type}
                  </span>
                </div>
                <div className="text-xs text-[#5b6472]">
                  {l.gstin ? `GSTIN ${l.gstin}` : "No GSTIN"}
                  {l.stateCode ? ` · State ${l.stateCode}` : ""}
                  {l.receiptPrefix ? ` · Receipts ${l.receiptPrefix}` : ""}
                </div>
                {/* What this location may DO — chips list only what actually
                    takes effect, so a Pro-gated capability on a lapsed plan
                    doesn't claim to be working. */}
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {enabledCapabilityLabels(l.capabilities, { plan }).map(
                    (label) => (
                      <span
                        key={label}
                        className="rounded-full bg-[#111827]/5 px-2 py-0.5 text-[11px] font-medium text-[#5b6472]"
                      >
                        {label}
                      </span>
                    ),
                  )}
                  {enabledCapabilityLabels(l.capabilities, { plan }).length ===
                    0 && (
                    <span className="text-[11px] text-[#9aa1ab]">
                      No capabilities enabled
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Link
                href={`/dashboard/inventory?location=${l.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#e5e5e5] px-2.5 py-2 text-xs font-medium text-[#111827] transition-colors hover:bg-[#111827]/[0.03]"
              >
                <Boxes className="h-3.5 w-3.5" strokeWidth={2} />
                View inventory
              </Link>
              {canManage && (
                <>
                  <Link
                    href={`/dashboard/locations/${l.id}`}
                    title="Edit location and capabilities"
                    className="inline-flex items-center gap-1.5 rounded-lg p-2 text-xs font-medium text-[#5b6472] transition-colors hover:bg-[#111827]/5 hover:text-[#111827]"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={2} />
                    <span className="hidden sm:inline">Edit setup</span>
                  </Link>
                  {!l.isDefault && (
                    <button
                      type="button"
                      onClick={() => remove(l)}
                      className="rounded-md p-2 text-[#b42318] transition-colors hover:bg-[#fef3f2]"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={2} />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Add / edit form */}
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
                {form.id ? "Edit location" : "Add location"}
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
              <Field label="Name">
                <input
                  className={INPUT_CLS}
                  value={form.name}
                  maxLength={80}
                  placeholder="e.g. Delhi — Connaught Place"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Field>

              <Field label="Type">
                <select
                  className={INPUT_CLS}
                  value={form.type}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      type: e.target.value as "shop" | "warehouse",
                    })
                  }
                >
                  {LOCATION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {LOCATION_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="GSTIN">
                  <input
                    className={INPUT_CLS}
                    value={form.gstin}
                    maxLength={20}
                    placeholder="Optional"
                    onChange={(e) =>
                      setForm({ ...form, gstin: e.target.value })
                    }
                  />
                </Field>
                <Field label="GST state code">
                  <input
                    className={INPUT_CLS}
                    value={form.stateCode}
                    maxLength={2}
                    placeholder="e.g. 07"
                    onChange={(e) =>
                      setForm({ ...form, stateCode: e.target.value })
                    }
                  />
                </Field>
              </div>

              <Field label="Receipt prefix">
                <input
                  className={INPUT_CLS}
                  value={form.receiptPrefix}
                  maxLength={8}
                  placeholder="e.g. DEL"
                  onChange={(e) =>
                    setForm({ ...form, receiptPrefix: e.target.value })
                  }
                />
              </Field>
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
                disabled={pending || !form.name.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                {form.id ? "Save" : "Add location"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[#5b6472]">
        {label}
      </span>
      {children}
    </label>
  );
}
