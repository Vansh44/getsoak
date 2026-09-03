"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pause, Play, Trash2 } from "lucide-react";
import {
  deleteOffer,
  setOfferStatus,
  type OfferRow,
} from "@/app/actions/offer-actions";
import type { EditorSetting } from "@/app/actions/store-settings";
import { FeatureToggles } from "../components/feature-toggles";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** What the offer actually gives, in one phrase the merchant recognises. */
function rewardLabel(o: OfferRow): string {
  if (o.rewardType === "amount_off") return `${inr(o.amount ?? 0)} off`;
  const scope = o.rewardType === "percent_off_items" ? " on items" : "";
  return `${o.percent ?? 0}% off${scope}`;
}

/** What has to be true for it to apply. */
function triggerLabel(o: OfferRow): string {
  return o.triggerType === "min_subtotal"
    ? `Over ${inr(o.minSubtotal ?? 0)}`
    : "Any order";
}

function channelLabel(channels: OfferRow["channels"]): string {
  if (channels.length === 0 || channels.length === 2) return "Online & POS";
  return channels[0] === "pos" ? "POS only" : "Online only";
}

/**
 * How an offer reaches a customer — the distinction that makes "a code is a
 * delivery method, not a kind of offer" visible in the UI (plan §2).
 */
function deliveryLabel(o: OfferRow): string {
  if (o.delivery === "automatic") return "Automatic";
  return o.code ?? "Code";
}

export function OffersView({
  offers,
  loadError,
  limit,
  activeCount,
  plan,
  settings,
  locationCount,
  canManage,
}: {
  offers: OfferRow[];
  loadError?: string;
  limit: number | null;
  activeCount: number;
  plan: string;
  settings: EditorSetting[];
  locationCount: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState<OfferRow | null>(null);

  const atCap = limit !== null && activeCount >= limit;

  const run = (fn: () => Promise<{ error?: string }>, ok: string) =>
    startTransition(async () => {
      const res = await fn();
      if (res.error) toast.error(res.error);
      else {
        toast.success(ok);
        router.refresh();
      }
    });

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <h1>Offers</h1>
          <p>
            Discount codes and automatic offers, across your online store and
            your point of sale.
          </p>
        </div>
        {canManage && (
          <Link
            href="/dashboard/offers/new"
            className="dash-btn dash-btn-primary"
          >
            <Plus size={16} /> New offer
          </Link>
        )}
      </header>

      {loadError && (
        <div className="dash-card mb-4 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          {loadError} Your offers are safe — this is a read problem, and nothing
          has changed.
        </div>
      )}

      <div className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">Offers</div>
            <div className="dash-card-sub">
              {offers.length === 0
                ? "No offers yet"
                : `${offers.length} offer${offers.length === 1 ? "" : "s"}, ${activeCount} active`}
              {limit !== null && ` · ${limit} active included in your plan`}
            </div>
          </div>
        </div>

        {atCap && (
          <p className="px-5 pb-3 text-sm text-[var(--dash-ink-2)]">
            You are using all {limit} active offers your plan includes. Pause
            one to activate another — nothing is deleted, and a paused offer
            keeps its settings and its history.
          </p>
        )}

        {offers.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--dash-ink-2)]">
            <p className="mb-1 font-medium text-[var(--dash-ink)]">
              Nothing running yet
            </p>
            <p>
              An offer can apply automatically or on a code. When several could
              apply, the one that saves the customer most wins.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="dash-table dash-table-wide">
              <thead>
                <tr>
                  <th>Offer</th>
                  <th>Gives</th>
                  <th>When</th>
                  <th>How</th>
                  <th>Where</th>
                  <th>Used</th>
                  <th>Given away</th>
                  <th>Status</th>
                  {canManage && <th className="dash-col-actions">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {offers.map((o) => (
                  <tr key={o.id}>
                    <td>
                      {canManage ? (
                        <Link
                          href={`/dashboard/offers/${o.id}/edit`}
                          className="font-medium hover:underline"
                        >
                          {o.name}
                        </Link>
                      ) : (
                        <span className="font-medium">{o.name}</span>
                      )}
                      {o.description && (
                        <div className="text-xs text-[var(--dash-ink-2)]">
                          {o.description}
                        </div>
                      )}
                    </td>
                    <td className="font-medium">{rewardLabel(o)}</td>
                    <td>{triggerLabel(o)}</td>
                    <td>{deliveryLabel(o)}</td>
                    <td>{channelLabel(o.channels)}</td>
                    <td>
                      {o.redemptionCount}
                      {o.maxRedemptions !== null && ` / ${o.maxRedemptions}`}
                      {o.maxPerCustomer !== null && (
                        <div className="text-xs text-[var(--dash-ink-2)]">
                          max {o.maxPerCustomer} each
                        </div>
                      )}
                    </td>
                    <td>
                      {inr(o.spent)}
                      {/* ★ The budget is the brake best-offer-wins makes
                          load-bearing, so spend against it is a headline
                          column rather than something to go looking for. */}
                      {o.budget !== null && (
                        <div className="text-xs text-[var(--dash-ink-2)]">
                          of {inr(o.budget)}
                          {o.spent >= o.budget && " · stopped"}
                        </div>
                      )}
                    </td>
                    <td>
                      <span
                        className={`dash-badge ${
                          o.status === "active"
                            ? "dash-badge-green"
                            : "dash-badge-grey"
                        }`}
                      >
                        {o.status === "active" ? "Active" : "Paused"}
                      </span>
                    </td>
                    {canManage && (
                      <td className="dash-col-actions">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={
                              pending || (o.status !== "active" && atCap)
                            }
                            title={
                              o.status === "active"
                                ? "Pause this offer"
                                : atCap
                                  ? `Your plan includes ${limit} active offers`
                                  : "Activate this offer"
                            }
                            onClick={() =>
                              run(
                                () =>
                                  setOfferStatus(
                                    o.id,
                                    o.status === "active"
                                      ? "disabled"
                                      : "active",
                                  ),
                                o.status === "active"
                                  ? "Offer paused."
                                  : "Offer is live.",
                              )
                            }
                            className="dash-icon-btn"
                          >
                            {o.status === "active" ? (
                              <Pause size={15} />
                            ) : (
                              <Play size={15} />
                            )}
                          </button>
                          <button
                            type="button"
                            disabled={pending}
                            title="Delete this offer"
                            onClick={() => setConfirmDelete(o)}
                            className="dash-icon-btn"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {settings.length > 0 && (
        <div className="mt-6">
          <FeatureToggles
            title="How offers behave"
            subtitle="These apply to every offer in your store."
            successMessage="Offer settings saved."
            plan={plan}
            initialSettings={settings}
            canManage={canManage}
          />
        </div>
      )}

      {locationCount > 1 && (
        <p className="mt-4 text-xs text-[var(--dash-ink-2)]">
          An offer limited to particular locations applies at those tills only.
          Online orders are never location-limited — the shop that fulfils a web
          order is chosen by your routing rules, not by the customer.
        </p>
      )}

      <Dialog
        open={!!confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete “{confirmDelete?.name}”?</DialogTitle>
            <DialogDescription>
              {/* ★ Says what is LOST and what SURVIVES. Orders keep the
                  discount they were given — the offer's name is snapshotted on
                  every line it touched, so invoices and returns are unaffected.
                  What goes is the record of who redeemed it. */}
              Orders that already used this offer keep their prices and their
              records — invoices and returns are unaffected. What is deleted is
              this offer&rsquo;s own redemption history
              {confirmDelete && confirmDelete.redemptionCount > 0
                ? ` (${confirmDelete.redemptionCount} so far)`
                : ""}
              . To stop it without losing that, pause it instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(null)}
              disabled={pending}
            >
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                const target = confirmDelete;
                if (!target) return;
                setConfirmDelete(null);
                run(() => deleteOffer(target.id), "Offer deleted.");
              }}
            >
              {pending ? "Deleting…" : "Delete offer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
