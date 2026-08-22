import { notFound } from "next/navigation";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { getPosState, getStoreLocations } from "@/lib/pos/locations";
import { getStoreSettings } from "@/lib/settings/resolve";
import { resolvePosOperator } from "@/lib/pos/operator";
import { isIdleLockExempt } from "@/lib/pos/permissions";
import { posNavFor } from "@/lib/pos/nav";
import { countPickupsWaiting } from "@/lib/pos/pickup-count";
import { IdleLock } from "./idle-lock";
import { PosNav } from "./pos-nav";
import "./pos.css";

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
      <div className="pos-root flex min-h-screen items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-lg font-semibold">
            Point of Sale isn&apos;t available
          </h1>
          <p className="mt-2 text-sm text-[var(--pos-ink-2)]">
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

  // ★ AND SO DOES THE NAVIGATION, FOR THE IDENTICAL REASON. Every screen used
  // to carry its own: /pos/sell had four links crammed into its header beside
  // six other controls, the other five had a back arrow to /pos and nothing
  // else, and /pos was a launcher whose entire content was "You're signed in".
  // Stock to the cash drawer took three taps, and the collections queue was
  // reachable only from a tile that rendered when it was non-empty — so a
  // manager could not open it to mark the box in their hands as ready.
  //
  // Signed out, there is nothing to navigate: the login, registration and reset
  // screens get the plain shell, exactly as the idle lock does.
  if (!operator) {
    return <div className="pos-root min-h-screen">{children}</div>;
  }

  const locking = !isIdleLockExempt(operator.role);
  const [settings, locations, ordersWaiting] = await Promise.all([
    locking ? getStoreSettings() : Promise.resolve(null),
    getStoreLocations(operator.storeId),
    // One indexed COUNT, deliberately — see lib/pos/pickup-count.ts. This runs
    // on every POS page load including /pos/sell, so it must not become the
    // queue read.
    countPickupsWaiting(operator.storeId, operator.locationId),
  ]);
  const idleLockMinutes = settings
    ? Number(settings["pos.idleLockMinutes"]) || 10
    : 0;
  const locationName =
    locations.find((l) => l.id === operator.locationId)?.name ?? "Location";

  return (
    <PosNav
      items={posNavFor(operator.role)}
      operatorName={operator.name}
      role={operator.role}
      locationName={locationName}
      source={operator.source}
      ordersWaiting={ordersWaiting}
    >
      {locking && <IdleLock minutes={idleLockMinutes} />}
      {children}
    </PosNav>
  );
}
