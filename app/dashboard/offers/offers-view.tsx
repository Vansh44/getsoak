"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pause, Play, Trash2 } from "lucide-react";
import { describeReward, describeTrigger } from "@/lib/offers/describe";
import {
  deleteOffer,
  setOfferStatus,
  type OfferRow,
} from "@/app/actions/offer-actions";
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

/**
 * What the offer gives.
 *
 * ★★ THIS USED TO BE A THREE-BRANCH STUB and it had gone badly stale: written
 * when there were three reward types, never extended, so everything Phases C–H
 * added fell through to `${percent ?? 0}% off` — a working "buy 1, get 1 free"
 * was listed as **"0% off"**, and so were bundles, gifts, cashback and free
 * delivery. It now shares `describeReward` with the offer editor, which had the
 * complete version all along (`lib/offers/describe.ts`).
 *
 * ⚠ NO `scopeCount` HERE. The list does not load each offer's scope rows, and
 * "(3 selected)" would be a lie if guessed. The editor passes it; this does not.
 */
function rewardLabel(o: OfferRow): string {
  return describeReward(o);
}

/**
 * Only the channels worth SAYING.
 *
 * ★ "Online & POS" IS THE DEFAULT AND THEREFORE NOT NEWS. Printing it on every
 * row spent a column restating what almost every offer does; the exceptions are
 * the ones a merchant needs to spot.
 */
function channelNote(channels: OfferRow["channels"]): string | null {
  if (channels.length === 0 || channels.length === 2) return null;
  return channels[0] === "pos" ? "Point of sale only" : "Online store only";
}

/**
 * How an offer reaches a customer — the distinction that makes "a code is a
 * delivery method, not a kind of offer" visible in the UI (plan §2).
 */
function deliveryLabel(o: OfferRow): string {
  if (o.delivery === "automatic") return "Automatic";
  return o.code ?? "Code";
}

/** A window, when the merchant set one. Most offers have none. */
function scheduleNote(o: OfferRow): string | null {
  const d = (iso: string) =>
    new Date(iso).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
    });
  if (o.validFrom && o.validUntil)
    return `${d(o.validFrom)} – ${d(o.validUntil)}`;
  if (o.validFrom) return `From ${d(o.validFrom)}`;
  if (o.validUntil) return `Until ${d(o.validUntil)}`;
  return null;
}

export function OffersView({
  autoApplyOn,
  emailableOfferIds,
  offers,
  loadError,
  limit,
  activeCount,
  locationCount,
  canManage,
}: {
  /**
   * The store's `offers.autoApply` switch.
   *
   * ★★ WITH IT OFF, AN "ACTIVE" AUTOMATIC OFFER APPLIES TO NOTHING.
   * `disqualify` refuses every `delivery: "automatic"` offer with
   * `auto_apply_off` before the engine sees it, so this table was reporting
   * Active for offers that could never fire — the one word a merchant checks
   * when the storefront charges full price, and it was wrong.
   */
  autoApplyOn: boolean;
  /**
   * Offers with a `coupons` row behind them, so the campaign page can find one.
   *
   * ★ RESOLVED SERVER-SIDE, because "does a coupon row exist for this id?" is a
   * database question and rendering the action for every code offer would 404
   * on any offer created here — campaigns are still coupon-keyed.
   */
  emailableOfferIds: string[];
  offers: OfferRow[];
  loadError?: string;
  limit: number | null;
  activeCount: number;
  locationCount: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState<OfferRow | null>(null);

  const atCap = limit !== null && activeCount >= limit;

  /** Offers the merchant believes are running and which cannot apply. */
  const inertCount = useMemo(
    () =>
      autoApplyOn
        ? 0
        : offers.filter(
            (o) => o.status === "active" && o.delivery === "automatic",
          ).length,
    [autoApplyOn, offers],
  );
  const emailable = useMemo(
    () => new Set(emailableOfferIds),
    [emailableOfferIds],
  );

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
        {/* ★ NO SETTINGS BUTTON HERE. It was the fix for settings being
            stranded at the bottom of the page — but the section's own sidebar
            panel now carries "Offer settings" beside "All offers", so a header
            button is a second door to the same room, one of them permanently
            visible and neither obviously the real one. The panel is where
            every other section in this dashboard keeps its settings. */}
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

      {inertCount > 0 && (
        <div className="dash-card mb-4 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">
            {inertCount === 1
              ? "One active offer is not applying to anything."
              : `${inertCount} active offers are not applying to anything.`}
          </p>
          {/* ★ SAYS WHAT IS WRONG, WHERE, AND WHAT IT COSTS. The failure is
              silent everywhere else — no error at checkout, no error at the
              till, and the row itself said "Active" — so this is the only
              place a merchant can find out. */}
          <p className="mt-1">
            They are set to apply automatically, but this store has automatic
            offers switched off, so no discount is given online or at the till.
            Turn on{" "}
            <Link
              href="/dashboard/offers/settings"
              className="font-medium underline"
            >
              “Apply offers automatically”
            </Link>{" "}
            in offer settings to let them run. Offers with a discount code are
            unaffected.
          </p>
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
                {/* ★★ SIX COLUMNS, DOWN FROM NINE. Offer · Gives · When ·
                    How · Where · Used · Given away · Status · Actions made the
                    table scroll sideways in the dashboard's own width, and
                    three of those columns printed the SAME value on nearly
                    every row ("Any order", "Online & POS", "₹0"). Each fact
                    still appears — folded into the cell that owns it, and only
                    when it is not the default. */}
                <tr>
                  <th>Offer</th>
                  <th>What customers get</th>
                  <th>How they get it</th>
                  <th>Used</th>
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
                    {/* Gives + when. The trigger is a qualifier ON the
                        reward, so it reads as one thought rather than as two
                        columns a merchant has to join up by eye. */}
                    <td>
                      <div className="font-medium">{rewardLabel(o)}</div>
                      <div className="text-xs text-[var(--dash-ink-2)]">
                        {describeTrigger(o.triggerType, o.minSubtotal)}
                      </div>
                    </td>
                    {/* Delivery + the exceptions: the channel only when it is
                        not everywhere, the schedule only when there is one. */}
                    <td>
                      <div>{deliveryLabel(o)}</div>
                      {(channelNote(o.channels) || scheduleNote(o)) && (
                        <div className="text-xs text-[var(--dash-ink-2)]">
                          {[channelNote(o.channels), scheduleNote(o)]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </td>
                    {/* Usage against every ceiling that exists, in one cell.
                        ★ The budget is the brake best-offer-wins makes
                        load-bearing, so spend against it stays visible — but
                        only for the offers that HAVE one, where it used to be
                        a column reading "₹0" on every row that did not. */}
                    <td>
                      <div>
                        {o.redemptionCount}
                        {o.maxRedemptions !== null && ` / ${o.maxRedemptions}`}
                        {o.maxRedemptions === null && " times"}
                      </div>
                      {(o.budget !== null || o.maxPerCustomer !== null) && (
                        <div className="text-xs text-[var(--dash-ink-2)]">
                          {[
                            o.budget !== null
                              ? `${inr(o.spent)} of ${inr(o.budget)}${
                                  o.spent >= o.budget ? " · stopped" : ""
                                }`
                              : null,
                            o.maxPerCustomer !== null
                              ? `max ${o.maxPerCustomer} each`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </td>
                    <td>
                      {/* ★ A THIRD STATE, because "Active" is precisely the
                          lie: the row IS active and still cannot fire. Paused
                          keeps its own word — a paused offer was switched off
                          deliberately and needs no explaining. */}
                      {o.status === "active" &&
                      o.delivery === "automatic" &&
                      !autoApplyOn ? (
                        <span
                          className="dash-badge dash-badge-amber"
                          title="Active, but automatic offers are switched off for this store — see the note above."
                        >
                          Not applying
                        </span>
                      ) : (
                        <span
                          className={`dash-badge ${
                            o.status === "active"
                              ? "dash-badge-green"
                              : "dash-badge-grey"
                          }`}
                        >
                          {o.status === "active" ? "Active" : "Paused"}
                        </span>
                      )}
                    </td>
                    {canManage && (
                      <td className="dash-col-actions">
                        <div className="flex items-center gap-1">
                          {emailable.has(o.id) && (
                            <Link
                              href={`/dashboard/marketing/coupons/${o.id}/email`}
                              className="dash-btn dash-btn-ghost dash-btn-sm"
                              title="Email this code to customers"
                            >
                              Email
                            </Link>
                          )}
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
