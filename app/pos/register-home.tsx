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
  Banknote,
  Boxes,
  PackageCheck,
  Receipt,
  RotateCcw,
} from "lucide-react";
import { posLock } from "@/app/actions/pos-auth-actions";
import { endSession } from "@/lib/auth/firebase-client";
import { authorizeThisDevice } from "@/app/actions/pos-auth-actions";
import { toast } from "sonner";
import { IdleLock } from "./idle-lock";
import {
  isIdleLockExempt,
  posCan,
  type PosActorRole,
} from "@/lib/pos/permissions";

const ROLE_LABEL: Record<string, string> = {
  // "superadmin" is the person whose shop it is; "owner" is the pseudo-role for
  // a dashboard admin they delegated POS access to, so calling THAT one "Owner"
  // on a receipt-facing screen would be wrong.
  superadmin: "Owner",
  owner: "Admin",
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
  pickupWaiting,
}: {
  name: string;
  role: PosActorRole;
  source: "owner" | "operator";
  locationName: string;
  deviceAuthorized: boolean;
  canAuthorizeDevice: boolean;
  locations: { id: string; name: string }[];
  idleLockMinutes: number;
  pickupWaiting: number;
}) {
  const router = useRouter();
  // A cashier sells; taking money back is a manager's job (posCan).
  const canRefund = posCan(role, "refund");
  const [pending, start] = useTransition();
  const [authLocation, setAuthLocation] = useState(locations[0]?.id ?? "");

  const lock = () =>
    start(async () => {
      await posLock();
      // Also sign the Firebase SDK out locally, so nothing can re-mint a
      // session for the person who just walked away.
      await endSession();
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
      {/* Everyone but the superadmin auto-locks. This used to key off `source`,
          which exempted a delegated dashboard admin as well — but they may be
          standing at exactly the shared counter this guards, and their session
          reaches further than a cashier's. */}
      {!isIdleLockExempt(role) && <IdleLock minutes={idleLockMinutes} />}
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

          {/* Selling needs an authorized device: an owner on an un-authorized
              machine can administer POS but not ring a sale here. */}
          {deviceAuthorized ? (
            <Link
              href="/pos/sell"
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white transition-colors hover:bg-emerald-500"
            >
              <ShoppingBag className="h-5 w-5" strokeWidth={2} />
              Start selling
            </Link>
          ) : (
            <p className="mt-6 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
              Authorize this device above to start selling on it.
            </p>
          )}

          {role !== "cashier" && (
            <Link
              href="/pos/inventory"
              className="mt-3 ml-2 inline-flex items-center gap-2 rounded-xl bg-white/10 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-white/20"
            >
              <Boxes className="h-4 w-4" strokeWidth={2} />
              Stock
            </Link>
          )}

          {pickupWaiting > 0 && (
            <Link
              href="/pos/pickups"
              className="mt-3 ml-2 inline-flex items-center gap-2 rounded-xl bg-white/10 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-white/20"
            >
              <PackageCheck className="h-4 w-4" strokeWidth={2} />
              Collections
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-semibold text-emerald-300">
                {pickupWaiting}
              </span>
            </Link>
          )}

          <Link
            href="/pos/sales"
            className="mt-3 ml-2 inline-flex items-center gap-2 rounded-xl bg-white/10 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-white/20"
          >
            <Receipt className="h-4 w-4" strokeWidth={2} />
            Sales
          </Link>

          {/* Returns has its own front door now: a customer bringing an ONLINE
              order back has an order number, not a receipt from this shop, so
              they can't be found by browsing this till's sales. */}
          {canRefund && (
            <Link
              href="/pos/returns"
              className="mt-3 ml-2 inline-flex items-center gap-2 rounded-xl bg-white/10 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-white/20"
            >
              <RotateCcw className="h-4 w-4" strokeWidth={2} />
              Returns
            </Link>
          )}

          <Link
            href="/pos/shift"
            className="mt-3 ml-2 inline-flex items-center gap-2 rounded-xl bg-white/10 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-white/20"
          >
            <Banknote className="h-4 w-4" strokeWidth={2} />
            Cash drawer
          </Link>
        </div>
      </main>
    </div>
  );
}
