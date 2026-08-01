"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { posLock } from "@/app/actions/pos-auth-actions";
import { endSession } from "@/lib/auth/firebase-client";

// Auto-lock an idle register. The real-world risk on a shared till is a cashier
// walking away mid-shift and the next person selling under their name — this
// closes that, and shows a short countdown so nobody is surprised mid-sale.
//
// SCOPE, honestly: this is a physical-presence measure, not an authorization
// boundary. Someone who bypasses the client keeps the cookie until it expires.
// The server-side boundary remains the device gate + the per-request pos_staff
// re-validation in resolvePosOperator; when Phase 2's sale actions land they can
// enforce idle server-side too, since they already touch the DB on every action.

// How much notice an operator gets before the lock. Generous on purpose: it
// started at 20s, which read as "this thing locks in 20 seconds" — the banner is
// the only part of the timer anybody actually sees, so it gets taken for the
// whole of it — and it wasn't long enough to finish serving the customer in
// front of you and then decide to keep the session.
const WARN_SECONDS = 300;

/** The warning can never outrun the idle window itself — `pos.idleLockMinutes`
 *  goes as low as 1, and a warning longer than the window would put the banner
 *  on screen permanently. Half the window keeps a short setting usable, and
 *  gives the full WARN_SECONDS once the window is at least twice it. */
const warnMsFor = (idleMs: number) =>
  Math.min(WARN_SECONDS * 1000, Math.floor(idleMs / 2));

/** "1:58" over a minute, "45s" under it — "Locking in 118s" is arithmetic. */
function formatRemaining(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}
const ACTIVITY = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "visibilitychange",
] as const;

export function IdleLock({ minutes }: { minutes: number }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState<number | null>(null);
  // Seeded in the effect, not at render — calling Date.now() during render is
  // impure (and would be wrong under StrictMode's double-invoke anyway).
  const lastActive = useRef(0);
  const locking = useRef(false);

  useEffect(() => {
    const idleMs = Math.max(1, minutes) * 60_000;
    const warnMs = warnMsFor(idleMs);
    lastActive.current = Date.now();

    const bump = () => {
      lastActive.current = Date.now();
      setRemaining((r) => (r === null ? r : null)); // dismiss any warning
    };
    for (const ev of ACTIVITY) {
      window.addEventListener(ev, bump, { passive: true });
    }

    const tick = setInterval(() => {
      if (locking.current) return;
      const idleFor = Date.now() - lastActive.current;
      const msLeft = idleMs - idleFor;

      if (msLeft <= 0) {
        locking.current = true;
        void (async () => {
          try {
            // posLock() clears BOTH server cookies — the operator token and
            // sm_session — which is what actually locks someone whose
            // credential is a session (staff who signed in with a password, or
            // a dashboard admin). endSession() then signs the Firebase SDK out
            // IN THE PAGE, so nothing left running can re-mint a session for
            // the person who walked away. The manual "Lock" button does the
            // same two steps; an unattended till has more need of them, not
            // less.
            await posLock();
            await endSession();
          } finally {
            router.replace("/pos/login");
            router.refresh();
          }
        })();
        return;
      }
      setRemaining(msLeft <= warnMs ? Math.ceil(msLeft / 1000) : null);
    }, 1000);

    return () => {
      clearInterval(tick);
      for (const ev of ACTIVITY) window.removeEventListener(ev, bump);
    };
  }, [minutes, router]);

  if (remaining === null) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-3 bg-amber-500 px-4 py-3 text-sm font-semibold text-[#0b0f14]"
    >
      Locking in {formatRemaining(remaining)} — touch the screen to stay signed
      in
      <button
        type="button"
        onClick={() => {
          lastActive.current = Date.now();
          setRemaining(null);
        }}
        className="rounded-lg bg-[#0b0f14] px-3 py-1 text-xs font-semibold text-white"
      >
        Stay
      </button>
    </div>
  );
}
