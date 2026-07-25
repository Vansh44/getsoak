"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  LogOut,
  ShoppingBag,
  MapPin,
  LayoutDashboard,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import { posLock } from "@/app/actions/pos-auth-actions";
import { authorizeThisDevice } from "@/app/actions/pos-auth-actions";
import { toast } from "sonner";
import { IdleLock } from "./idle-lock";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  cashier: "Cashier",
};

export function RegisterHome({
  name,
  role,
  source,
  locationName,
  deviceAuthorized,
  canAuthorizeDevice,
  locations,
  idleLockMinutes,
}: {
  name: string;
  role: string;
  source: "owner" | "operator";
  locationName: string;
  deviceAuthorized: boolean;
  canAuthorizeDevice: boolean;
  locations: { id: string; name: string }[];
  idleLockMinutes: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [authLocation, setAuthLocation] = useState(locations[0]?.id ?? "");

  const lock = () =>
    start(async () => {
      await posLock();
      router.replace("/pos/login");
      router.refresh();
    });

  const authorize = () =>
    start(async () => {
      const res = await authorizeThisDevice(authLocation);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("This device is now authorized for POS");
      router.refresh();
    });

  const showAuthorizeCard = canAuthorizeDevice && !deviceAuthorized;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Only PIN operators auto-lock: an owner on their own machine isn't the
          walked-away-from-a-shared-till risk this guards against. */}
      {source === "operator" && <IdleLock minutes={idleLockMinutes} />}
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <ShoppingBag className="h-5 w-5" strokeWidth={2} />
          Register
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-sm text-white/70">
            <MapPin className="h-4 w-4" strokeWidth={2} />
            {locationName}
          </span>
          <span className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm">
            <span className="font-medium">{name}</span>
            <span className="text-white/50">{ROLE_LABEL[role] ?? role}</span>
          </span>
          {source === "operator" ? (
            <button
              type="button"
              onClick={lock}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/20 disabled:opacity-50"
            >
              <LogOut className="h-4 w-4" strokeWidth={2} />
              Lock
            </button>
          ) : (
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/20"
            >
              <LayoutDashboard className="h-4 w-4" strokeWidth={2} />
              Dashboard
            </Link>
          )}
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-md text-center">
          {/* Owner-only: authorize this device so staff can sign in here. */}
          {showAuthorizeCard && (
            <div className="mb-6 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-5 text-left">
              <div className="flex items-center gap-2 font-semibold text-amber-200">
                <ShieldCheck className="h-5 w-5" strokeWidth={2} />
                Authorize this device for staff
              </div>
              <p className="mt-1 text-sm text-white/70">
                Your staff can only sign into POS on a device you&apos;ve
                authorized. Authorize this one so cashiers and managers can log
                in here — their personal phones won&apos;t work.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <select
                  value={authLocation}
                  onChange={(e) => setAuthLocation(e.target.value)}
                  className="rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none"
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
                  disabled={pending || !authLocation}
                  className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-[#0b0f14] transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {pending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Authorize this device
                </button>
              </div>
            </div>
          )}

          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white/10">
            <ShoppingBag className="h-8 w-8" strokeWidth={1.75} />
          </div>
          <h1 className="mt-5 text-xl font-semibold">You&apos;re signed in</h1>
          <p className="mt-2 text-sm text-white/60">
            {name} · {ROLE_LABEL[role] ?? role} · {locationName}
          </p>
          <p className="mt-6 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
            The sell screen — product grid, barcode scanning, cart, cash &amp;
            card tender, and thermal receipts — arrives in Phase 2.
          </p>
        </div>
      </main>
    </div>
  );
}
