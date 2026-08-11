"use client";

// What `/pos` shows when this browser is not yet an authorized POS device.
//
// This is ALL that is left of the old register home. The rest of that screen —
// "You're signed in" over a stack of link pills — was a launcher, and the rail
// (app/pos/pos-nav.tsx) does that job now without costing a tap on every switch.
//
// Only an owner or superadmin ever sees it: staff cannot resolve as an operator
// at all without an authorized device (lib/pos/operator.ts), so an unauthorized
// browser here is always the person who can fix it.

import { useState, useTransition } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { authorizeThisDevice } from "@/app/actions/pos-auth-actions";

export function AuthorizeDevice({
  canAuthorize,
  locations,
}: {
  canAuthorize: boolean;
  locations: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");

  const authorize = () =>
    start(async () => {
      const res = await authorizeThisDevice(locationId);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("This device is now authorized for POS");
      router.refresh();
    });

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-400/15 text-amber-200">
          <ShieldCheck className="h-7 w-7" strokeWidth={1.75} />
        </div>
        <h1 className="text-center text-xl font-semibold">
          Authorize this device
        </h1>

        {canAuthorize ? (
          <>
            <p className="mt-2 text-center text-sm text-white/60">
              Your staff can only sign into POS on a device you&apos;ve
              authorized. Authorize this one so cashiers and managers can log in
              here — their personal phones won&apos;t work.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                aria-label="Location this device sells at"
                className="rounded-xl border border-white/15 bg-white/10 px-3 py-2.5 text-sm outline-none"
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id} className="text-black">
                    {l.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={authorize}
                disabled={pending || !locationId}
                className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#0b0f14] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                Authorize this device
              </button>
            </div>
          </>
        ) : (
          // A delegated dashboard admin: authorize_device is SUPERADMIN_ONLY,
          // because a device grant is permanent until revoked and is what lets
          // staff take money at all.
          <p className="mt-2 text-center text-sm text-white/60">
            This browser isn&apos;t an authorized POS device. The store owner
            can authorize it, or send you a pairing code from Point of
            Sale&nbsp;→&nbsp;Devices in the dashboard.
          </p>
        )}
      </div>
    </div>
  );
}
