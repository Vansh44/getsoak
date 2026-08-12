"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  PackageCheck,
  RefreshCw,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import {
  bookShiprocketShipment,
  cancelShipment,
  createManualShipment,
  getOrderLogisticsView,
  refreshShipmentTracking,
  retryShiprocketShipment,
  scheduleShipmentPickup,
  submitShipmentNdrAction,
  type OrderLogisticsView,
  type ParcelInput,
  type ShipmentView,
} from "@/app/actions/shipment-actions";

export function ShipmentPanel({
  orderId,
  onChanged,
}: {
  orderId: string;
  onChanged: () => void;
}) {
  const [view, setView] = useState<OrderLogisticsView | null>(null);
  const [parcel, setParcel] = useState<ParcelInput>({
    weightGrams: 500,
    lengthCm: 10,
    widthCm: 10,
    heightCm: 5,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [courier, setCourier] = useState("");
  const [awb, setAwb] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");

  const load = useCallback(async () => {
    const result = await getOrderLogisticsView(orderId);
    if (result.error) toast.error(result.error);
    if (result.data) {
      setView(result.data);
      setParcel(result.data.defaults);
    }
  }, [orderId]);

  useEffect(() => {
    let cancelled = false;
    getOrderLogisticsView(orderId).then((result) => {
      if (cancelled) return;
      if (result.error) toast.error(result.error);
      if (result.data) {
        setView(result.data);
        setParcel(result.data.defaults);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  async function run(
    key: string,
    action: () => Promise<{ success?: boolean; error?: string }>,
    success: string,
  ) {
    setBusy(key);
    const result = await action();
    setBusy(null);
    if (result.error) toast.error(result.error);
    else toast.success(success);
    await load();
    onChanged();
  }

  if (!view) {
    return (
      <div className="flex h-20 items-center justify-center rounded-lg border border-border">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <section>
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Truck className="h-4 w-4" /> Logistics
      </div>
      <div className="mt-2 space-y-3">
        {view.shipments.map((shipment) => (
          <ShipmentCard
            key={shipment.id}
            shipment={shipment}
            busy={busy === shipment.id}
            onRun={(action, message) => run(shipment.id, action, message)}
          />
        ))}

        {view.shipments.length === 0 && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-sm font-medium text-foreground">
              Pack at {view.locationName ?? "the assigned warehouse"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Confirm the packed parcel measurements. Shiprocket uses them to
              select and bill the courier.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Measure
                label="Weight (g)"
                value={parcel.weightGrams}
                onChange={(value) =>
                  setParcel((p) => ({ ...p, weightGrams: value }))
                }
              />
              <Measure
                label="Length (cm)"
                value={parcel.lengthCm}
                onChange={(value) =>
                  setParcel((p) => ({ ...p, lengthCm: value }))
                }
              />
              <Measure
                label="Width (cm)"
                value={parcel.widthCm}
                onChange={(value) =>
                  setParcel((p) => ({ ...p, widthCm: value }))
                }
              />
              <Measure
                label="Height (cm)"
                value={parcel.heightCm}
                onChange={(value) =>
                  setParcel((p) => ({ ...p, heightCm: value }))
                }
              />
            </div>

            {!view.connected && (
              <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                Connect and enable Shiprocket in Channels to book automatically.
              </p>
            )}
            {view.connected && !view.mapped && (
              <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                Sync this warehouse in Channels before booking.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="dash-btn dash-btn-primary"
                disabled={busy !== null || !view.connected || !view.mapped}
                onClick={() =>
                  run(
                    "book",
                    () => bookShiprocketShipment(orderId, parcel),
                    "Shipment booked and label generated.",
                  )
                }
              >
                {busy === "book" ? "Booking…" : "Book with Shiprocket"}
              </button>
              <button
                type="button"
                className="dash-btn"
                onClick={() => setManual((value) => !value)}
                disabled={busy !== null}
              >
                Use another courier
              </button>
            </div>

            {manual && (
              <div className="mt-3 space-y-2 border-t border-border pt-3">
                <input
                  className="dash-input w-full"
                  placeholder="Courier name"
                  value={courier}
                  onChange={(event) => setCourier(event.target.value)}
                />
                <input
                  className="dash-input w-full"
                  placeholder="Tracking / AWB number"
                  value={awb}
                  onChange={(event) => setAwb(event.target.value)}
                />
                <input
                  className="dash-input w-full"
                  placeholder="Tracking URL (optional)"
                  value={trackingUrl}
                  onChange={(event) => setTrackingUrl(event.target.value)}
                />
                <button
                  type="button"
                  className="dash-btn dash-btn-primary"
                  disabled={busy !== null || !courier.trim() || !awb.trim()}
                  onClick={() =>
                    run(
                      "manual",
                      () =>
                        createManualShipment(orderId, {
                          ...parcel,
                          courierName: courier,
                          awb,
                          trackingUrl,
                        }),
                      "Manual shipment saved and order marked shipped.",
                    )
                  }
                >
                  Mark handed to courier
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Measure({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="text-xs text-muted-foreground">
      {label}
      <input
        type="number"
        min="0.01"
        step="0.01"
        className="dash-input mt-1 w-full"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function ShipmentCard({
  shipment,
  busy,
  onRun,
}: {
  shipment: ShipmentView;
  busy: boolean;
  onRun: (
    action: () => Promise<{ success?: boolean; error?: string }>,
    success: string,
  ) => void;
}) {
  const beforePickup = [
    "booking",
    "ready_to_ship",
    "pickup_scheduled",
    "error",
  ].includes(shipment.status);
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 font-medium text-foreground">
            <PackageCheck className="h-4 w-4 text-indigo-600" />
            {shipment.statusLabel}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {shipment.courierName ??
              (shipment.provider === "manual"
                ? "Manual courier"
                : "Shiprocket")}
            {shipment.awb ? ` · AWB ${shipment.awb}` : ""}
          </div>
        </div>
        {busy && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {shipment.lastError && (
        <div className="mt-2 flex gap-2 rounded-md bg-rose-50 p-2 text-xs text-rose-700">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {shipment.lastError}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {shipment.status === "error" && shipment.provider === "shiprocket" && (
          <button
            type="button"
            className="dash-btn dash-btn-primary"
            disabled={busy}
            onClick={() =>
              onRun(
                () => retryShiprocketShipment(shipment.id),
                "Shipment booking resumed.",
              )
            }
          >
            Retry booking
          </button>
        )}
        {shipment.status === "ready_to_ship" &&
          shipment.provider === "shiprocket" && (
            <button
              type="button"
              className="dash-btn dash-btn-primary"
              disabled={busy}
              onClick={() =>
                onRun(
                  () => scheduleShipmentPickup(shipment.id),
                  "Courier pickup scheduled.",
                )
              }
            >
              Schedule pickup
            </button>
          )}
        {shipment.provider === "shiprocket" && shipment.awb && (
          <button
            type="button"
            className="dash-btn"
            disabled={busy}
            onClick={() =>
              onRun(
                () => refreshShipmentTracking(shipment.id),
                "Tracking refreshed.",
              )
            }
          >
            <RefreshCw className="mr-1 inline h-3.5 w-3.5" /> Refresh
          </button>
        )}
        {shipment.labelUrl && (
          <ExternalLinkButton href={shipment.labelUrl}>
            Label
          </ExternalLinkButton>
        )}
        {shipment.manifestUrl && (
          <ExternalLinkButton href={shipment.manifestUrl}>
            Manifest
          </ExternalLinkButton>
        )}
        {shipment.trackingUrl && (
          <ExternalLinkButton href={shipment.trackingUrl}>
            Track
          </ExternalLinkButton>
        )}
        {beforePickup && (
          <button
            type="button"
            className="rounded-md px-2 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
            disabled={busy}
            onClick={() =>
              onRun(() => cancelShipment(shipment.id), "Shipment cancelled.")
            }
          >
            Cancel shipment
          </button>
        )}
      </div>

      {shipment.status === "ndr" && (
        <div className="mt-3 rounded-md bg-amber-50 p-2">
          <p className="text-xs font-medium text-amber-900">
            Delivery attempt needs a decision
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="dash-btn"
              disabled={busy}
              onClick={() => {
                const note = window.prompt(
                  "Instructions for the courier",
                  "Please re-attempt delivery",
                );
                if (note !== null)
                  onRun(
                    () =>
                      submitShipmentNdrAction(shipment.id, "re-attempt", note),
                    "Re-attempt requested.",
                  );
              }}
            >
              Re-attempt
            </button>
            <button
              type="button"
              className="dash-btn"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm("Return this parcel to the origin warehouse?")
                )
                  onRun(
                    () =>
                      submitShipmentNdrAction(
                        shipment.id,
                        "return",
                        "Return to origin requested by merchant",
                      ),
                    "Return requested.",
                  );
              }}
            >
              Return to origin
            </button>
          </div>
        </div>
      )}

      {shipment.events.length > 0 && (
        <ol className="mt-3 space-y-2 border-l border-border pl-3">
          {shipment.events.slice(0, 5).map((event) => (
            <li key={event.id} className="text-xs">
              <p className="font-medium text-foreground">
                {event.description ?? event.status.replaceAll("_", " ")}
              </p>
              <p className="text-muted-foreground">
                {new Date(event.occurredAt).toLocaleString("en-IN")}
                {event.location ? ` · ${event.location}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ExternalLinkButton({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="dash-btn">
      {children} <ExternalLink className="ml-1 inline h-3.5 w-3.5" />
    </a>
  );
}
