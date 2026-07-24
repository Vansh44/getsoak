"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ImageIcon, History, Minus, Plus, ArrowRight } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import type { SkuRow } from "@/app/actions/inventory-actions";

// Shopify-style reasons for a manual stock change. The label is stored as the
// movement note (setStock's 4th arg → stock_movements.note), so it shows up
// verbatim in the History drawer. "Correction" is the sensible default.
const REASONS = [
  "Correction",
  "Stock recount",
  "Received",
  "Customer return",
  "Damaged",
  "Theft or loss",
  "Other",
] as const;

const QUICK_ADJUST = [-10, -5, 5, 10, 50] as const;

// Quick, right-side inventory editor. Opened by clicking a product row — set the
// stock level (or nudge it with the ± buttons / quick chips), pick a reason, and
// save, or jump to the full movement history. Optimistic save + close is handled
// by the parent's onSave.
export function InventoryEditDrawer({
  open,
  onOpenChange,
  sku,
  onSave,
  onViewHistory,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sku: SkuRow | null;
  onSave: (sku: SkuRow, newStock: number, reason: string) => void;
  onViewHistory: (sku: SkuRow) => void;
  isPending: boolean;
}) {
  const router = useRouter();
  // The parent remounts this drawer for each opened SKU, so seeding state from
  // the current stock at mount is enough — no syncing effect needed.
  const [value, setValue] = useState(sku?.stock ?? 0);
  const [reason, setReason] = useState<string>(REASONS[0]);

  if (!sku) return null;

  const tracked = sku.trackInventory;
  const delta = value - sku.stock;
  const changed = delta !== 0;
  const nudge = (d: number) => setValue((v) => Math.max(0, v + d));

  const statusBadge = !tracked ? (
    <span className="dash-badge dash-badge-grey">Untracked</span>
  ) : sku.status === "in" ? (
    <span className="dash-badge dash-badge-green">In stock</span>
  ) : sku.status === "low" ? (
    <span className="dash-badge dash-badge-amber">Low stock</span>
  ) : (
    <span className="dash-badge dash-badge-red bg-red-100 text-red-600 dark:bg-red-900/30">
      Out of stock
    </span>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>Manage stock</SheetTitle>
          <SheetDescription>
            Set a new quantity or adjust it, then save.
          </SheetDescription>
        </SheetHeader>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {/* Product summary */}
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
              {sku.image ? (
                <Image
                  src={sku.image}
                  alt={sku.name}
                  fill
                  sizes="56px"
                  className="object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-muted-foreground">
                  <ImageIcon className="h-5 w-5" />
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {sku.name}
              </div>
              {sku.variantName && (
                <div className="truncate text-xs text-muted-foreground">
                  {sku.variantName}
                </div>
              )}
              <div className="mt-1.5 flex items-center gap-2">
                {statusBadge}
                {sku.sku && (
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide text-muted-foreground">
                    {sku.sku}
                  </span>
                )}
              </div>
            </div>
          </div>

          {tracked ? (
            <div className="mt-6 space-y-5">
              {/* Stock level — a single connected stepper (− [ N ] +) reads as
                  one control instead of buttons flung to the edges. */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  Stock level
                </label>
                <div className="flex items-stretch overflow-hidden rounded-lg border border-border bg-card shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
                  <button
                    type="button"
                    onClick={() => nudge(-1)}
                    disabled={value <= 0}
                    aria-label="Decrease by 1"
                    className="flex w-12 shrink-0 items-center justify-center border-r border-border text-muted-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <NumberField
                    value={value}
                    onValueChange={setValue}
                    allowDecimal={false}
                    aria-label="Stock level"
                    className="min-w-0 flex-1 bg-transparent py-3 text-center text-2xl font-semibold text-foreground outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => nudge(1)}
                    aria-label="Increase by 1"
                    className="flex w-12 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition hover:bg-muted"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>

                {/* Quick adjust chips */}
                <div className="mt-3 flex flex-wrap gap-2">
                  {QUICK_ADJUST.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => nudge(d)}
                      className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground transition hover:border-ring hover:bg-muted"
                    >
                      {d > 0 ? `+${d}` : d}
                    </button>
                  ))}
                </div>
              </div>

              {/* Before → after preview (only once the number changes) */}
              {changed && (
                <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3.5 py-2.5 text-sm">
                  <span className="text-muted-foreground">New available</span>
                  <span className="flex items-center gap-2 font-medium text-foreground">
                    <span className="text-muted-foreground">{sku.stock}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>{value}</span>
                    <span
                      className={`rounded-md px-1.5 py-0.5 font-mono text-xs font-bold ${
                        delta > 0
                          ? "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400"
                          : "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400"
                      }`}
                    >
                      {delta > 0 ? `+${delta}` : delta}
                    </span>
                  </span>
                </div>
              )}

              {/* Reason — stored as the movement note, shown in History */}
              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  Reason
                </label>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                >
                  {REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <div className="mt-6 rounded-xl border border-dashed border-border bg-muted/30 p-4 text-center">
              <p className="text-sm font-medium text-foreground">
                Inventory isn&apos;t tracked for this product.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Turn on &ldquo;Track inventory&rdquo; in the product editor to
                set stock levels.
              </p>
            </div>
          )}
        </div>

        {/* Pinned footer */}
        <SheetFooter className="flex-row border-t border-border px-5 py-4">
          {tracked ? (
            <Button
              className="flex-1"
              onClick={() => onSave(sku, value, reason)}
              disabled={isPending || !changed}
            >
              {isPending ? "Saving…" : "Save stock"}
            </Button>
          ) : (
            <Button
              className="flex-1"
              onClick={() =>
                router.push(`/dashboard/products/${sku.productId}`)
              }
            >
              Open product editor
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => onViewHistory(sku)}
            disabled={isPending}
          >
            <History className="mr-1.5 h-4 w-4" />
            History
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
