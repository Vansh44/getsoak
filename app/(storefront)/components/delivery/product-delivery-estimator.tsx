"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  MapPin,
  Truck,
} from "lucide-react";
import {
  getProductDeliveryEstimate,
  type ProductDeliveryEstimate,
} from "@/app/actions/shipping-actions";
import { formatPrice } from "@/lib/pricing";
import { useDeliveryLocation } from "./delivery-location-provider";

export function ProductDeliveryEstimator({
  productId,
  variantId,
  quantity,
  outOfStock,
}: {
  productId: string;
  variantId: string | null;
  quantity: number;
  outOfStock: boolean;
}) {
  const { location, setPostalCode } = useDeliveryLocation();
  const [postalCodeDraft, setPostalCodeDraft] = useState("");
  const [editingPostalCode, setEditingPostalCode] = useState(false);
  const [estimate, setEstimate] = useState<ProductDeliveryEstimate | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();
  const requestRef = useRef(0);
  const postalCode = editingPostalCode
    ? postalCodeDraft
    : (location?.postalCode ?? "");

  const check = (value: string, remember: boolean) => {
    if (!/^\d{6}$/.test(value) || outOfStock) return;
    if (remember) setPostalCode(value);
    const request = ++requestRef.current;
    startTransition(async () => {
      const result = await getProductDeliveryEstimate({
        productId,
        variantId,
        quantity,
        postalCode: value,
      });
      if (request === requestRef.current) setEstimate(result);
    });
  };

  // A remembered/saved header location should make every PDP useful without a
  // second input. Re-check when the selected variant or quantity changes.
  useEffect(() => {
    if (!location?.postalCode || outOfStock) return;
    const timer = window.setTimeout(
      () => check(location.postalCode, false),
      250,
    );
    return () => window.clearTimeout(timer);
    // check intentionally reads only the current render's identifiers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.postalCode, productId, variantId, quantity, outOfStock]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    check(postalCode, true);
    setEditingPostalCode(false);
  };

  const option = estimate?.option;

  return (
    <section className="pdp-delivery" aria-labelledby="pdp-delivery-title">
      <div className="pdp-delivery-heading">
        <Truck size={19} aria-hidden />
        <strong id="pdp-delivery-title">Delivery details</strong>
      </div>
      <form className="pdp-delivery-form" onSubmit={submit}>
        <MapPin size={18} aria-hidden />
        <input
          value={postalCode}
          onChange={(event) => {
            setPostalCodeDraft(
              event.target.value.replace(/\D/g, "").slice(0, 6),
            );
            setEditingPostalCode(true);
          }}
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="Enter delivery PIN code"
          aria-label="Delivery PIN code"
        />
        <button
          type="submit"
          disabled={isPending || !/^\d{6}$/.test(postalCode) || outOfStock}
        >
          {isPending ? "Checking…" : "Check"}
        </button>
      </form>

      {isPending && (
        <div className="pdp-delivery-result is-loading" aria-live="polite">
          <Loader2 size={17} className="pdp-delivery-spinner" aria-hidden />
          Checking warehouse stock and couriers…
        </div>
      )}

      {!isPending && estimate && (
        <div
          className={`pdp-delivery-result ${estimate.available ? "is-available" : "is-unavailable"}`}
          aria-live="polite"
        >
          {estimate.available ? (
            <CheckCircle2 size={18} aria-hidden />
          ) : (
            <AlertCircle size={18} aria-hidden />
          )}
          <div>
            {estimate.available && option ? (
              <>
                <strong>{option.description}</strong>
                <span>
                  {option.amount === 0
                    ? "Free delivery"
                    : `${formatPrice(option.amount)} delivery`}
                  {option.courierName ? ` · ${option.courierName}` : ""}
                  {estimate.alternativeCount
                    ? ` · ${estimate.alternativeCount} more at checkout`
                    : ""}
                </span>
              </>
            ) : (
              <strong>{estimate.error ?? "Delivery is unavailable."}</strong>
            )}
          </div>
        </div>
      )}

      {!estimate && !isPending && (
        <p className="pdp-delivery-hint">
          Check availability, shipping charge and estimated delivery time.
        </p>
      )}
    </section>
  );
}
