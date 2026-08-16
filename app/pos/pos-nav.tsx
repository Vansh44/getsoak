"use client";

// The register's one navigation, mounted once in app/pos/layout.tsx.
//
// ★ IT IS THE SHELL, NOT A WIDGET — it takes `children`. The rail and the
// small-screen top bar sit at different points in the tree (a column beside the
// content, and a row above it), so a component that rendered only one of them
// would leave each screen to place the other. That is per-page opt-in, which is
// exactly how the idle lock ended up missing from five of seven screens.
//
// ★ RAIL ON WIDE, DRAWER ON NARROW. A hidden menu costs a tap on every switch,
// and till work is muscle memory — so where there is room the destinations stay
// on screen. Below `lg` the same list becomes the hamburger drawer: a portrait
// tablet cannot spare 76px of the product grid.
//
// The destinations and their gating come from lib/pos/nav.ts. Nothing here
// decides who may go where; this file only draws it.

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Banknote,
  Boxes,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  PackageCheck,
  Receipt,
  RotateCcw,
  ScanLine,
  X,
} from "lucide-react";
import { posLock } from "@/app/actions/pos-auth-actions";
import { endSession } from "@/lib/auth/firebase-client";
import {
  activePosNavKey,
  type PosNavItem,
  type PosNavKey,
} from "@/lib/pos/nav";
import type { PosActorRole } from "@/lib/pos/permissions";

/** Icons live here, not in the registry, so lib/pos/nav.ts stays free of a
 *  client dependency and can be imported by a server component or a test. */
const ICONS: Record<PosNavKey, typeof ScanLine> = {
  sell: ScanLine,
  pickups: PackageCheck,
  returns: RotateCcw,
  sales: Receipt,
  inventory: Boxes,
  shift: Banknote,
};

const ROLE_LABEL: Record<PosActorRole, string> = {
  // "superadmin" is the person whose shop it is; "owner" is the pseudo-role for
  // a dashboard admin they delegated POS access to, so calling THAT one "Owner"
  // on a counter-facing screen would be wrong.
  superadmin: "Owner",
  owner: "Admin",
  manager: "Manager",
  cashier: "Cashier",
};

export interface PosNavProps {
  items: PosNavItem[];
  operatorName: string;
  role: PosActorRole;
  locationName: string;
  /** "owner" signed in through the dashboard — they get a way back to it
   *  instead of a Lock that would sign them out of both. */
  source: "owner" | "operator";
  /** Collections waiting on this shop's shelf. 0 hides the badge entirely — a
   *  number that never moves is one people learn to ignore. */
  ordersWaiting: number;
  children: React.ReactNode;
}

export function PosNav({
  items,
  operatorName,
  role,
  locationName,
  source,
  ordersWaiting,
  children,
}: PosNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const active = activePosNavKey(pathname);
  const [pending, start] = useTransition();

  // ★ THE DRAWER IS DERIVED FROM THE ROUTE IT WAS OPENED ON, not a boolean
  // synced back to the route by an effect. Navigating away therefore closes it
  // on the SAME render — including via the browser's back button, which a
  // `setOpen(false)` in each link's onClick would miss — and there is no
  // cascading re-render, which on a till is a frame where the menu is still
  // covering the screen the cashier just asked for.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt !== null && openedAt === pathname;
  const setOpen = (next: boolean) => setOpenedAt(next ? pathname : null);

  useEffect(() => {
    if (!open) return;
    // setOpenedAt, not the setOpen wrapper: the wrapper closes over `pathname`
    // and so is a new function every render, which would either re-bind this
    // listener on each one or need to be left out of the dependency array.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenedAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const lock = () =>
    start(async () => {
      await posLock();
      // Also sign the Firebase SDK out locally, so nothing can re-mint a
      // session for the person who just walked away.
      await endSession();
      router.replace("/pos/login");
      router.refresh();
    });

  const activeItem = items.find((i) => i.key === active);
  const badgeFor = (key: PosNavKey) => (key === "pickups" ? ordersWaiting : 0);

  return (
    <div
      className="flex h-dvh overflow-hidden bg-[#0b0f14] text-white"
      // ★ Stops iOS rubber-band overscroll from revealing the page behind the
      // register. The body is near-white (globals.css), so a bounce on a till
      // flashes a white band under a dark full-screen app. Scoped to this
      // element rather than html/body: globally it would also kill
      // pull-to-refresh on the storefront, which shoppers do use.
      style={{ overscrollBehavior: "none" }}
    >
      {/* ── The rail (lg and up) ─────────────────────────────────────────── */}
      <nav
        aria-label="Register"
        className="hidden w-[76px] shrink-0 flex-col border-r border-white/10 bg-black/30 lg:flex"
      >
        <div className="flex h-14 shrink-0 items-center justify-center border-b border-white/10">
          <ScanLine className="h-5 w-5" strokeWidth={2} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
          {items.map((item) => {
            const Icon = ICONS[item.key];
            const isActive = item.key === active;
            const badge = badgeFor(item.key);
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                title={item.hint}
                className={`relative flex flex-col items-center gap-1 rounded-xl px-1 py-2.5 text-[11px] font-medium transition-colors ${
                  isActive
                    ? "bg-white/15 text-white"
                    : "text-white/55 hover:bg-white/10 hover:text-white"
                }`}
              >
                <Icon className="h-[22px] w-[22px]" strokeWidth={2} />
                {item.label}
                {badge > 0 && (
                  <span className="absolute right-1.5 top-1.5 min-w-[18px] rounded-full bg-emerald-500 px-1 text-center text-[10px] font-bold leading-[18px] text-black">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        <div className="shrink-0 border-t border-white/10 p-2 text-center">
          <div
            title={locationName}
            className="mb-1 truncate text-[10px] leading-tight text-white/40"
          >
            {locationName}
          </div>
          <div
            title={`${operatorName} · ${ROLE_LABEL[role] ?? role}`}
            className="mb-2 truncate text-[11px] font-medium leading-tight text-white/70"
          >
            {operatorName}
          </div>
          {source === "operator" ? (
            <button
              type="button"
              onClick={lock}
              disabled={pending}
              title="Lock the register"
              className="flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] font-medium text-white/55 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
            >
              <LogOut className="h-[18px] w-[18px]" strokeWidth={2} />
              Lock
            </button>
          ) : (
            <Link
              href="/dashboard"
              title="Back to the dashboard"
              className="flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-[11px] font-medium text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LayoutDashboard className="h-[18px] w-[18px]" strokeWidth={2} />
              Exit
            </Link>
          )}
        </div>
      </nav>

      {/* ── Content, with the small-screen top bar above it ───────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/10 px-2 lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open the register menu"
            aria-expanded={open}
            className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Menu className="h-6 w-6" strokeWidth={2} />
            {/* The badge rides the hamburger too: with the list collapsed, a
                queue nobody can see is a queue nobody works. */}
            {ordersWaiting > 0 && (
              <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-emerald-500" />
            )}
          </button>
          <span className="truncate text-base font-semibold">
            {activeItem?.label ?? "Register"}
          </span>
          <span className="ml-auto flex min-w-0 items-center gap-1.5 truncate pr-1 text-xs text-white/50">
            <MapPin className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <span className="truncate">{locationName}</span>
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </div>

      {/* ── The drawer (below lg) ─────────────────────────────────────────── */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close the menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/60"
          />
          <nav
            aria-label="Register"
            className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col border-r border-white/10 bg-[#12171f]"
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 pl-4 pr-2">
              <span className="flex items-center gap-2 font-semibold">
                <ScanLine className="h-5 w-5" strokeWidth={2} />
                Register
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close the menu"
                className="flex h-10 w-10 items-center justify-center rounded-xl text-white/60 hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" strokeWidth={2} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {items.map((item) => {
                const Icon = ICONS[item.key];
                const isActive = item.key === active;
                const badge = badgeFor(item.key);
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={`mb-1 flex items-center gap-3 rounded-xl px-3 py-3 transition-colors ${
                      isActive
                        ? "bg-white/15 text-white"
                        : "text-white/70 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <Icon className="h-5 w-5 shrink-0" strokeWidth={2} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">
                        {item.label}
                      </span>
                      {/* Room for it here, unlike the rail — and "Orders" alone
                          does not say that it covers collections AND returns. */}
                      <span className="block truncate text-xs text-white/45">
                        {item.hint}
                      </span>
                    </span>
                    {badge > 0 && (
                      <span className="shrink-0 rounded-full bg-emerald-500 px-2 py-0.5 text-xs font-bold text-black">
                        {badge > 99 ? "99+" : badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>

            <div className="shrink-0 border-t border-white/10 p-3">
              <div className="mb-3 px-1">
                <div className="text-sm font-medium">{operatorName}</div>
                <div className="text-xs text-white/45">
                  {ROLE_LABEL[role] ?? role} · {locationName}
                </div>
              </div>
              {source === "operator" ? (
                <button
                  type="button"
                  onClick={lock}
                  disabled={pending}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-3 text-sm font-semibold transition-colors hover:bg-white/20 disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" strokeWidth={2} />
                  Lock the register
                </button>
              ) : (
                <Link
                  href="/dashboard"
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-white/10 py-3 text-sm font-semibold transition-colors hover:bg-white/20"
                >
                  <LayoutDashboard className="h-4 w-4" strokeWidth={2} />
                  Back to dashboard
                </Link>
              )}
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
