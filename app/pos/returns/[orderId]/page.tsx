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
        <div className="min-h-dvh bg-neutral-950 p-6 text-white">
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
