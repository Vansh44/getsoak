"use client";

// The register's one navigation, mounted once in app/pos/layout.tsx.
//
// ★ IT IS THE SHELL, NOT A WIDGET — it takes `children`. The top bar and the
// drawer sit at different points in the tree, so a component that rendered only
// one of them would leave each screen to place the other. That is per-page
// opt-in, which is exactly how the idle lock ended up missing from five of seven
// screens.
//
// ★ ONE HAMBURGER, EVERY WIDTH (owner's call, 2026-08-16). This shipped as a
// 76px rail above `lg` and a drawer below it, on the reasoning that a hidden
// menu costs a tap on every switch and till work is muscle memory. In use that
// traded wrong: the register is HORIZONTALLY constrained — the product grid and
// the cart split the width, and on an iPad the rail was costing a column of
// products on the one screen a cashier spends all day in — while the tap it
// saved was for screens visited a few times a shift. So the rail is gone and
// the drawer serves both, which also means ONE navigation to reason about
// rather than two that could drift.
//
// ★ THE TOP BAR NOW OWNS THE TITLE, at every width rather than below `lg`.
// PosScreen used to draw its own on `lg`, which would have been a second bar
// stacked under this one — and its title was the nav label in every case
// anyway. It keeps the subtitle, which is the part this cannot know.
//
// The destinations and their gating come from lib/pos/nav.ts. Nothing here
// decides who may go where; this file only draws it.

import { useCallback, useEffect, useState, useTransition } from "react";
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
import { usePoll } from "@/lib/pos/use-poll";
import { fetchPickupCount } from "@/lib/pos/live";
import { publishPickupCount, usePickupBadge } from "@/lib/pos/pickup-badge";

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

  // ── The badge, kept live ──────────────────────────────────────────────────
  // A collection arrives from the storefront, so nothing the cashier does makes
  // it appear. This is mounted in the layout, so the count follows them onto
  // /pos/sell — the screen they are on when one lands.
  //
  // A screen that reads the queue publishes the count it already has, and says
  // so — see lib/pos/pickup-badge.ts. While one is, this stops asking for a fact
  // it would be fetching twice, and the badge tracks the list exactly instead of
  // lagging it by up to an interval.
  const shared = usePickupBadge();
  const waiting = shared.count ?? ordersWaiting;

  // A navigation can re-render the layout with a newer server count. Publish it
  // into the same store the queue and nav poll use; two competing state slots
  // are what let a released queue value permanently shadow later poll results.
  useEffect(() => publishPickupCount(ordersWaiting), [ordersWaiting]);

  usePoll(
    useCallback(
      async (run) => {
        const res = await fetchPickupCount(run.signal);
        // null = we could not tell (lapsed session, blip, offline). Keeping the
        // last known number beats flickering to zero, which reads as work
        // vanishing off a queue.
        if (!res || !run.isCurrent()) return undefined;
        const moved = shared.count !== res.count;
        publishPickupCount(res.count);
        return moved;
      },
      [shared.count],
    ),
    // ★ Backs off while the count is unchanged: a shop taking two collections a
    // day should not pay what a busy one does. Any change — or coming back to
    // the tab — resets it to the base interval at once.
    { enabled: !shared.owned, backOff: true },
  );

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
  const badgeFor = (key: PosNavKey) => (key === "pickups" ? waiting : 0);

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
      {/* ── Content, under the one top bar ───────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/10 px-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open the register menu"
            aria-expanded={open}
            className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Menu className="h-6 w-6" strokeWidth={2} />
            {/* ★ THE COUNT, NOT A DOT. With the rail gone this is the only place
                the number appears, and "some collections are waiting" is a much
                weaker prompt than "3 are". It sits on the closed menu because a
                queue nobody can see is a queue nobody works. */}
            {waiting > 0 && (
              <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-emerald-500 px-1 text-center text-[10px] font-bold leading-[18px] text-black">
                {waiting > 99 ? "99+" : waiting}
              </span>
            )}
          </button>
          <span className="truncate text-base font-semibold">
            {activeItem?.label ?? "Register"}
          </span>
          <span className="ml-auto flex min-w-0 items-center gap-3 truncate pr-1 text-xs text-white/50">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              <MapPin className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              <span className="truncate">{locationName}</span>
            </span>
            {/* Who is signed in used to live in the rail's footer. It is not
                decoration on a shared till: a cashier who walks up to a machine
                someone else left unlocked should be able to see that at a
                glance. Dropped on a phone, where the width is not there. */}
            <span
              className="hidden min-w-0 truncate border-l border-white/10 pl-3 sm:block"
              title={`${operatorName} · ${ROLE_LABEL[role] ?? role}`}
            >
              {operatorName}
            </span>
          </span>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </div>

      {/* ── The drawer ───────────────────────────────────────────────────── */}
      {open && (
        <div className="fixed inset-0 z-50">
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
