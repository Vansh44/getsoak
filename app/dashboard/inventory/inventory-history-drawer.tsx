"use client";

import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  getMovements,
  type SkuRow,
  type StockMovementRow,
} from "@/app/actions/inventory-actions";
import { Loader2 } from "lucide-react";

export function InventoryHistoryDrawer({
  open,
  onOpenChange,
  sku,
  locationId,
  locationName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sku: SkuRow;
  locationId: string | null;
  locationName: string;
}) {
  const [movements, setMovements] = useState<StockMovementRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let mounted = true;

    async function fetchMovements() {
      setLoading(true);
      setError(null);
      const res = await getMovements(
        sku.productId,
        sku.variantId,
        1,
        locationId,
      );
      if (!mounted) return;
      setLoading(false);
      if (res.error) {
        setError(res.error);
      } else {
        setMovements(res.movements);
      }
    }

    fetchMovements();

    return () => {
      mounted = false;
    };
  }, [locationId, open, sku.productId, sku.variantId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="mb-6">
          <SheetTitle>Stock history</SheetTitle>
          <SheetDescription className="mt-2 flex flex-col items-start gap-2">
            <span className="text-sm font-medium text-foreground">
              {sku.name} {sku.variantName ? `(${sku.variantName})` : ""}
            </span>
            <span className="font-mono text-[11px] bg-muted text-muted-foreground px-2 py-1 rounded-md font-semibold tracking-wider">
              {sku.sku || "NO-SKU"}
            </span>
            <span className="text-xs text-muted-foreground">
              Changes at {locationName}
            </span>
          </SheetDescription>
        </SheetHeader>

        {loading ? (
          <div className="flex justify-center items-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="p-4 text-sm text-destructive bg-destructive/10 rounded-lg font-medium">
            {error}
          </div>
        ) : movements.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-center border-2 border-dashed rounded-xl border-border bg-muted/20">
            <p className="text-sm font-medium text-foreground">
              No stock movements found.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Stock changes will appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {movements.map((m) => (
              <div
                key={m.id}
                className="flex flex-col gap-3 p-4 rounded-xl border border-border bg-card shadow-sm transition-all hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
                    <span className="font-semibold text-sm text-foreground capitalize">
                      {m.reason.replace(/_/g, " ")}
                    </span>
                    <span className="text-[11px] text-muted-foreground font-medium">
                      {new Intl.DateTimeFormat("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(m.created_at))}
                    </span>
                    {m.location_name && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {m.location_name}
                      </span>
                    )}
                  </div>
                  <span
                    className={`font-mono text-xs font-bold px-2 py-1 rounded-md shrink-0 ${
                      m.delta > 0
                        ? "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400"
                        : m.delta < 0
                          ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {m.delta > 0 ? "+" : ""}
                    {m.delta}
                  </span>
                </div>

                <div className="flex items-start justify-between gap-2 text-xs">
                  <div className="text-muted-foreground flex-1 min-w-0 flex flex-col gap-1">
                    {m.order_id && (
                      <span>
                        Order ID:{" "}
                        <span className="font-mono font-medium text-foreground">
                          {m.order_id.slice(0, 8)}...
                        </span>
                      </span>
                    )}
                    {m.note && (
                      <span className="italic break-words">
                        &quot;{m.note}&quot;
                      </span>
                    )}
                    {!m.order_id && !m.note && <span>System Update</span>}
                  </div>
                  <div className="font-medium text-muted-foreground bg-muted/50 px-2 py-1 rounded-md whitespace-nowrap shrink-0">
                    Balance:{" "}
                    <span className="font-mono font-bold text-foreground ml-1">
                      {m.balance_after}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
