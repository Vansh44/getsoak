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
import { ArrowLeft, Loader2, Monitor, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import {
  authorizeThisDevice,
  replaceDevice,
  type ReplaceableDevice,
} from "@/app/actions/pos-auth-actions";

/** "3 days ago" beats a timestamp when the question is "which of these is
 *  nobody using?". Null means it has not been used since the column started
 *  being maintained — which is itself the answer. */
function lastUsed(iso: string | null): string {
  if (!iso) return "Not used recently";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Last used just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return "Last used just now";
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last used ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `Last used ${days} day${days === 1 ? "" : "s"} ago`;
}

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
  // Non-null once the location is full: the devices the owner may swap out.
  const [full, setFull] = useState<{
    cap: number;
    devices: ReplaceableDevice[];
  } | null>(null);

  const locationName =
    locations.find((l) => l.id === locationId)?.name ?? "this location";

  const authorize = () =>
    start(async () => {
      const res = await authorizeThisDevice(locationId);
      // Not an error — a question. Show the picker instead of a toast.
      if (res.atCapacity) {
        setFull(res.atCapacity);
        return;
      }
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("This device is now authorized for POS");
      router.refresh();
    });

  const swap = (device: ReplaceableDevice) => {
    // Confirmed, because it ends a working till: whoever is standing at that
    // register is signed out on their next request, mid-shift if it is running.
    if (
      !confirm(
        `Retire “${device.label || "Register"}” and authorize this device instead?\n\n${lastUsed(
          device.lastSeenAt,
        )}. That register will be signed out.`,
      )
    )
      return;
    start(async () => {
      const res = await replaceDevice(device.id, locationId);
      if (res.error) {
        toast.error(res.error);
        // The list is stale either way once a replace has been attempted.
        setFull(null);
        return;
      }
      toast.success("This device is now authorized for POS");
      setFull(null);
      router.refresh();
    });
  };

  // ── The location is full: pick one to replace ──────────────────────────────
  // Replaces the whole screen rather than appearing under it. There is exactly
  // one decision to make here, and leaving the "Authorize this device" button
  // above it — the button that just refused — is how you get someone pressing it
  // again and again.
  if (full) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="w-full max-w-lg">
          <button
            type="button"
            onClick={() => setFull(null)}
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-[var(--pos-ink-2)] transition-colors hover:text-[var(--pos-ink)]"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
            Back
          </button>
          <h1 className="text-xl font-semibold">Replace a device</h1>
          <p className="mt-2 text-sm text-[var(--pos-ink-2)]">
            {locationName} already has its {full.cap} authorized devices. Pick
            one to retire and this device takes its place — the one you choose
            is signed out of the register.
          </p>

          <ul className="mt-5 space-y-2">
            {full.devices.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-3"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--pos-surface-2)] text-[var(--pos-ink-2)]">
                  <Monitor className="h-5 w-5" strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {d.label || "Register"}
                  </div>
                  <div className="truncate text-xs text-[var(--pos-ink-3)]">
                    {lastUsed(d.lastSeenAt)}
                    {d.authorizedBy ? ` · added by ${d.authorizedBy}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => swap(d)}
                  disabled={pending}
                  className="shrink-0 rounded-lg bg-[var(--pos-accent)] px-3.5 py-2 text-sm font-semibold text-[var(--pos-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {pending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Replace"
                  )}
                </button>
              </li>
            ))}
          </ul>

          {/* Ordered least-recently-used first, but the owner decides. The
              machine picking would retire whichever till the heuristic liked,
              mid-shift, with nobody told. */}
          <p className="mt-4 text-xs text-[var(--pos-ink-3)]">
            Listed with the least recently used first. You can also manage
            devices in Dashboard → POS → Devices.
          </p>
        </div>
      </div>
    );
  }

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
            <p className="mt-2 text-center text-sm text-[var(--pos-ink-2)]">
              Your staff can only sign into POS on a device you&apos;ve
              authorized. Authorize this one so cashiers and managers can log in
              here — their personal phones won&apos;t work.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                aria-label="Location this device sells at"
                className="rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface-2)] px-3 py-2.5 text-sm outline-none"
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
                className="inline-flex items-center gap-2 rounded-xl bg-[var(--pos-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--pos-on-accent)] transition-opacity hover:opacity-90 disabled:opacity-50"
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
          <p className="mt-2 text-center text-sm text-[var(--pos-ink-2)]">
            This browser isn&apos;t an authorized POS device. The store owner
            can authorize it, or send you a pairing code from Point of
            Sale&nbsp;→&nbsp;Devices in the dashboard.
          </p>
        )}
      </div>
    </div>
  );
}
