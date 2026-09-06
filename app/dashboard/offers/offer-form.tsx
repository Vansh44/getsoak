"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, ChevronDown, Plus, Trash2 } from "lucide-react";
import { describeReward, describeTrigger } from "@/lib/offers/describe";
import {
  createOffer,
  updateOffer,
  type OfferFormData,
  type OfferRow,
} from "@/app/actions/offer-actions";
import {
  OFFER_CONDITIONS,
  isWebsiteOnlyCondition,
  type OfferChannel,
  type OfferCondition,
  type OfferConditionType,
  type OfferDelivery,
  type OfferRewardType,
  type OfferTriggerType,
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

const inr = (n: unknown) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
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

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const CONDITION_LABELS: Record<
  OfferConditionType,
  { title: string; hint: string }
> = {
  payment_method: {
    title: "Payment method",
    hint: "Website only. The register shows the total before payment is taken, so it cannot change once a method is chosen.",
  },
  fulfilment_type: {
    title: "Delivery or pickup",
    hint: "Website only. A register sale is neither a delivery nor a collection.",
  },
  first_order: {
    title: "First order only",
    hint: "Needs a signed-in customer — there is no order history to check for a guest, so a guest checkout will not qualify.",
  },
  time_window: {
    title: "Days and times",
    hint: "Uses your store's timezone, so the window means the same thing to every customer. An end time earlier than the start runs past midnight, and counts as the day it began on.",
  },
};

const minuteToTime = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const timeToMinute = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
};

/**
 * The extra conditions on an offer.
 *
 * ★ ADDED ONE AT A TIME FROM A LIST OF WHAT IS LEFT, rather than four
 * permanently-visible switches. Most offers carry none, and four dormant panels
 * make the common case look complicated — while the "add" list is also where
 * the one-of-each rule is enforced without an error message.
 *
 * ★ IT SAYS "ALL of these must be true" ABOVE THE LIST. Two conditions read as
 * alternatives to most people, and a merchant who believes they built "prepaid
 * OR pickup" has built an offer that almost never fires.
 */
function ConditionsEditor({
  form,
  setForm,
}: {
  form: OfferFormData;
  setForm: React.Dispatch<React.SetStateAction<OfferFormData>>;
}) {
  const present = new Set(form.conditions.map((c) => c.type));
  const remaining = OFFER_CONDITIONS.filter((t) => !present.has(t));
  const reachesPos =
    form.channels.length === 0 || form.channels.includes("pos");

  const write = (next: OfferCondition[]) =>
    setForm((f) => ({ ...f, conditions: next }));

  const update = (i: number, next: OfferCondition) =>
    write(form.conditions.map((c, j) => (i === j ? next : c)));

  const add = (type: OfferConditionType) => {
    const fresh: OfferCondition =
      type === "payment_method"
        ? { type, methods: ["razorpay"] }
        : type === "fulfilment_type"
          ? { type, fulfilment: ["pickup"] }
          : type === "time_window"
            ? {
                type,
                days: [1, 2, 3, 4, 5],
                startMinute: 16 * 60,
                endMinute: 19 * 60,
              }
            : { type };
    write([...form.conditions, fresh]);
  };

  return (
    <div className="mt-5 border-t border-[#f0f0f0] pt-5">
      <h3 className="text-sm font-medium">Extra conditions</h3>
      <p className={hintClass}>
        Optional. <strong>All</strong> of them must be true for the offer to
        apply — they narrow it, never widen it. For &ldquo;either of two
        situations&rdquo;, make two offers; the better one is chosen
        automatically.
      </p>

      {form.conditions.length > 0 ? (
        <div className="mt-3 space-y-3">
          {form.conditions.map((c, i) => {
            const meta = CONDITION_LABELS[c.type];
            const blocked = reachesPos && isWebsiteOnlyCondition(c.type);
            return (
              <div
                key={c.type}
                className="rounded-lg border border-[#e5e7eb] p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className="text-sm font-medium">{meta.title}</span>
                    <span className={hintClass}>{meta.hint}</span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove the ${meta.title.toLowerCase()} condition`}
                    onClick={() =>
                      write(form.conditions.filter((_, j) => j !== i))
                    }
                    className="rounded-md border border-[#e5e7eb] p-1.5 text-[#6b7280]"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {blocked ? (
                  <p className="mt-2 text-xs text-[#b45309]">
                    This offer includes the register, where this condition
                    cannot work. Set the offer to your website only, or remove
                    the condition.
                  </p>
                ) : null}

                {c.type === "payment_method" ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        ["razorpay", "Paid online"],
                        ["cod", "Cash on delivery"],
                        ["pay_at_store", "Pay at the shop"],
                      ] as const
                    ).map(([value, label]) => {
                      const on = c.methods.includes(value);
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() =>
                            update(i, {
                              ...c,
                              methods: on
                                ? c.methods.filter((m) => m !== value)
                                : [...c.methods, value],
                            })
                          }
                          className={`rounded-full border px-3 py-1 text-xs ${
                            on
                              ? "border-[#4f46e5] bg-[#eef2ff] text-[#4f46e5]"
                              : "border-[#e5e7eb] text-[#6b7280]"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                    {c.methods.length === 0 ? (
                      <span className="text-xs text-[#b45309]">
                        Choose at least one, or the offer can never apply.
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {c.type === "fulfilment_type" ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        ["delivery", "Delivered"],
                        ["pickup", "Collected from a shop"],
                      ] as const
                    ).map(([value, label]) => {
                      const on = c.fulfilment.includes(value);
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() =>
                            update(i, {
                              ...c,
                              fulfilment: on
                                ? c.fulfilment.filter((f) => f !== value)
                                : [...c.fulfilment, value],
                            })
                          }
                          className={`rounded-full border px-3 py-1 text-xs ${
                            on
                              ? "border-[#4f46e5] bg-[#eef2ff] text-[#4f46e5]"
                              : "border-[#e5e7eb] text-[#6b7280]"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {c.type === "time_window" ? (
                  <div className="mt-2">
                    <div className="flex flex-wrap gap-1.5">
                      {DAY_LABELS.map((label, day) => {
                        const on = c.days.includes(day);
                        return (
                          <button
                            key={label}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              update(i, {
                                ...c,
                                days: on
                                  ? c.days.filter((d) => d !== day)
                                  : [...c.days, day],
                              })
                            }
                            className={`w-11 rounded-md border px-2 py-1 text-xs ${
                              on
                                ? "border-[#4f46e5] bg-[#eef2ff] text-[#4f46e5]"
                                : "border-[#e5e7eb] text-[#6b7280]"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <label className="block">
                        <span className={hintClass}>From</span>
                        <input
                          type="time"
                          className={fieldClass}
                          value={minuteToTime(c.startMinute)}
                          onChange={(e) =>
                            update(i, {
                              ...c,
                              startMinute: timeToMinute(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="block">
                        <span className={hintClass}>To</span>
                        <input
                          type="time"
                          className={fieldClass}
                          value={minuteToTime(c.endMinute)}
                          onChange={(e) =>
                            update(i, {
                              ...c,
                              endMinute: timeToMinute(e.target.value),
                            })
                          }
                        />
                      </label>
                    </div>
                    {c.days.length === 0 ? (
                      <p className="mt-2 text-xs text-[#b45309]">
                        Choose at least one day.
                      </p>
                    ) : null}
                    {c.startMinute === c.endMinute ? (
                      <p className="mt-2 text-xs text-[#b45309]">
                        The start and end are the same, so the offer would never
                        apply. For all day, remove this condition.
                      </p>
                    ) : c.endMinute < c.startMinute ? (
                      <p className={hintClass}>
                        This runs past midnight, and counts as the day it starts
                        on — {DAY_LABELS[c.days[0] ?? 0]}{" "}
                        {minuteToTime(c.startMinute)} reaches into the next
                        morning.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {remaining.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {remaining.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => add(type)}
              className="inline-flex items-center gap-1 rounded-md border border-[#e5e7eb] px-3 py-1.5 text-xs text-[#374151]"
            >
              <Plus size={13} /> {CONDITION_LABELS[type].title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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

/**
 * One collapsible part of the offer form.
 *
 * ★ LOCAL, NOT THE BUILDER'S `FieldGroup`. That component is styled by
 * `sm-builder-*` classes in `builder.css`, which only the builder overlay
 * loads — reusing it here would render an unstyled block on a page that never
 * imports that stylesheet. Same reason the dashboard has its own tokens.
 *
 * ★ THE SUMMARY IS THE POINT. A disclosure that only shows a title makes the
 * merchant open every section to find out what is in it, which is worse than
 * the long scroll it replaced. Closed sections read as a settings list.
 */
function OfferSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-3 rounded-[10px] border border-[var(--dash-border)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <ChevronDown
          size={16}
          className={`shrink-0 text-[var(--dash-ink-2)] transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          {!open && summary && (
            <span className="mt-0.5 block truncate text-xs text-[var(--dash-ink-2)]">
              {summary}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-[var(--dash-border)] p-4">
          {children}
        </div>
      )}
    </section>
  );
}

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
  autoApplyOn,
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
  /**
   * The store's `offers.autoApply` switch.
   *
   * ★★ AN AUTOMATIC OFFER IS INERT WHILE THIS IS OFF, and nothing on this form
   * said so. `disqualify` refuses every `delivery: "automatic"` offer with
   * `auto_apply_off` before it reaches the engine, so a merchant could build
   * one, save it Active, and watch the storefront charge full price with no
   * error anywhere. §23's rule: a control that always fails is worse than no
   * control — and this one did not even look like it was failing.
   *
   * ★ FAILS TOWARD SILENCE. The pages that render this form default it to true
   * when the setting cannot be read, because a warning is a CLAIM: telling a
   * merchant their working offer will not apply is worse than saying nothing.
   */
  autoApplyOn: boolean;
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
    showOnStorefront: offer?.showOnStorefront ?? false,
    percent: offer?.percent ?? 10,
    amount: offer?.amount ?? 0,
    unitPrice: offer?.unitPrice ?? 0,
    buyQuantity: offer?.buyQuantity ?? 1,
    getQuantity: offer?.getQuantity ?? 1,
    getPercent: offer?.getPercent ?? 100,
    // ★★ BLANK, NOT 1. It defaulted to ONE SET, and the field's own
    // placeholder says "No limit" — so every buy-X-get-Y offer arrived
    // pre-filled with the tightest possible value in a box that looked
    // optional. A merchant building "Buy 1, get 1 free" and putting FOUR
    // items in a basket got one free, not two: the offer stopped meaning what
    // its own name says, and nothing on the screen explained why.
    //
    // The guard rail it was reaching for is real — an uncapped buy-1-get-1 on
    // a hundred-unit basket gives away fifty items, which nobody means the
    // first time they build one. But a SET cap is the wrong instrument for it.
    // It bounds each ORDER, while the thing a merchant actually needs bounded
    // is their total exposure, and it does that by quietly redefining the
    // offer. The BUDGET bounds exposure directly, in rupees, is claimed
    // atomically by `reserve_offer_use`, and stops the offer dead when it is
    // reached — which is why the Limits section leads with it.
    //
    // ★ 0 IS THE STORED "no limit". `rewardConfigFor` omits the key entirely
    // when it is not > 0, and the input renders `form[key] || ""`, so zero and
    // blank are the same thing to both the merchant and the database.
    maxSets: offer?.maxSets ?? 0,
    tierMode: offer?.tierMode ?? "percent",
    tiers: offer?.tiers ?? [{ minSubtotal: 1000, value: 5 }],
    breaks: offer?.breaks ?? [{ minQuantity: 6, percent: 10 }],
    conditions: offer?.conditions ?? [],
    giftProductId: offer?.giftProductId ?? "",
    giftVariantId: offer?.giftVariantId ?? null,
    giftQuantity: offer?.giftQuantity ?? 1,
    bundleQuantity: offer?.bundleQuantity ?? 3,
    bundlePrice: offer?.bundlePrice ?? 0,
    creditAmount: offer?.creditAmount ?? 0,
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
    form.rewardType === "volume_break" ||
    // ★ A bundle MUST be scoped: "any 3 for ₹999" unscoped would bundle any
    // three items in the whole catalogue, at whatever the dearest three
    // happen to be.
    form.rewardType === "bundle_price";
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
  //
  // ★ `products` IS A REAL DEPENDENCY, not a lint formality: the sentence names
  // the gift by looking it up in that list, so memoising on `form` alone keeps
  // the old name when the list arrives or changes. Its absence also made the
  // React Compiler skip optimising this whole component — "the inferred
  // dependency was `products`, but the source dependencies were [form]".
  const summary = useMemo(() => {
    const scopeCount =
      form.productIds.length + form.variantIds.length + form.categoryIds.length;
    // ★★ ONE DESCRIPTION, SHARED WITH THE OFFERS LIST. This used to be a
    // nested-ternary chain here and a three-branch stub there, and the stub
    // was never extended past Phase B — so every reward type added after it
    // was listed as "0% off", including a working buy-1-get-1. See
    // `lib/offers/describe.ts`.
    const gives = describeReward(form, {
      scopeCount,
      giftName: products.find((pr) => pr.id === form.giftProductId)?.name,
    });
    const when = ` ${describeTrigger(form.triggerType, form.minSubtotal, {
      scopeCount,
    })}`;
    const how =
      form.delivery === "automatic"
        ? ", applied automatically"
        : `, when a customer enters ${form.code ? form.code.toUpperCase() : "a code"}`;
    // ★ CONDITIONS APPEAR IN THE SENTENCE, because they are the part most
    // likely to be set by accident and never noticed: an offer that quietly
    // requires a first order applies to almost nobody, and the offers list
    // shows it as plainly "Active".
    const extras = form.conditions
      .map((c) =>
        c.type === "first_order"
          ? "first orders only"
          : c.type === "payment_method"
            ? `paid by ${c.methods
                .map((m) =>
                  m === "razorpay"
                    ? "card or UPI"
                    : m === "cod"
                      ? "cash on delivery"
                      : "payment at the shop",
                )
                .join(" or ")}`
            : c.type === "fulfilment_type"
              ? c.fulfilment.join(" or ")
              : `${c.days.map((d) => DAY_LABELS[d]).join("/")} ${minuteToTime(
                  c.startMinute,
                )}–${minuteToTime(c.endMinute)}`,
      )
      .filter(Boolean);
    const only = extras.length > 0 ? `, ${extras.join(", and ")}` : "";
    return `${gives}${when}${only}${how}.`;
  }, [form, products]);

  /**
   * ★★ "COUPON" IS A UI FAMILY, NOT A STORED REWARD TYPE. A percentage off the
   * order and a rupee amount off the order are the same thing to a merchant —
   * a coupon — and splitting them across two dropdown entries made them read
   * as two unrelated features while every other entry described a mechanic.
   * They stay `percent_off` / `amount_off` in the column, because the engine
   * prices them differently and the schema is not the place to express a UI
   * grouping.
   *
   * ★ IT IS ALSO WHAT THE STOREFRONT CHECKBOX HANGS OFF. These are the only two
   * shapes `validateCoupon` can price in the cart, so they are the only two
   * that may be published — which makes the family a real boundary rather than
   * a label.
   */
  const isCouponReward =
    form.rewardType === "percent_off" || form.rewardType === "amount_off";
  const rewardFamily = isCouponReward ? "coupon" : form.rewardType;

  const setSize = (form.buyQuantity || 0) + (form.getQuantity || 0);

  const scopeCount =
    form.productIds.length + form.variantIds.length + form.categoryIds.length;

  // Section headers. Each is the same phrase the offers list and the live
  // sentence use, so a closed section and the summary above the form cannot
  // describe the offer differently.
  const givesSummary = describeReward(form, {
    scopeCount,
    giftName: products.find((pr) => pr.id === form.giftProductId)?.name,
  });
  const whenSummary = [
    describeTrigger(form.triggerType, form.minSubtotal, { scopeCount }),
    form.conditions.length > 0
      ? `${form.conditions.length} extra condition${
          form.conditions.length === 1 ? "" : "s"
        }`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const howSummary = [
    form.delivery === "automatic"
      ? "Applied automatically"
      : `Code ${form.code ? form.code.toUpperCase() : "—"}`,
    form.channels.length === 1
      ? form.channels[0] === "pos"
        ? "point of sale only"
        : "online store only"
      : "online store and point of sale",
    form.locationIds.length > 0
      ? `${form.locationIds.length} location${
          form.locationIds.length === 1 ? "" : "s"
        }`
      : null,
    form.groupIds.length > 0
      ? `${form.groupIds.length} customer group${
          form.groupIds.length === 1 ? "" : "s"
        }`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const limitsSummary =
    [
      form.budget ? `${inr(form.budget)} budget` : null,
      form.maxRedemptions ? `${form.maxRedemptions} uses` : null,
      form.maxPerCustomer ? `${form.maxPerCustomer} per customer` : null,
      form.validFrom || form.validUntil ? "scheduled" : null,
    ]
      .filter(Boolean)
      .join(" · ") || "No limits — runs until you pause it";

  // ★ COMPUTED ONCE, from the form as it FIRST loaded. Recomputing would close
  // a section the moment its last value was cleared, mid-edit.
  const [openWhen] = useState(
    () => form.triggerType !== "always" || form.conditions.length > 0,
  );
  const [openLimits] = useState(() =>
    Boolean(
      form.budget ||
      form.maxRedemptions ||
      form.maxPerCustomer ||
      form.validFrom ||
      form.validUntil,
    ),
  );

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

        {/* ★★ FOUR NAMED SECTIONS, DOWN FROM TEN UNLABELLED BLOCKS. The
            form was one scroll of ten fieldsets — reward, trigger, delivery,
            channels, limits, dates, item scope, locations, groups, extra
            conditions — with no way to see its shape or skip a part. Seven of
            the ten are OPTIONAL and sit at defaults on most offers, so most of
            that scroll was reading past things nobody had set.

            ★ EACH HEADER CARRIES A SUMMARY OF WHAT IS INSIDE, which is what
            makes collapsing safe: a closed section still tells you it says
            "Any order" or "No limits", so nothing is hidden — only folded.

            ★ AND THE DEFAULTS DECIDE WHAT OPENS. A section at its defaults
            starts closed; one the merchant has actually configured starts
            open, so editing an existing offer never buries the part they came
            to change. Computed once from the initial form, never re-derived,
            or a section would slam shut while being typed into. */}
        <OfferSection
          title="What the customer gets"
          summary={givesSummary}
          defaultOpen
        >
          <fieldset className="mb-5">
            <legend className="sr-only">What the customer gets</legend>
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className={hintClass}>Discount</span>
                <select
                  className={fieldClass}
                  value={rewardFamily}
                  onChange={(e) => {
                    const next = e.target.value;
                    // Picking the family lands on the commoner of its two
                    // shapes; the type control below switches between them.
                    set(
                      "rewardType",
                      next === "coupon"
                        ? "percent_off"
                        : (next as OfferRewardType),
                    );
                  }}
                >
                  {/* ★★ GROUPED BY WHAT THE DISCOUNT ACTS ON, because eleven
                      flat options is a list you read three times to find the one
                      you want — and two of the names ("Buy X get Y", "Bundle
                      price") mean nothing until you know which group they are
                      in. `<optgroup>` is the native control for exactly this and
                      costs no JavaScript, no library and no custom keyboard
                      handling.

                      ★ ORDER IS BY HOW OFTEN IT IS REACHED FOR, not by the
                      order the phases shipped in: the two whole-order discounts
                      are what most merchants build first, and the ladders and
                      bundles are the long tail. */}
                  <optgroup label="Off the whole order">
                    <option value="coupon">
                      A coupon — a percentage or an amount off
                    </option>
                    <option value="tiered">
                      Spend more, save more (order levels)
                    </option>
                  </optgroup>
                  <optgroup label="Off chosen products">
                    <option value="percent_off_items">A percentage off</option>
                    <option value="fixed_price">A set price each</option>
                    <option value="buy_x_get_y">
                      Buy X, get Y free or discounted
                    </option>
                    <option value="volume_break">
                      Buy more, save more (quantity levels)
                    </option>
                    <option value="bundle_price">
                      Any few items for one price
                    </option>
                  </optgroup>
                  <optgroup label="Something extra, not a discount">
                    <option value="free_shipping">Free delivery</option>
                    <option value="free_item">A free gift</option>
                    <option value="credit_back">Store credit back</option>
                  </optgroup>
                </select>
              </label>
              {form.rewardType === "bundle_price" ? (
                <div className="sm:col-span-2 grid gap-4 sm:grid-cols-3">
                  {(
                    [
                      ["bundleQuantity", "How many items"],
                      ["bundlePrice", "Bundle price (₹)"],
                      ["maxSets", "Max bundles per order"],
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
                  <span className={`${hintClass} sm:col-span-3`}>
                    Items are counted across the basket, and the most expensive
                    qualifying ones go into the bundle — which gives the
                    customer the biggest saving and means a bundle can never
                    charge more than the items were worth. If they come to less
                    than the bundle price, the offer does not apply.{" "}
                    {form.maxSets > 0 ? (
                      <>
                        <strong>
                          Your limit of {form.maxSets}{" "}
                          {form.maxSets === 1 ? "bundle" : "bundles"} caps it
                        </strong>{" "}
                        — a bigger basket earns no more.
                      </>
                    ) : (
                      <>
                        It repeats for as long as the basket allows; a{" "}
                        <strong>total budget</strong> under Limits is the way to
                        bound what you give away.
                      </>
                    )}
                  </span>
                </div>
              ) : form.rewardType === "credit_back" ? (
                <div className="sm:col-span-2">
                  <label className="block max-w-[12rem]">
                    <span className={hintClass}>Store credit (₹)</span>
                    <input
                      className={fieldClass}
                      inputMode="numeric"
                      value={form.creditAmount || ""}
                      onChange={(e) =>
                        set(
                          "creditAmount",
                          Number(e.target.value.replace(/\D/g, "")) || 0,
                        )
                      }
                    />
                  </label>
                  <span className={hintClass}>
                    The customer pays full price today and receives store credit
                    afterwards. It does not reduce the order total, change the
                    tax or appear on the invoice, because nothing about what
                    they paid has changed.
                  </span>
                  <p className="mt-2 text-xs text-[#b45309]">
                    This is money you owe. Unlike a discount, which costs you
                    once, credit sits on the customer&rsquo;s account until they
                    spend it — set a budget if you want a ceiling on how much
                    you issue.
                  </p>
                </div>
              ) : form.rewardType === "free_item" ? (
                <div className="sm:col-span-2">
                  <label className="block">
                    <span className={hintClass}>The gift</span>
                    <select
                      className={fieldClass}
                      value={form.giftProductId}
                      onChange={(e) => set("giftProductId", e.target.value)}
                    >
                      <option value="">Choose a product…</option>
                      {products.map((pr) => (
                        <option key={pr.id} value={pr.id}>
                          {pr.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mt-3 block max-w-[10rem]">
                    <span className={hintClass}>How many</span>
                    <input
                      className={fieldClass}
                      inputMode="numeric"
                      value={form.giftQuantity || ""}
                      onChange={(e) =>
                        set(
                          "giftQuantity",
                          Number(e.target.value.replace(/\D/g, "")) || 0,
                        )
                      }
                    />
                  </label>
                  {/* ★★ THE TWO THINGS A MERCHANT WOULD OTHERWISE DISCOVER THE
                      HARD WAY, said before they save rather than after. */}
                  <span className={hintClass}>
                    The gift is added to the order at ₹0 and its stock is
                    reserved like any sold item, so it is taken off your shelf
                    and appears on the order and the receipt. The offer stops
                    applying on its own when the gift runs out — customers are
                    never promised one you cannot send.
                  </span>
                  <p className="mt-2 text-xs text-[#b45309]">
                    Tax on free goods: the line records the gift&rsquo;s own tax
                    class, and tax on a zero value is zero. Whether GST is due
                    on a free item given with a sale depends on your
                    circumstances — check with your accountant before relying on
                    this for a return.
                  </p>
                </div>
              ) : form.rewardType === "tiered" ||
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
                  {/* ★ SAYS WHAT THE BASKET ACTUALLY COSTS, in the shape a
                      merchant is picturing. "A set is 1 + 1 = 2 items" is the
                      mechanism; "4 items — the customer pays for 2" is the
                      outcome, and the outcome is what they came to check. */}
                  <span className={hintClass}>
                    A set is {form.buyQuantity || 0} + {form.getQuantity || 0} ={" "}
                    {setSize} items — so a basket of {setSize * 2} means the
                    customer pays for {(form.buyQuantity || 0) * 2} and{" "}
                    {(form.getQuantity || 0) * 2} come free. The cheapest
                    qualifying items are the discounted ones, counted across the
                    whole basket.{" "}
                    {form.maxSets > 0 ? (
                      <>
                        <strong>
                          Your limit of {form.maxSets}{" "}
                          {form.maxSets === 1 ? "set" : "sets"} caps that
                        </strong>{" "}
                        — however many they buy, only{" "}
                        {(form.getQuantity || 0) * form.maxSets} can ever be
                        free.
                      </>
                    ) : (
                      <>
                        It repeats for as long as the basket allows. To bound
                        what you give away, set a <strong>total budget</strong>{" "}
                        under Limits — it stops the offer at a rupee figure you
                        choose, rather than changing what it means.
                      </>
                    )}
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
              ) : isCouponReward ? (
                /* ★ THE COUPON'S OWN TYPE, beside its value. One control
                   decides which of the two shapes this is, and the field next
                   to it changes label and unit to match — so the pair reads as
                   one decision ("₹200 off" / "20% off") rather than as two
                   dropdown entries a merchant has to choose between before
                   they have seen either. */
                <>
                  <label className="block">
                    <span className={hintClass}>Coupon type</span>
                    <select
                      className={fieldClass}
                      value={form.rewardType}
                      onChange={(e) =>
                        set("rewardType", e.target.value as OfferRewardType)
                      }
                    >
                      <option value="percent_off">A percentage off</option>
                      <option value="amount_off">A fixed amount off</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className={hintClass}>
                      {form.rewardType === "amount_off"
                        ? "Amount (₹)"
                        : "Percentage"}
                    </span>
                    <input
                      className={fieldClass}
                      inputMode="numeric"
                      value={
                        (form.rewardType === "amount_off"
                          ? form.amount
                          : form.percent) || ""
                      }
                      onChange={(e) =>
                        set(
                          form.rewardType === "amount_off"
                            ? "amount"
                            : "percent",
                          Number(e.target.value.replace(/\D/g, "")) || 0,
                        )
                      }
                    />
                  </label>
                </>
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
        </OfferSection>

        <OfferSection
          title="When it applies"
          summary={whenSummary}
          defaultOpen={openWhen}
        >
          <fieldset className="mb-5">
            <legend className="sr-only">When it applies</legend>
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
          <ConditionsEditor form={form} setForm={setForm} />
        </OfferSection>

        <OfferSection
          title="Where and how it runs"
          summary={howSummary}
          defaultOpen
        >
          <fieldset className="mb-5">
            <legend className="sr-only">How customers get it</legend>
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
                {form.delivery === "automatic" && !autoApplyOn && (
                  <span className="mt-1 block text-[11px] text-amber-700">
                    Your store has automatic offers switched off, so this will
                    not apply to anything — online or at the till — however you
                    set it up here. Turn on{" "}
                    <Link
                      href="/dashboard/offers/settings"
                      className="underline"
                    >
                      “Apply offers automatically”
                    </Link>{" "}
                    to let it run, or give it a discount code instead.
                  </span>
                )}
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

            {/* ★★ ONLY FOR A COUPON ON A CODE. Publishing a code puts it in front
              of every visitor, and the cart can only preview an order-level
              percentage or amount — so a buy-X-get-Y on a code would be
              advertised, typed in, and refused. §23's rule: rather than a
              checkbox that sometimes produces a broken code, the control is
              absent — and `buildRow` forces the column false regardless,
              because a hidden field is not a boundary.

              ★ OFF BY DEFAULT, and that is the meaningful default rather than
              the timid one: a code is usually targeted — emailed to a segment,
              printed on a flyer — and listing it for every visitor destroys
              exactly the targeting the merchant set up. */}
            {form.delivery !== "automatic" && isCouponReward && (
              <label className="mt-3 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.showOnStorefront}
                  onChange={(e) => set("showOnStorefront", e.target.checked)}
                />
                <span>
                  Show this coupon on my storefront
                  <span className={hintClass}>
                    Lists the code in the cart under &ldquo;Available
                    coupons&rdquo;, so any shopper can apply it in one tap.
                    Leave it off for a code you only want to send to particular
                    customers.
                  </span>
                </span>
              </label>
            )}
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
        </OfferSection>

        <OfferSection
          title="Limits"
          summary={limitsSummary}
          defaultOpen={openLimits}
        >
          <fieldset className="mb-5">
            <legend className="sr-only">Limits</legend>
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
                    set(
                      "budget",
                      Number(e.target.value.replace(/\D/g, "")) || 0,
                    )
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
        </OfferSection>

        <div className="mb-5 mt-5 flex flex-wrap items-end gap-4">
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
