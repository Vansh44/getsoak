import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { CounterClient } from "../counter-client";

// The returns door.
//
// ★ ITS OWN RAIL ENTRY, BUT NOT ITS OWN LOOKUP. A cashier holding goods a
// customer has just handed back would not think to tap "Pickups", so returns
// needs a door with its own name. What it must NOT have is a second search:
// that is exactly what was merged away, because a customer hands over a number
// without announcing which kind of visit it is. Both doors run the same query
// and find the same things — they differ only in what is on screen BEFORE you
// search, and there is no returns queue at a till.
//
// Gated on `refund`, so a cashier never sees the entry (posNavFor filters on
// the same capability) and cannot reach the screen by typing the URL. That was
// this route's gate before the merge; it comes back with it.

export const dynamic = "force-dynamic";
export const metadata = { title: "Returns — Register" };

export default async function PosReturnsPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");
  // Not a redirect to /pos: a manager sending a cashier here should see WHY it
  // refused, and the till has no other way to say so.
  if (!posCan(operator.role, "refund")) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <p className="mx-auto max-w-md rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 py-6 text-center text-sm text-[var(--pos-ink-2)]">
          You don&apos;t have permission to take returns. Ask a manager.
        </p>
      </div>
    );
  }

  // No queue read: a return starts when someone walks in, so there is nothing
  // waiting to fetch. `initial` is empty and the screen opens on its prompt.
  return (
    <CounterClient
      mode="returns"
      initial={[]}
      error={null}
      canRefund
      canFulfilPickup={posCan(operator.role, "fulfil_pickup")}
    />
  );
}
