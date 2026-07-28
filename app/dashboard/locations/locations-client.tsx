"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MapPin, Plus, Pencil, Trash2, Loader2, X } from "lucide-react";
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
}: {
  initialLocations: LocationWithCapabilities[];
  plan: Plan;
  canManage: boolean;
  locationsIncluded: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<FormState | null>(null);

  const count = initialLocations.length;
  const atCap = count >= locationsIncluded;

  const openCreate = () => setForm({ ...BLANK });
  const openEdit = (l: LocationWithCapabilities) =>
    setForm({
      id: l.id,
      name: l.name,
      type: l.type,
      gstin: l.gstin ?? "",
      stateCode: l.stateCode ?? "",
      receiptPrefix: l.receiptPrefix ?? "",
    });

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
            Physical stores and warehouses. Each holds its own stock and prints
            receipts with its own GST details.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openCreate}
            disabled={atCap || pending}
            title={
              atCap
                ? `Your plan includes ${locationsIncluded} locations`
                : undefined
            }
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            Add location
          </button>
        )}
      </header>

      {initialLocations.length > 1 && (
        <Link
          href="/dashboard/locations/fulfilment"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[#111827] underline underline-offset-4"
        >
          Online fulfilment order
        </Link>
      )}

      <div className="mt-2 text-xs font-medium text-[#9aa1ab]">
        {count} of {locationsIncluded} included locations used
        {atCap && " · additional locations are ₹1,000/mo (coming soon)"}
      </div>

      <div className="mt-5 max-w-3xl space-y-3">
        {initialLocations.map((l) => (
          <div
            key={l.id}
            className="flex items-center justify-between rounded-xl border border-[#e5e5e5] bg-white p-4"
          >
            <div className="flex items-center gap-3">
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
            {canManage && (
              <div className="flex items-center gap-1">
                <Link
                  href={`/dashboard/locations/${l.id}`}
                  title="Edit location and capabilities"
                  className="rounded-lg p-2 text-[#5b6472] transition-colors hover:bg-[#111827]/5 hover:text-[#111827]"
                >
                  <Pencil className="h-4 w-4" strokeWidth={2} />
                </Link>
                <button
                  type="button"
                  hidden
                  onClick={() => openEdit(l)}
                  className="rounded-md p-2 text-[#5b6472] transition-colors hover:bg-[#f2f3f5] hover:text-[#111827]"
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" strokeWidth={2} />
                </button>
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
              </div>
            )}
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
