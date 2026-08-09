import { notFound } from "next/navigation";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";
import { getStoreSettings } from "@/lib/settings/resolve";
import { resolvePosOperator } from "@/lib/pos/operator";
import { isIdleLockExempt } from "@/lib/pos/permissions";
import { IdleLock } from "./idle-lock";

export const metadata = { title: "Register — Point of Sale" };

// The POS app shell. Lives OUTSIDE the (storefront) route group, so it gets only
// the root layout — its own chrome, no storefront header/footer. Gates on an
// active store + Pro plan + pos.enabled; the operator gate (→ /pos/login) is in
// the pages so /pos/login itself stays reachable.
export default async function PosLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const store = await getCurrentStoreOrNull();
  if (!store) notFound();

  const state = getPosState(store);
  if (!state.posAvailable || !state.posEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0b0f14] p-6 text-white">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">
            Point of Sale isn&apos;t available
          </h1>
          <p className="mt-2 text-sm text-white/60">
            This store hasn&apos;t enabled POS. A store owner can turn it on
            from the dashboard.
          </p>
        </div>
      </div>
    );
  }

  // ★ THE IDLE LOCK BELONGS HERE, NOT ON EACH PAGE. It was per-page opt-in, and
  // five of the seven screens never opted in — including the three that matter
  // most: /pos/returns issues refunds, /pos/inventory adjusts stock and
  // /pos/shift moves cash, so the till was left unlocked exactly where walking
  // away costs the most. A control that every new page has to remember is one
  // the next page will forget; in the layout it cannot be missed.
  //
  // No operator means /pos/login, /pos/register or /pos/reset — nothing to lock,
  // and mounting a timer that redirects to the login page from the login page is
  // how you get a loop. The superadmin stays exempt (isIdleLockExempt): it is
  // their own shop, and posLock would sign them out of the dashboard too.
  const operator = await resolvePosOperator();
  const locking = !!operator && !isIdleLockExempt(operator.role);
  const idleLockMinutes = locking
    ? Number((await getStoreSettings())["pos.idleLockMinutes"]) || 10
    : 0;

  return (
    <div className="min-h-screen bg-[#0b0f14] text-white">
      {locking && <IdleLock minutes={idleLockMinutes} />}
      {children}
    </div>
  );
}
