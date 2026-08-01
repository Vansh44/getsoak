import { notFound } from "next/navigation";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";

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

  return <div className="min-h-screen bg-[#0b0f14] text-white">{children}</div>;
}
