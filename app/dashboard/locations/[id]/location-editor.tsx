"use client";

// One location: its details, and what it is ALLOWED to do.
//
// The capability checkboxes are the point of this screen. Two rules are shown
// inline rather than as a bare disabled box, because a checkbox that refuses to
// tick with no explanation reads as a bug:
//
//   * pickup and returns need POS — someone has to hand the goods over
//   * the last location fulfilling online orders can't be switched off
//
// Both are re-enforced server-side in saveLocationCapabilities. A disabled
// checkbox is not a permission.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Lock } from "lucide-react";
import {
  saveLocationCapabilities,
  updateLocation,
  type LocationWithCapabilities,
} from "@/app/actions/location-actions";
import {
  CAPABILITY_REGISTRY,
  LOCATION_CAPABILITIES,
  LOCATION_TYPE_LABEL,
  applyCapability,
  type CapabilityMap,
  type LocationCapability,
} from "@/lib/locations/capabilities";
import { planAllows, type Plan } from "@/lib/plans";

export function LocationEditor({
  location,
  plan,
  canManage,
  isOnlyFulfilmentLocation,
}: {
  location: LocationWithCapabilities;
  plan: Plan;
  canManage: boolean;
  isOnlyFulfilmentLocation: boolean;
}) {
  const router = useRouter();
  const [caps, setCaps] = useState<CapabilityMap>(location.capabilities);
  const [pending, start] = useTransition();

  const dirty = LOCATION_CAPABILITIES.some(
    (c) => caps[c] !== location.capabilities[c],
  );

  // The shop's street address. Nothing collected this before, so a shopper was
  // told to collect from a named shop and never told where it was.
  const addr = (location.address ?? {}) as Record<string, string>;
  const [form, setForm] = useState({
    line1: addr.line1 ?? "",
    line2: addr.line2 ?? "",
    city: addr.city ?? "",
    state: addr.state ?? "",
    postalCode: addr.postalCode ?? "",
  });
  const [savingAddr, setSavingAddr] = useState(false);
  const addrDirty = (
    ["line1", "line2", "city", "state", "postalCode"] as const
  ).some((k) => form[k] !== (addr[k] ?? ""));

  const saveAddress = async () => {
    setSavingAddr(true);
    // Send the location's other fields back unchanged: updateLocation replaces
    // the whole row, and sanitizeInput defaults a missing type to "shop" —
    // which would silently turn a warehouse into a shop.
    const res = await updateLocation(location.id, {
      name: location.name,
      type: location.type,
      gstin: location.gstin,
      stateCode: location.stateCode,
      receiptPrefix: location.receiptPrefix,
      address: {
        line1: form.line1.trim(),
        line2: form.line2.trim(),
        city: form.city.trim(),
        state: form.state.trim(),
        postalCode: form.postalCode.trim(),
      },
    });
    setSavingAddr(false);
    if (res.error) toast.error(res.error);
    else {
      toast.success("Address saved");
      router.refresh();
    }
  };

  /** Why this capability can't be changed right now, or null. */
  const blockedReason = (cap: LocationCapability): string | null => {
    const def = CAPABILITY_REGISTRY[cap];
    if (def.minPlan && !planAllows(plan, def.minPlan)) {
      return `Available on the ${def.minPlan} plan.`;
    }
    const missing = (def.requires ?? []).filter((d) => !caps[d]);
    if (missing.length > 0) {
      return `Turn on ${missing.map((m) => CAPABILITY_REGISTRY[m].label).join(" and ")} first.`;
    }
    if (
      cap === "online_fulfil" &&
      caps.online_fulfil &&
      isOnlyFulfilmentLocation
    ) {
      return "This is the only location that fulfils online orders.";
    }
    return null;
  };

  const toggle = (cap: LocationCapability, next: boolean) =>
    // Cascade a switch-off to whatever depended on it, so the boxes never
    // disagree with what the server will store.
    setCaps((c) => applyCapability(c, cap, next));

  const save = () =>
    start(async () => {
      const res = await saveLocationCapabilities(location.id, caps);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Capabilities saved");
      router.refresh();
    });

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header flex items-start justify-between gap-4">
        <div>
          <Link
            href="/dashboard/locations"
            className="mb-2 inline-flex items-center gap-1.5 text-sm text-[#5b6472] transition-colors hover:text-[#111827]"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
            Locations
          </Link>
          <h1 className="text-xl font-semibold text-[#111827]">
            {location.name}
          </h1>
          <p className="mt-1 text-sm text-[#5b6472]">
            {LOCATION_TYPE_LABEL[location.type] ?? location.type}
            {location.isDefault && " · Main location"}
          </p>
        </div>
      </header>

      <section className="mt-5 max-w-2xl rounded-xl border border-[#e5e5e5] bg-white p-5">
        <h2 className="font-semibold text-[#111827]">Address</h2>
        <p className="mt-1 text-sm text-[#5b6472]">
          Shown to shoppers choosing where to collect, and on the invoice.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(
            [
              ["line1", "Street address", "sm:col-span-2"],
              ["line2", "Apartment, unit, floor (optional)", "sm:col-span-2"],
              ["city", "City", ""],
              ["state", "State", ""],
              ["postalCode", "Postcode", ""],
            ] as const
          ).map(([key, label, span]) => (
            <div key={key} className={span}>
              <label
                htmlFor={`loc-${key}`}
                className="mb-1 block text-xs font-medium text-[#5b6472]"
              >
                {label}
              </label>
              <input
                id={`loc-${key}`}
                value={form[key]}
                disabled={!canManage}
                onChange={(e) =>
                  setForm((f) => ({ ...f, [key]: e.target.value }))
                }
                className="w-full rounded-lg border border-[rgba(17,24,39,0.12)] bg-white px-3 py-2 text-sm text-[#111827] outline-none transition-colors placeholder:text-[#9ca3af] focus:border-[#111827] disabled:opacity-60"
              />
            </div>
          ))}
        </div>

        {canManage && (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={!addrDirty || savingAddr}
              onClick={saveAddress}
              className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {savingAddr && <Loader2 className="h-4 w-4 animate-spin" />}
              Save address
            </button>
          </div>
        )}
      </section>

      <section className="mt-5 max-w-2xl rounded-xl border border-[#e5e5e5] bg-white p-5">
        <h2 className="font-semibold text-[#111827]">Capabilities</h2>
        <p className="mt-1 text-sm text-[#5b6472]">
          What this location is allowed to do.
        </p>

        <div className="mt-4 space-y-3">
          {LOCATION_CAPABILITIES.map((cap) => {
            const def = CAPABILITY_REGISTRY[cap];
            const reason = blockedReason(cap);
            // A reason blocks turning it ON; the "only fulfilment location"
            // reason blocks turning it OFF. Both are locks.
            const locked = !canManage || reason !== null;
            return (
              <label
                key={cap}
                className={`flex gap-3 rounded-lg border border-[#e5e5e5] p-3 ${
                  locked
                    ? "opacity-70"
                    : "cursor-pointer hover:bg-[#111827]/[0.02]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={caps[cap]}
                  disabled={locked}
                  onChange={(e) => toggle(cap, e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#111827]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-[#111827]">
                    {def.label}
                    {def.minPlan && !planAllows(plan, def.minPlan) && (
                      <Lock
                        className="h-3 w-3 text-[#9aa1ab]"
                        strokeWidth={2}
                      />
                    )}
                  </span>
                  <span className="block text-xs text-[#5b6472]">
                    {def.description}
                  </span>
                  {reason && (
                    <span className="mt-1 block text-xs font-medium text-[#9aa1ab]">
                      {reason}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>

        {canManage && (
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={!dirty || pending}
              onClick={() => setCaps(location.capabilities)}
              className="rounded-lg border border-[#e5e5e5] px-4 py-2 text-sm font-medium text-[#5b6472] transition-colors hover:bg-[#111827]/5 disabled:opacity-50"
            >
              Reset
            </button>
            <button
              type="button"
              disabled={!dirty || pending}
              onClick={save}
              className="inline-flex items-center gap-2 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save capabilities
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
