"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, ExternalLink, Truck } from "lucide-react";
import { toast } from "sonner";
import {
  saveShippingSettings,
  type ShippingSettingsState,
} from "@/app/actions/shipping-actions";
import type {
  CarrierAdjustmentType,
  ShippingRateMode,
  ShippingSettings,
} from "@/lib/shipping/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MODES: Array<{
  id: ShippingRateMode;
  title: string;
  description: string;
}> = [
  {
    id: "free",
    title: "Free shipping",
    description: "Charge ₹0 for every delivery order.",
  },
  {
    id: "flat",
    title: "Fixed rate",
    description: "Charge the same amount for every delivery order.",
  },
  {
    id: "shiprocket",
    title: "Live Shiprocket rates",
    description: "Show available couriers, their prices and delivery dates.",
  },
];

function numberValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ShippingSettingsView({
  initial,
  canManage,
}: {
  initial: ShippingSettingsState;
  canManage: boolean;
}) {
  const [settings, setSettings] = useState<ShippingSettings>(initial.settings);
  const [freeThreshold, setFreeThreshold] = useState(
    initial.settings.freeAbove !== null,
  );
  const [isPending, startTransition] = useTransition();

  const update = <K extends keyof ShippingSettings>(
    key: K,
    value: ShippingSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));

  const save = () => {
    startTransition(async () => {
      const result = await saveShippingSettings({
        ...settings,
        freeAbove:
          settings.mode !== "free" && freeThreshold
            ? settings.freeAbove || 500
            : null,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Shipping settings saved");
    });
  };

  return (
    <div className="dash-page-enter mx-auto w-full max-w-3xl pb-12">
      <header className="dash-page-header">
        <h1>Shipping &amp; delivery</h1>
        <p>Control the prices and delivery dates shown at checkout.</p>
      </header>

      <section className="dash-card mt-6 p-5">
        <div className="mb-4 flex items-start gap-3">
          <span className="rounded-lg bg-violet-50 p-2 text-violet-600">
            <Truck className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-[15px] font-semibold text-[#1a1a1a]">
              Checkout shipping rate
            </h2>
            <p className="mt-0.5 text-[13px] text-[#6a6a6a]">
              Choose one pricing method. Pickup orders always remain free.
            </p>
          </div>
        </div>

        <div className="grid gap-3">
          {MODES.map((mode) => {
            const active = settings.mode === mode.id;
            const disabled =
              !canManage ||
              (mode.id === "shiprocket" && !initial.shiprocketEnabled);
            return (
              <button
                key={mode.id}
                type="button"
                disabled={disabled}
                onClick={() => update("mode", mode.id)}
                className={`flex items-start gap-3 rounded-xl border p-4 text-left transition ${
                  active
                    ? "border-violet-500 bg-violet-50/60"
                    : "border-[#e5e5e5] bg-white hover:border-[#c9c9c9]"
                } disabled:cursor-not-allowed disabled:opacity-55`}
              >
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                    active
                      ? "border-violet-600 bg-violet-600 text-white"
                      : "border-[#bdbdbd]"
                  }`}
                >
                  {active ? <Check className="h-3 w-3" /> : null}
                </span>
                <span>
                  <span className="block text-[14px] font-medium text-[#1a1a1a]">
                    {mode.title}
                  </span>
                  <span className="mt-0.5 block text-[13px] text-[#6a6a6a]">
                    {mode.description}
                  </span>
                  {mode.id === "shiprocket" && !initial.shiprocketEnabled && (
                    <span className="mt-2 block text-[12px] font-medium text-amber-700">
                      Connect and enable Shiprocket in Channels first.
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {settings.mode === "flat" && (
          <div className="mt-5 max-w-xs">
            <Label htmlFor="flat-rate">Charge per order (₹)</Label>
            <Input
              id="flat-rate"
              type="number"
              min="0"
              step="0.01"
              className="mt-2"
              value={settings.flatRate}
              disabled={!canManage}
              onChange={(event) =>
                update("flatRate", numberValue(event.target.value))
              }
            />
          </div>
        )}

        {settings.mode === "shiprocket" && (
          <div className="mt-5 grid gap-5 border-t border-[#ededed] pt-5 sm:grid-cols-2">
            <div>
              <Label htmlFor="handling-days">Handling time (days)</Label>
              <Input
                id="handling-days"
                type="number"
                min="0"
                max="30"
                className="mt-2"
                value={settings.handlingDays}
                disabled={!canManage}
                onChange={(event) =>
                  update("handlingDays", numberValue(event.target.value))
                }
              />
              <p className="mt-1.5 text-[12px] text-[#777]">
                Added to Shiprocket&apos;s transit estimate for packing time.
              </p>
            </div>
            <div>
              <Label htmlFor="adjustment">Add to carrier price</Label>
              <div className="mt-2 flex gap-2">
                <select
                  id="adjustment"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={settings.carrierAdjustmentType}
                  disabled={!canManage}
                  onChange={(event) =>
                    update(
                      "carrierAdjustmentType",
                      event.target.value as CarrierAdjustmentType,
                    )
                  }
                >
                  <option value="none">Nothing</option>
                  <option value="fixed">Fixed ₹</option>
                  <option value="percentage">Percentage %</option>
                </select>
                {settings.carrierAdjustmentType !== "none" && (
                  <Input
                    aria-label="Rate adjustment"
                    type="number"
                    min="0"
                    step="0.01"
                    value={settings.carrierAdjustmentValue}
                    disabled={!canManage}
                    onChange={(event) =>
                      update(
                        "carrierAdjustmentValue",
                        numberValue(event.target.value),
                      )
                    }
                  />
                )}
              </div>
              <p className="mt-1.5 text-[12px] text-[#777]">
                Optional packaging or handling markup paid by the customer.
              </p>
            </div>
            <label className="flex items-center gap-3 text-[13px] sm:col-span-2">
              <input
                type="checkbox"
                checked={settings.showAllCouriers}
                disabled={!canManage}
                onChange={(event) =>
                  update("showAllCouriers", event.target.checked)
                }
              />
              Let customers choose from up to five couriers (otherwise show the
              cheapest only)
            </label>
          </div>
        )}
      </section>

      <section className="dash-card mt-5 p-5">
        <h2 className="text-[15px] font-semibold text-[#1a1a1a]">
          Free-shipping threshold
        </h2>
        <p className="mt-1 text-[13px] text-[#6a6a6a]">
          Optional. The basket subtotal is checked before coupon discounts.
        </p>
        <label className="mt-4 flex items-center gap-3 text-[14px]">
          <input
            type="checkbox"
            checked={freeThreshold}
            disabled={!canManage || settings.mode === "free"}
            onChange={(event) => {
              setFreeThreshold(event.target.checked);
              if (event.target.checked && settings.freeAbove === null) {
                update("freeAbove", 500);
              }
            }}
          />
          Free shipping when the basket reaches
        </label>
        {freeThreshold && settings.mode !== "free" && (
          <div className="mt-3 max-w-xs">
            <Label htmlFor="free-above">Basket subtotal (₹)</Label>
            <Input
              id="free-above"
              type="number"
              min="1"
              step="0.01"
              className="mt-2"
              value={settings.freeAbove ?? 500}
              disabled={!canManage}
              onChange={(event) =>
                update("freeAbove", numberValue(event.target.value))
              }
            />
          </div>
        )}
      </section>

      {settings.mode !== "shiprocket" && (
        <section className="dash-card mt-5 p-5">
          <h2 className="text-[15px] font-semibold text-[#1a1a1a]">
            Delivery estimate
          </h2>
          <p className="mt-1 text-[13px] text-[#6a6a6a]">
            Shown beside the manual rate at checkout.
          </p>
          <div className="mt-4 grid max-w-md grid-cols-2 gap-4">
            <div>
              <Label htmlFor="min-days">Minimum days</Label>
              <Input
                id="min-days"
                type="number"
                min="0"
                max="60"
                className="mt-2"
                value={settings.manualMinDays}
                disabled={!canManage}
                onChange={(event) =>
                  update("manualMinDays", numberValue(event.target.value))
                }
              />
            </div>
            <div>
              <Label htmlFor="max-days">Maximum days</Label>
              <Input
                id="max-days"
                type="number"
                min="0"
                max="90"
                className="mt-2"
                value={settings.manualMaxDays}
                disabled={!canManage}
                onChange={(event) =>
                  update("manualMaxDays", numberValue(event.target.value))
                }
              />
            </div>
          </div>
        </section>
      )}

      <div className="mt-5 flex items-center justify-between gap-4">
        <Link
          href="/dashboard/channels"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-violet-700"
        >
          Manage Shiprocket connection <ExternalLink className="h-3.5 w-3.5" />
        </Link>
        <Button onClick={save} disabled={!canManage || isPending}>
          {isPending ? "Saving…" : "Save shipping settings"}
        </Button>
      </div>

      {!canManage && (
        <p className="mt-3 text-right text-[12px] text-[#777]">
          You can view these settings, but your role cannot change them.
        </p>
      )}
    </div>
  );
}
