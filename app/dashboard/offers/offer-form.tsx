"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import {
  createOffer,
  updateOffer,
  type OfferFormData,
  type OfferRow,
} from "@/app/actions/offer-actions";
import type {
  OfferChannel,
  OfferDelivery,
  OfferRewardType,
  OfferTriggerType,
} from "@/lib/offers/types";

// ★ THE SAME CLASSES `coupon-form.tsx` USES, not new `dash-*` ones. Neither
// `dash-label` nor `dash-hint` exists in dashboard.css — inventing them here
// would render an unstyled form, and adding them there would be a second
// convention for a field this repo already styles one way.
const fieldClass =
  "w-full rounded-md border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#1f2937] outline-none placeholder:text-[#9ca3af] focus:border-[#4f46e5]";
const labelClass =
  "mb-1.5 block text-xs font-medium uppercase tracking-wide text-[#6b7280]";
const hintClass = "mt-1 block text-[11px] text-[#9ca3af]";

const dateValue = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export function OfferForm({
  offer,
  locations,
  groups,
  initialLocationIds,
  initialGroupIds,
  allowsGroups,
}: {
  offer: OfferRow | null;
  locations: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  initialLocationIds: string[];
  initialGroupIds: string[];
  allowsGroups: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [form, setForm] = useState<OfferFormData>({
    name: offer?.name ?? "",
    description: offer?.description ?? "",
    status: offer?.status ?? "disabled",
    delivery: offer?.delivery ?? "automatic",
    code: offer?.code ?? "",
    priority: offer?.priority ?? 0,
    triggerType: offer?.triggerType ?? "always",
    minSubtotal: offer?.minSubtotal ?? 0,
    rewardType: offer?.rewardType ?? "percent_off",
    percent: offer?.percent ?? 10,
    amount: offer?.amount ?? 0,
    channels: offer?.channels ?? [],
    validFrom: dateValue(offer?.validFrom ?? null),
    validUntil: dateValue(offer?.validUntil ?? null),
    maxRedemptions: offer?.maxRedemptions ?? 0,
    maxPerCustomer: offer?.maxPerCustomer ?? 0,
    budget: offer?.budget ?? 0,
    locationIds: initialLocationIds,
    groupIds: initialGroupIds,
  });

  const set = <K extends keyof OfferFormData>(k: K, v: OfferFormData[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  // What this offer will do, in the merchant's own words, updated live. A
  // rule expressed as five separate inputs is hard to read back; one sentence
  // is how a merchant catches "₹1,000 off" when they meant "₹100".
  const summary = useMemo(() => {
    const gives =
      form.rewardType === "amount_off"
        ? `₹${Number(form.amount || 0).toLocaleString("en-IN")} off`
        : `${Number(form.percent || 0)}% off${
            form.rewardType === "percent_off_items" ? " matching items" : ""
          }`;
    const when =
      form.triggerType === "min_subtotal"
        ? ` on orders over ₹${Number(form.minSubtotal || 0).toLocaleString("en-IN")}`
        : " on any order";
    const how =
      form.delivery === "automatic"
        ? ", applied automatically"
        : `, when a customer enters ${form.code ? form.code.toUpperCase() : "a code"}`;
    return `${gives}${when}${how}.`;
  }, [form]);

  const submit = () =>
    startTransition(async () => {
      const res = offer
        ? await updateOffer(offer.id, form)
        : await createOffer(form);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(offer ? "Offer saved." : "Offer created.");
      router.push("/dashboard/offers");
      router.refresh();
    });

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header row">
        <div>
          <Link
            href="/dashboard/offers"
            className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--dash-ink-2)] hover:underline"
          >
            <ArrowLeft size={14} /> Offers
          </Link>
          <h1>{offer ? "Edit offer" : "New offer"}</h1>
          <p>{summary}</p>
        </div>
      </header>

      <div className="dash-card max-w-3xl p-5">
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelClass}>Name</span>
            <input
              className={fieldClass}
              value={form.name}
              maxLength={120}
              placeholder="Launch week"
              onChange={(e) => set("name", e.target.value)}
            />
            <span className={hintClass}>
              For your reference. Customers never see it.
            </span>
          </label>
          <label className="block">
            <span className={labelClass}>Note (optional)</span>
            <input
              className={fieldClass}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Why this offer exists"
            />
          </label>
        </div>

        <fieldset className="mb-5">
          <legend className={labelClass}>What the customer gets</legend>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={hintClass}>Discount</span>
              <select
                className={fieldClass}
                value={form.rewardType}
                onChange={(e) =>
                  set("rewardType", e.target.value as OfferRewardType)
                }
              >
                <option value="percent_off">Percentage off the order</option>
                <option value="amount_off">Amount off the order</option>
              </select>
            </label>
            {form.rewardType === "amount_off" ? (
              <label className="block">
                <span className={hintClass}>Amount (₹)</span>
                <input
                  className={fieldClass}
                  inputMode="numeric"
                  value={form.amount || ""}
                  onChange={(e) =>
                    set(
                      "amount",
                      Number(e.target.value.replace(/\D/g, "")) || 0,
                    )
                  }
                />
              </label>
            ) : (
              <label className="block">
                <span className={hintClass}>Percentage</span>
                <input
                  className={fieldClass}
                  inputMode="numeric"
                  value={form.percent || ""}
                  onChange={(e) =>
                    set(
                      "percent",
                      Number(e.target.value.replace(/\D/g, "")) || 0,
                    )
                  }
                />
              </label>
            )}
          </div>
        </fieldset>

        <fieldset className="mb-5">
          <legend className={labelClass}>When it applies</legend>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={hintClass}>Condition</span>
              <select
                className={fieldClass}
                value={form.triggerType}
                onChange={(e) =>
                  set("triggerType", e.target.value as OfferTriggerType)
                }
              >
                <option value="always">Any order</option>
                <option value="min_subtotal">Orders over an amount</option>
              </select>
            </label>
            {form.triggerType === "min_subtotal" && (
              <label className="block">
                <span className={hintClass}>Minimum order (₹)</span>
                <input
                  className={fieldClass}
                  inputMode="numeric"
                  value={form.minSubtotal || ""}
                  onChange={(e) =>
                    set(
                      "minSubtotal",
                      Number(e.target.value.replace(/\D/g, "")) || 0,
                    )
                  }
                />
                <span className={hintClass}>
                  Measured on the order value before any discount.
                </span>
              </label>
            )}
          </div>
        </fieldset>

        <fieldset className="mb-5">
          <legend className={labelClass}>How customers get it</legend>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={hintClass}>Delivery</span>
              <select
                className={fieldClass}
                value={form.delivery}
                onChange={(e) =>
                  set("delivery", e.target.value as OfferDelivery)
                }
              >
                <option value="automatic">Automatically</option>
                <option value="code">With a discount code</option>
                <option value="link">From a shareable link</option>
              </select>
            </label>
            {form.delivery !== "automatic" && (
              <label className="block">
                <span className={hintClass}>Code</span>
                <input
                  className={`${fieldClass} font-mono uppercase`}
                  value={form.code}
                  onChange={(e) => set("code", e.target.value)}
                  placeholder="LAUNCH10"
                />
                <span className={hintClass}>
                  Not case-sensitive. Spaces are removed.
                </span>
              </label>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-4">
            {(["storefront", "pos"] as OfferChannel[]).map((ch) => (
              <label key={ch} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={
                    form.channels.length === 0 || form.channels.includes(ch)
                  }
                  onChange={() => {
                    // Empty means "everywhere", so unticking one has to write
                    // the OTHER explicitly rather than leaving an empty list
                    // that silently means both.
                    const current =
                      form.channels.length === 0
                        ? (["storefront", "pos"] as OfferChannel[])
                        : form.channels;
                    const next = toggle(current, ch) as OfferChannel[];
                    set("channels", next);
                  }}
                />
                {ch === "pos" ? "Point of sale" : "Online store"}
              </label>
            ))}
          </div>
          {form.channels.length === 0 && (
            <span className={hintClass}>Runs everywhere you sell.</span>
          )}
        </fieldset>

        <fieldset className="mb-5">
          <legend className={labelClass}>Limits</legend>
          <p className={`${hintClass} mb-2`}>
            When several offers could apply, the one that saves the customer
            most wins — so a budget is the safest way to bound a new offer.
          </p>
          <div className="mt-2 grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className={hintClass}>Total budget (₹)</span>
              <input
                className={fieldClass}
                inputMode="numeric"
                value={form.budget || ""}
                placeholder="No limit"
                onChange={(e) =>
                  set("budget", Number(e.target.value.replace(/\D/g, "")) || 0)
                }
              />
              <span className={hintClass}>
                Stops once this much is given away.
              </span>
            </label>
            <label className="block">
              <span className={hintClass}>Total uses</span>
              <input
                className={fieldClass}
                inputMode="numeric"
                value={form.maxRedemptions || ""}
                placeholder="No limit"
                onChange={(e) =>
                  set(
                    "maxRedemptions",
                    Number(e.target.value.replace(/\D/g, "")) || 0,
                  )
                }
              />
            </label>
            <label className="block">
              <span className={hintClass}>Uses per customer</span>
              <input
                className={fieldClass}
                inputMode="numeric"
                value={form.maxPerCustomer || ""}
                placeholder="No limit"
                onChange={(e) =>
                  set(
                    "maxPerCustomer",
                    Number(e.target.value.replace(/\D/g, "")) || 0,
                  )
                }
              />
              <span className={hintClass}>Needs a signed-in customer.</span>
            </label>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className={hintClass}>Starts (optional)</span>
              <input
                type="date"
                className={fieldClass}
                value={form.validFrom}
                onChange={(e) => set("validFrom", e.target.value)}
              />
            </label>
            <label className="block">
              <span className={hintClass}>Ends (optional)</span>
              <input
                type="date"
                className={fieldClass}
                value={form.validUntil}
                onChange={(e) => set("validUntil", e.target.value)}
              />
            </label>
          </div>
        </fieldset>

        {locations.length > 1 && (
          <fieldset className="mb-5">
            <legend className={labelClass}>Locations (optional)</legend>
            <p className={`${hintClass} mb-2`}>
              Leave all unticked to run at every till. Online orders are never
              location-limited.
            </p>
            <div className="flex flex-wrap gap-3">
              {locations.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.locationIds.includes(l.id)}
                    onChange={() =>
                      set("locationIds", toggle(form.locationIds, l.id))
                    }
                  />
                  {l.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {groups.length > 0 && (
          <fieldset className="mb-5">
            <legend className={labelClass}>Customer groups (optional)</legend>
            <p className={`${hintClass} mb-2`}>
              {allowsGroups
                ? "Leave all unticked to offer it to everyone. A restricted offer is never suggested to shoppers who cannot use it."
                : "Restricting an offer to customer groups is available on Basic and Pro."}
            </p>
            <div className="flex flex-wrap gap-3">
              {groups.map((g) => (
                <label
                  key={g.id}
                  className={`flex items-center gap-2 text-sm ${allowsGroups ? "" : "opacity-50"}`}
                >
                  <input
                    type="checkbox"
                    disabled={!allowsGroups}
                    checked={form.groupIds.includes(g.id)}
                    onChange={() =>
                      set("groupIds", toggle(form.groupIds, g.id))
                    }
                  />
                  {g.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="mb-5 flex flex-wrap items-end gap-4">
          <label className="block">
            <span className={labelClass}>Status</span>
            <select
              className={fieldClass}
              value={form.status}
              onChange={(e) =>
                set(
                  "status",
                  e.target.value === "active" ? "active" : "disabled",
                )
              }
            >
              <option value="disabled">Paused</option>
              <option value="active">Active</option>
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>Priority</span>
            <input
              className={`${fieldClass} w-24`}
              inputMode="numeric"
              value={form.priority || ""}
              placeholder="0"
              onChange={(e) => set("priority", Number(e.target.value) || 0)}
            />
            <span className={hintClass}>
              Only decides ties. A better saving always wins.
            </span>
          </label>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="dash-btn dash-btn-primary"
            disabled={pending}
            onClick={submit}
          >
            {pending ? "Saving…" : offer ? "Save offer" : "Create offer"}
          </button>
          <Link href="/dashboard/offers" className="dash-btn">
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
