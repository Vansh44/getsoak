"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import {
  createCoupon,
  updateCoupon,
  type CouponFormData,
} from "@/app/actions/coupon-actions";
import type { Coupon, CouponGroup } from "./page";

type Props = {
  coupon: Coupon | null;
  groups: CouponGroup[];
  allowsGroups?: boolean;
};

const LIST_HREF = "/dashboard/marketing/coupons";

const fieldClass =
  "w-full rounded-md border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#1f2937] outline-none placeholder:text-[#9ca3af] focus:border-[#4f46e5]";
const labelClass =
  "mb-1.5 block text-xs font-medium uppercase tracking-wide text-[#6b7280]";

// ISO timestamp -> yyyy-mm-dd for <input type="date">.
function toDateInput(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function initialForm(coupon: Coupon | null): CouponFormData {
  if (!coupon) {
    return {
      code: "",
      description: "",
      discount_type: "percentage",
      discount_value: 10,
      min_order_amount: 0,
      max_uses: 0,
      valid_from: "",
      valid_until: "",
      status: "active",
      show_on_storefront: false,
      restricted_group_ids: [],
    };
  }
  return {
    code: coupon.code,
    description: coupon.description ?? "",
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    min_order_amount: coupon.min_order_amount,
    max_uses: coupon.max_uses,
    valid_from: toDateInput(coupon.valid_from),
    valid_until: toDateInput(coupon.valid_until),
    status: coupon.status,
    show_on_storefront: coupon.show_on_storefront ?? false,
    restricted_group_ids: coupon.restricted_group_ids ?? [],
  };
}

export function CouponForm({ coupon, groups, allowsGroups = true }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<CouponFormData>(() => initialForm(coupon));
  const [isPending, startTransition] = useTransition();
  const isEditing = !!coupon;

  const set = <K extends keyof CouponFormData>(
    key: K,
    value: CouponFormData[K],
  ) => setForm((f) => ({ ...f, [key]: value }));

  const toggleGroup = (id: string) =>
    setForm((f) => {
      const cur = f.restricted_group_ids ?? [];
      return {
        ...f,
        restricted_group_ids: cur.includes(id)
          ? cur.filter((g) => g !== id)
          : [...cur, id],
      };
    });

  const isPercentage = form.discount_type === "percentage";

  const handleSave = () => {
    if (!form.code.trim()) {
      toast.error("Coupon code is required");
      return;
    }
    startTransition(async () => {
      const result = isEditing
        ? await updateCoupon(coupon!.id, form)
        : await createCoupon(form);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(isEditing ? "Coupon updated" : "Coupon created");
        router.push(LIST_HREF);
        router.refresh();
      }
    });
  };

  return (
    <div className="dash-page-enter">
      <header className="dash-page-header">
        <Link
          href={LIST_HREF}
          className="mb-2 inline-flex items-center gap-1 text-sm text-[#6b7280] hover:text-[#4f46e5]"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to coupons
        </Link>
        <h1>{isEditing ? "Edit coupon" : "New coupon"}</h1>
        <p>Discount codes shoppers can apply in the cart.</p>
      </header>

      <div className="dash-card max-w-[640px] p-6">
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Code *</label>
            <input
              className={`${fieldClass} font-mono uppercase`}
              value={form.code}
              onChange={(e) => set("code", e.target.value.toUpperCase())}
              placeholder="e.g. SUMMER25"
            />
            <p className="mt-1 text-[11px] text-[#9ca3af]">
              Case-insensitive. Shoppers type this exactly.
            </p>
          </div>

          <div>
            <label className={labelClass}>Description</label>
            <input
              className={fieldClass}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Optional — internal note (e.g. Summer sale)"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Discount type</label>
              <select
                className={fieldClass}
                value={form.discount_type}
                onChange={(e) =>
                  set("discount_type", e.target.value as "percentage" | "fixed")
                }
              >
                <option value="percentage">Percentage (%)</option>
                <option value="fixed">Fixed amount (₹)</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>
                {isPercentage ? "Percent off" : "Amount off (₹)"} *
              </label>
              <NumberField
                className={fieldClass}
                value={form.discount_value}
                onValueChange={(n) => set("discount_value", n)}
                allowDecimal={!isPercentage}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Min order (₹)</label>
              <NumberField
                className={fieldClass}
                value={form.min_order_amount}
                onValueChange={(n) => set("min_order_amount", n)}
                allowDecimal={false}
              />
              <p className="mt-1 text-[11px] text-[#9ca3af]">0 = no minimum</p>
            </div>
            <div>
              <label className={labelClass}>Max uses</label>
              <NumberField
                className={fieldClass}
                value={form.max_uses}
                onValueChange={(n) => set("max_uses", n)}
                allowDecimal={false}
              />
              <p className="mt-1 text-[11px] text-[#9ca3af]">0 = unlimited</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Valid from</label>
              <input
                type="date"
                className={fieldClass}
                value={form.valid_from}
                onChange={(e) => set("valid_from", e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>Valid until</label>
              <input
                type="date"
                className={fieldClass}
                value={form.valid_until}
                onChange={(e) => set("valid_until", e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Status</label>
            <select
              className={fieldClass}
              value={form.status}
              onChange={(e) =>
                set("status", e.target.value as "active" | "disabled")
              }
            >
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-[#1f2937]">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-[#d1d5db] text-[#4f46e5] focus:ring-[#4f46e5]"
                checked={form.show_on_storefront}
                onChange={(e) => set("show_on_storefront", e.target.checked)}
              />
              Show on Storefront
            </label>
            <p className="mt-1 text-[11px] text-[#9ca3af] ml-6">
              If checked, this coupon will be shown as an option in the
              shopper&apos;s cart. (This is overridden if the global &quot;Show
              all coupons&quot; setting is on).
            </p>
          </div>

          <div>
            <label className={labelClass}>Restrict to user groups</label>
            {!allowsGroups ? (
              <p className="rounded-md border border-[#e5e7eb] bg-[#f9fafb] p-3 text-xs text-[#6b7280]">
                Customer-group targeting is available on Basic and Pro. Any
                restrictions saved before a downgrade are retained and return
                when the store upgrades.{" "}
                <Link
                  href="/dashboard/plans"
                  className="font-semibold text-[#4f46e5]"
                >
                  View plans
                </Link>
              </p>
            ) : groups.length === 0 ? (
              <p className="text-[11px] text-[#9ca3af]">
                No user groups yet. Create groups under Users → User Groups to
                limit a coupon to specific customers.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {groups.map((g) => {
                    const on = (form.restricted_group_ids ?? []).includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => toggleGroup(g.id)}
                        className={`rounded-full border px-3 py-1 text-xs transition ${
                          on
                            ? "border-[#4f46e5] bg-[#eef2ff] text-[#4f46e5]"
                            : "border-[#e5e7eb] text-[#6b7280] hover:border-[#c7d2fe]"
                        }`}
                      >
                        {g.name}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[11px] text-[#9ca3af]">
                  {(form.restricted_group_ids ?? []).length === 0
                    ? "Empty = everyone can use this coupon."
                    : "Only signed-in customers in the selected group(s) can apply this code."}
                </p>
              </>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-[#f0f0f0] pt-4">
          <Button
            variant="outline"
            onClick={() => router.push(LIST_HREF)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending
              ? "Saving..."
              : isEditing
                ? "Save changes"
                : "Create coupon"}
          </Button>
        </div>
      </div>
    </div>
  );
}
