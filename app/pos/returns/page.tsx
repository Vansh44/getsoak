import { redirect } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import { ReturnsLookup } from "./lookup-client";

// The BORIS front door (roadmap Step 5): a customer walks in with an order
// number or a phone, not a receipt from this shop.
export const dynamic = "force-dynamic";

export default async function ReturnsLookupPage() {
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");

  if (!posCan(operator.role, "refund")) {
    return (
      <div className="min-h-dvh bg-neutral-950 p-6 text-white">
        <p className="mx-auto max-w-md rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-white/70">
          You don&apos;t have permission to take returns. Ask a manager.
        </p>
      </div>
    );
  }

  return <ReturnsLookup />;
}
