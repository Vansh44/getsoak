"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
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
/** ★ The list is CAPPED and filterable rather than paginated. A store on the
 *  unlimited plan can have thousands of products, and rendering every checkbox
 *  makes the page unusable long before it makes the offer better — scoping by
 *  CATEGORY is the answer at that size, which the label says. */
const PRODUCT_PICKER_LIMIT = 200;

/** The four shapes merchants actually ask for, over one stored rule. */
/**
 * Common ladders, offered as a starting point.
 *
 * ★ A LADDER IS THE ONE OFFER SHAPE NOBODY BUILDS FROM AN EMPTY LIST. Three
 * rungs is six numbers that must rise together in two dimensions, and a
 * merchant who has to invent all six usually enters one rung and leaves — which
 * is a plain threshold offer wearing a ladder's clothes. The rungs stay fully
 * editable below, so a preset is a shortcut and never a restriction.
 */
const TIER_PRESETS: {
  label: string;
  mode: "percent" | "amount";
  tiers: { minSubtotal: number; value: number }[];
}[] = [
  {
    label: "5% / 10% / 15%",
    mode: "percent",
    tiers: [
      { minSubtotal: 1000, value: 5 },
      { minSubtotal: 2500, value: 10 },
      { minSubtotal: 5000, value: 15 },
    ],
  },
  {
    label: "10% / 20%",
    mode: "percent",
    tiers: [
      { minSubtotal: 1500, value: 10 },
      { minSubtotal: 3000, value: 20 },
    ],
  },
  {
    label: "₹100 / ₹300 / ₹750 off",
    mode: "amount",
    tiers: [
      { minSubtotal: 1000, value: 100 },
      { minSubtotal: 2500, value: 300 },
      { minSubtotal: 5000, value: 750 },
    ],
  },
];

const BREAK_PRESETS: {
  label: string;
  breaks: { minQuantity: number; percent: number }[];
}[] = [
  {
    label: "6+ / 12+",
    breaks: [
      { minQuantity: 6, percent: 10 },
      { minQuantity: 12, percent: 15 },
    ],
  },
  {
    label: "3+ / 6+ / 12+",
    breaks: [
      { minQuantity: 3, percent: 5 },
      { minQuantity: 6, percent: 10 },
      { minQuantity: 12, percent: 15 },
    ],
  },
  { label: "10+ only", breaks: [{ minQuantity: 10, percent: 12 }] },
];

const MAX_RUNGS = 10;

/**
 * The rung editor for both ladders.
 *
 * ★ IT VALIDATES AS YOU TYPE, and specifically it names the ONE mistake that
 * is invisible on a form: a higher level giving less than the one below it. The
 * server refuses it, but discovering that on Save — after entering six numbers
 * — is the difference between a warning and a wasted attempt.
 */
function LadderEditor({
  form,
  setForm,
}: {
  form: OfferFormData;
  setForm: React.Dispatch<React.SetStateAction<OfferFormData>>;
}) {
  const isSpend = form.rewardType === "tiered";
  const rows: { at: number; value: number }[] = isSpend
    ? form.tiers.map((t) => ({ at: t.minSubtotal, value: t.value }))
    : form.breaks.map((b) => ({ at: b.minQuantity, value: b.percent }));

  const write = (next: { at: number; value: number }[]) =>
    setForm((f) =>
      isSpend
        ? {
            ...f,
            tiers: next.map((r) => ({ minSubtotal: r.at, value: r.value })),
          }
        : {
            ...f,
            breaks: next.map((r) => ({
              minQuantity: Math.trunc(r.at),
              percent: r.value,
            })),
          },
    );

  const setCell = (i: number, key: "at" | "value", v: number) =>
    write(rows.map((r, j) => (i === j ? { ...r, [key]: v } : r)));

  // Sorted the way the engine will read them, so the warning below describes
  // the rule as applied rather than as typed.
  const ordered = [...rows].sort((a, b) => a.at - b.at);
  const notRising = ordered.some(
    (r, i) => i > 0 && r.value <= ordered[i - 1].value,
  );
  const duplicated = new Set(ordered.map((r) => r.at)).size !== ordered.length;
  const asPercent = !isSpend || form.tierMode === "percent";

  const unitLabel = isSpend ? "Order over (₹)" : "Quantity from";
  const valueLabel = asPercent ? "Discount (%)" : "Discount (₹)";

  return (
    <div className="sm:col-span-2">
      <span className={hintClass}>Common levels</span>
      <div className="mb-3 mt-1 flex flex-wrap gap-2">
        {(isSpend ? TIER_PRESETS : BREAK_PRESETS).map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() =>
              setForm((f) =>
                isSpend && "tiers" in preset
                  ? { ...f, tierMode: preset.mode, tiers: preset.tiers }
                  : {
                      ...f,
                      breaks: (preset as { breaks: typeof f.breaks }).breaks,
                    },
              )
            }
            className="rounded-full border border-[#e5e7eb] px-3 py-1 text-xs text-[#6b7280]"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {isSpend ? (
        <label className="mb-3 block max-w-xs">
          <span className={hintClass}>Each level gives</span>
          <select
            className={fieldClass}
            value={form.tierMode}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                tierMode: e.target.value === "amount" ? "amount" : "percent",
              }))
            }
          >
            <option value="percent">A percentage off the order</option>
            <option value="amount">A fixed amount off the order</option>
          </select>
        </label>
      ) : null}

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-end gap-2">
            <label className="block flex-1">
              {i === 0 ? <span className={hintClass}>{unitLabel}</span> : null}
              <input
                className={fieldClass}
                inputMode="numeric"
                value={row.at || ""}
                onChange={(e) =>
                  setCell(
                    i,
                    "at",
                    Number(e.target.value.replace(/\D/g, "")) || 0,
                  )
                }
              />
            </label>
            <label className="block flex-1">
              {i === 0 ? <span className={hintClass}>{valueLabel}</span> : null}
              <input
                className={fieldClass}
                inputMode="numeric"
                value={row.value || ""}
                onChange={(e) =>
                  setCell(
                    i,
                    "value",
                    Number(e.target.value.replace(/\D/g, "")) || 0,
                  )
                }
              />
            </label>
            <button
              type="button"
              aria-label={`Remove level ${i + 1}`}
              disabled={rows.length <= 1}
              onClick={() => write(rows.filter((_, j) => j !== i))}
              className="mb-[6px] rounded-md border border-[#e5e7eb] p-2 text-[#6b7280] disabled:opacity-40"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      {rows.length < MAX_RUNGS ? (
        <button
          type="button"
          onClick={() =>
            write([
              ...rows,
              {
                at: (ordered[ordered.length - 1]?.at ?? 0) * 2 || 1,
                value: (ordered[ordered.length - 1]?.value ?? 0) + 5,
              },
            ])
          }
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-[#e5e7eb] px-3 py-1.5 text-xs text-[#374151]"
        >
          <Plus size={13} /> Add a level
        </button>
      ) : (
        <span className={hintClass}>
          Ten levels is the most an offer can have.
        </span>
      )}

      {notRising ? (
        <p className="mt-2 text-xs text-[#b45309]">
          Each level has to give more than the one below it, or the higher level
          never does anything.
        </p>
      ) : null}
      {duplicated ? (
        <p className="mt-2 text-xs text-[#b45309]">
          Two levels start at the same {isSpend ? "order value" : "quantity"}.
        </p>
      ) : null}

      <span className={hintClass}>
        {isSpend
          ? "The highest level the order reaches applies — never several at once. Levels are judged on the order total before any discount."
          : "Units are counted across all the products you choose, and once a level is reached every one of those items is discounted."}
      </span>
    </div>
  );
}

const BXGY_PRESETS = [
  { label: "Buy 1 get 1 free", buy: 1, get: 1, pct: 100 },
  { label: "Buy 2 get 1 free", buy: 2, get: 1, pct: 100 },
  { label: "Buy 1 get 2 free", buy: 1, get: 2, pct: 100 },
  { label: "Buy 1 get 1 half price", buy: 1, get: 1, pct: 50 },
] as const;

const dateValue = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export function OfferForm({
  offer,
  locations,
  groups,
  initialLocationIds,
  initialGroupIds,
  initialProductIds,
  initialVariantIds,
  initialCategoryIds,
  products,
  categories,
  allowsGroups,
}: {
  offer: OfferRow | null;
  locations: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  initialLocationIds: string[];
  initialGroupIds: string[];
  initialProductIds: string[];
  initialVariantIds: string[];
  initialCategoryIds: string[];
  products: { id: string; name: string }[];
  categories: { id: string; name: string }[];
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
    unitPrice: offer?.unitPrice ?? 0,
    buyQuantity: offer?.buyQuantity ?? 1,
    getQuantity: offer?.getQuantity ?? 1,
    getPercent: offer?.getPercent ?? 100,
    maxSets: offer?.maxSets ?? 1,
    tierMode: offer?.tierMode ?? "percent",
    tiers: offer?.tiers ?? [{ minSubtotal: 1000, value: 5 }],
    breaks: offer?.breaks ?? [{ minQuantity: 6, percent: 10 }],
    channels: offer?.channels ?? [],
    validFrom: dateValue(offer?.validFrom ?? null),
    validUntil: dateValue(offer?.validUntil ?? null),
    maxRedemptions: offer?.maxRedemptions ?? 0,
    maxPerCustomer: offer?.maxPerCustomer ?? 0,
    budget: offer?.budget ?? 0,
    locationIds: initialLocationIds,
    groupIds: initialGroupIds,
    productIds: initialProductIds,
    variantIds: initialVariantIds,
    categoryIds: initialCategoryIds,
  });

  const set = <K extends keyof OfferFormData>(k: K, v: OfferFormData[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const [productFilter, setProductFilter] = useState("");

  // A line-level reward discounts the scope; a basket condition uses the scope
  // to qualify. Either way the picker is required — an unscoped line reward is
  // refused by the server, and an unscoped basket condition by the database.
  const scopeIsReward =
    form.rewardType === "percent_off_items" ||
    form.rewardType === "fixed_price" ||
    form.rewardType === "buy_x_get_y" ||
    // ★ A quantity ladder MUST be scoped: "buy 6 or more" counts units across
    // the chosen products, and unscoped it would count the whole basket —
    // a case price on an unrelated mixture of everything in the shop.
    form.rewardType === "volume_break";
  const scopeIsCondition =
    form.triggerType === "contains_product" ||
    form.triggerType === "contains_category";
  const needsScope = scopeIsReward || scopeIsCondition;
  const scopeSet =
    form.productIds.length + form.variantIds.length + form.categoryIds.length >
    0;

  const shownProducts = useMemo(() => {
    const q = productFilter.trim().toLowerCase();
    const base = q
      ? products.filter((pr) => pr.name.toLowerCase().includes(q))
      : products;
    return base.slice(0, PRODUCT_PICKER_LIMIT);
  }, [products, productFilter]);

  // What this offer will do, in the merchant's own words, updated live. A
  // rule expressed as five separate inputs is hard to read back; one sentence
  // is how a merchant catches "₹1,000 off" when they meant "₹100".
  const summary = useMemo(() => {
    const scopeCount =
      form.productIds.length + form.variantIds.length + form.categoryIds.length;
    const scoped = scopeCount > 0 ? ` (${scopeCount} selected)` : "";
    const ladder =
      form.rewardType === "tiered"
        ? form.tiers
            .map(
              (t) =>
                `over ₹${Number(t.minSubtotal || 0).toLocaleString("en-IN")} → ${
                  form.tierMode === "amount"
                    ? `₹${Number(t.value || 0).toLocaleString("en-IN")} off`
                    : `${Number(t.value || 0)}% off`
                }`,
            )
            .join(", ")
        : form.breaks
            .map(
              (b) =>
                `${Math.trunc(Number(b.minQuantity) || 0)}+ → ${Number(b.percent || 0)}% off`,
            )
            .join(", ");
    const gives =
      form.rewardType === "tiered"
        ? `Order discount by level: ${ladder || "no levels yet"}`
        : form.rewardType === "volume_break"
          ? `Chosen items${scoped} by quantity: ${ladder || "no levels yet"}`
          : form.rewardType === "amount_off"
            ? `₹${Number(form.amount || 0).toLocaleString("en-IN")} off the order`
            : form.rewardType === "fixed_price"
              ? `Chosen items${scoped} at ₹${Number(form.unitPrice || 0).toLocaleString("en-IN")} each`
              : form.rewardType === "buy_x_get_y"
                ? `Buy ${form.buyQuantity || 0}, get ${form.getQuantity || 0}${
                    form.getPercent && form.getPercent < 100
                      ? ` at ${form.getPercent}% off`
                      : " free"
                  }${scoped}`
                : form.rewardType === "percent_off_items"
                  ? `${Number(form.percent || 0)}% off chosen items${scoped}`
                  : `${Number(form.percent || 0)}% off the order`;
    const when =
      form.triggerType === "min_subtotal"
        ? ` on orders over ₹${Number(form.minSubtotal || 0).toLocaleString("en-IN")}`
        : form.triggerType === "contains_product" ||
            form.triggerType === "contains_category"
          ? ` when the basket includes them${scoped}`
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
                <option value="percent_off_items">
                  Percentage off chosen items
                </option>
                <option value="fixed_price">
                  A set price for each chosen item
                </option>
                <option value="buy_x_get_y">Buy X get Y</option>
                <option value="tiered">
                  Spend more, save more (order levels)
                </option>
                <option value="volume_break">
                  Buy more, save more (quantity levels)
                </option>
              </select>
            </label>
            {form.rewardType === "tiered" ||
            form.rewardType === "volume_break" ? (
              <LadderEditor form={form} setForm={setForm} />
            ) : form.rewardType === "buy_x_get_y" ? (
              <div className="sm:col-span-2">
                {/* ★ PRESETS OVER FOUR NUMBER BOXES. "Buy 1 get 1 free" is what
                    a merchant is thinking; buy/get/percent is how it is
                    stored. The boxes stay visible and editable underneath, so
                    an unusual combination is still reachable — a preset is a
                    shortcut, not a restriction. */}
                <span className={hintClass}>Common offers</span>
                <div className="mb-3 mt-1 flex flex-wrap gap-2">
                  {BXGY_PRESETS.map((preset) => {
                    const active =
                      form.buyQuantity === preset.buy &&
                      form.getQuantity === preset.get &&
                      form.getPercent === preset.pct;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            buyQuantity: preset.buy,
                            getQuantity: preset.get,
                            getPercent: preset.pct,
                          }))
                        }
                        className={`rounded-full border px-3 py-1 text-xs ${
                          active
                            ? "border-[#4f46e5] bg-[#eef2ff] text-[#4f46e5]"
                            : "border-[#e5e7eb] text-[#6b7280]"
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <div className="grid gap-4 sm:grid-cols-4">
                  {(
                    [
                      ["buyQuantity", "Buy"],
                      ["getQuantity", "Get"],
                      ["getPercent", "% off the free ones"],
                      ["maxSets", "Max sets per order"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="block">
                      <span className={hintClass}>{label}</span>
                      <input
                        className={fieldClass}
                        inputMode="numeric"
                        value={form[key] || ""}
                        placeholder={key === "maxSets" ? "No limit" : ""}
                        onChange={(e) =>
                          set(
                            key,
                            Number(e.target.value.replace(/\D/g, "")) || 0,
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
                <span className={hintClass}>
                  A set is {form.buyQuantity || 0} + {form.getQuantity || 0} ={" "}
                  {(form.buyQuantity || 0) + (form.getQuantity || 0)} items. The
                  cheapest qualifying items are the discounted ones, counted
                  across the whole basket. Leave the limit blank only if you
                  mean the offer to repeat without end.
                </span>
              </div>
            ) : form.rewardType === "fixed_price" ? (
              <label className="block">
                <span className={hintClass}>Price per item (₹)</span>
                <input
                  className={fieldClass}
                  inputMode="numeric"
                  value={form.unitPrice || ""}
                  onChange={(e) =>
                    set(
                      "unitPrice",
                      Number(e.target.value.replace(/\D/g, "")) || 0,
                    )
                  }
                />
                <span className={hintClass}>
                  Items already cheaper than this are left alone.
                </span>
              </label>
            ) : form.rewardType === "amount_off" ? (
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
                <option value="contains_category">
                  Baskets containing a chosen category
                </option>
                <option value="contains_product">
                  Baskets containing a chosen product
                </option>
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

        {(needsScope || scopeSet) && (
          <fieldset className="mb-5">
            <legend className={labelClass}>
              {scopeIsReward
                ? "Which items are discounted"
                : "Which items qualify"}
            </legend>
            {/* ★ THE SAME PICKER MEANS TWO DIFFERENT THINGS, and saying which
                is the difference between an offer that works and one that
                surprises the merchant. The reward level decides it:
                  · "% off chosen items" / "set price"  → these get discounted
                  · "% off the order" + a basket condition → these QUALIFY the
                    offer, and the whole basket is discounted once it does. */}
            <p className={`${hintClass} mb-2`}>
              {scopeIsReward
                ? "Only these lines are discounted. The rest of the basket is charged as normal."
                : "The basket has to include one of these. Once it does, the discount applies to the whole basket."}
            </p>

            {categories.length > 0 && (
              <div className="mb-3">
                <span className={hintClass}>Categories</span>
                <div className="mt-1 flex flex-wrap gap-3">
                  {categories.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={form.categoryIds.includes(c.id)}
                        onChange={() =>
                          set("categoryIds", toggle(form.categoryIds, c.id))
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {products.length > 0 && (
              <div>
                <span className={hintClass}>
                  Products
                  {products.length >= PRODUCT_PICKER_LIMIT &&
                    ` (first ${PRODUCT_PICKER_LIMIT}; pick a category for a wider range)`}
                </span>
                <input
                  className={`${fieldClass} mt-1`}
                  placeholder="Filter products…"
                  value={productFilter}
                  onChange={(e) => setProductFilter(e.target.value)}
                />
                <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-[#e5e7eb] p-2">
                  {shownProducts.length === 0 ? (
                    <p className={hintClass}>Nothing matches that.</p>
                  ) : (
                    shownProducts.map((pr) => (
                      <label
                        key={pr.id}
                        className="flex items-center gap-2 py-0.5 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={form.productIds.includes(pr.id)}
                          onChange={() =>
                            set("productIds", toggle(form.productIds, pr.id))
                          }
                        />
                        {pr.name}
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}

            {needsScope && !scopeSet && (
              <p className="mt-2 text-[11px] text-amber-700">
                Choose at least one, or this offer cannot be saved.
              </p>
            )}
          </fieldset>
        )}

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
