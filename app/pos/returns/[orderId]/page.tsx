import { redirect, notFound } from "next/navigation";
import { resolvePosOperator } from "@/lib/pos/operator";
import { getReturnableSale } from "@/app/actions/pos-return-actions";
import { ReturnClient } from "./return-client";

export const dynamic = "force-dynamic";

export default async function ReturnPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const operator = await resolvePosOperator();
  if (!operator) redirect("/pos/login");

  const { sale, error } = await getReturnableSale(orderId);
  if (!sale) {
    if (error?.toLowerCase().includes("permission")) {
      return (
        // No background of its own — the shell already paints one, and this
        // used to lay `bg-neutral-950` over it.
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <p className="mx-auto max-w-md rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-white/70">
            {error}
          </p>
        </div>
      );
    }
    notFound();
  }
  return <ReturnClient sale={sale} />;
}
