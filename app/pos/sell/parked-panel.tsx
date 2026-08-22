"use client";

// The held-sales list. Opened from the register when a cart is waiting.
//
// ★ WHAT IT SHOWS IS WHAT LETS YOU FIND ONE. A held cart is picked out under
// pressure with a customer standing there, so each row leads with the label the
// cashier gave it — or, failing that, its size and who held it — and its AGE.
// A list of identical "Untitled" rows is the same as no list.

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Clock, Trash2, X } from "lucide-react";
import {
  discardParkedSale,
  resumeParkedSale,
  type ParkedSale,
} from "@/app/actions/pos-park-actions";
import { parkedAge, parkedSaleLabel } from "@/lib/pos/park";

export function ParkedPanel({
  sales,
  cartHasItems,
  onResume,
  onChanged,
  onClose,
}: {
  sales: ParkedSale[];
  /** Resuming replaces the cart, so a non-empty one earns a confirm. */
  cartHasItems: boolean;
  onResume: (sale: ParkedSale) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function handleResume(sale: ParkedSale) {
    // ★ Resuming REPLACES what is on screen. Silently discarding a cart the
    // cashier has already scanned into is the one unrecoverable thing this
    // panel could do.
    if (
      cartHasItems &&
      !window.confirm(
        "The current sale will be cleared to bring this one back. Hold it first if you need it.",
      )
    )
      return;

    setBusy(sale.id);
    const res = await resumeParkedSale(sale.id);
    setBusy(null);
    if (res.error || !res.sale) {
      // Commonly "someone else resumed it" — a real race at a two-till counter,
      // so the list is refreshed rather than left showing a row that is gone.
      toast.error(res.error ?? "Couldn't resume that sale.");
      startTransition(onChanged);
      return;
    }
    onResume(res.sale);
    onClose();
  }

  async function handleDiscard(sale: ParkedSale) {
    if (
      !window.confirm(
        `Discard "${parkedSaleLabel(sale)}"? The items go back on the shelf — nothing was ever held for them.`,
      )
    )
      return;
    setBusy(sale.id);
    const res = await discardParkedSale(sale.id);
    setBusy(null);
    if (res.error) return toast.error(res.error);
    toast.success("Held sale discarded.");
    startTransition(onChanged);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16">
      <div className="w-full max-w-md rounded-2xl border border-[var(--pos-border)] bg-[var(--pos-bg)] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">
            Held sales{sales.length > 0 ? ` (${sales.length})` : ""}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {sales.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-[var(--pos-ink-3)]">
            Nothing is on hold at this counter.
          </p>
        ) : (
          <div className="max-h-[60vh] space-y-1.5 overflow-y-auto">
            {sales.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-xl border border-[var(--pos-border)] px-3 py-2.5"
              >
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => handleResume(s)}
                  className="min-w-0 flex-1 text-left disabled:opacity-50"
                >
                  <span className="block truncate text-sm font-medium">
                    {parkedSaleLabel(s)}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--pos-ink-3)]">
                    <Clock className="h-3 w-3" />
                    {parkedAge(s.createdAt)}
                    <span aria-hidden>·</span>
                    {s.items} item{s.items === 1 ? "" : "s"}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => handleDiscard(s)}
                  aria-label={`Discard ${parkedSaleLabel(s)}`}
                  className="shrink-0 rounded-lg p-2 text-[var(--pos-ink-3)] transition-colors hover:bg-[var(--pos-danger-soft)] hover:text-[var(--pos-danger)] disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Said plainly, because the alternative — assuming a hold reserves
            stock — is how a cashier promises something that then sells. */}
        <p className="mt-3 text-center text-xs text-[var(--pos-ink-3)]">
          Holding a sale doesn&apos;t reserve stock. Prices and availability are
          checked again when it&apos;s completed.
        </p>
      </div>
    </div>
  );
}
