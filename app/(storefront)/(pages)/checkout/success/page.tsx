import Link from "next/link";
import { CheckCircle, Store } from "lucide-react";
import { getMyOrder } from "@/app/actions/customer-order-actions";
import { locationAddressLines } from "@/lib/locations/address";
import { pickupNote } from "@/app/(storefront)/(pages)/orders/order-status";
import { ReconcilePayment } from "./reconcile-payment";

export const dynamic = "force-dynamic";

/**
 * The order confirmation.
 *
 * ★ A SERVER component, deliberately. It used to be client-only, reading the
 * reference out of the query string and showing nothing else — so a shopper who
 * had just chosen to collect in store was told "we'll begin processing it
 * shortly" and given no shop, no address and no deadline, at the exact moment
 * they most want all three. Loading the order here puts the collection details
 * in the FIRST paint instead of flashing a bare reference.
 *
 * The order is fetched through `getMyOrder`, which is owner-gated and
 * store-scoped — so a guessed id in the URL still resolves to nothing.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string; ref?: string; pm?: string }>;
}) {
  const sp = await searchParams;
  const orderId = sp.orderId ?? "";
  const paidOnline = sp.pm === "rzp";

  const order = orderId ? (await getMyOrder(orderId)).order : null;
  // The query string is the fallback, not the source: it survives a reload
  // even if the lookup fails, and it is all an older confirmation link carries.
  const orderRef = order?.order_ref || sp.ref || orderId;
  const isPickup = order?.fulfilment_type === "pickup";

  return (
    <main>
      {paidOnline && orderId && <ReconcilePayment orderId={orderId} />}

      <div className="max-w-xl mx-auto px-4 py-24 text-center">
        <CheckCircle className="w-20 h-20 text-green-500 mx-auto mb-6" />
        <h1 className="text-4xl font-bold mb-4">Order Confirmed!</h1>
        <p className="text-muted-foreground text-lg mb-8">
          {isPickup
            ? "Thank you for your purchase. We'll have it packed and ready for you to collect."
            : "Thank you for your purchase. We have received your order and will begin processing it shortly."}
        </p>

        {orderRef && (
          <div className="bg-muted/30 p-4 rounded-lg mb-8 inline-block text-left">
            <p className="text-sm text-muted-foreground mb-1">
              Order Reference
            </p>
            <p className="font-mono font-medium text-lg">{orderRef}</p>
          </div>
        )}

        {/* Where to go and by when — the whole reason this page needed the
            order. Left-aligned because it is an address, not a headline. */}
        {isPickup && order && (
          <div className="mb-8 rounded-lg border border-border p-5 text-left">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <Store size={15} aria-hidden />
              Collect from
            </div>
            <p className="text-base font-semibold">
              {order.pickup_location_name ?? "Our shop"}
            </p>
            {locationAddressLines(order.pickup_location_address).map(
              (line, i) => (
                <p key={i} className="text-sm text-muted-foreground">
                  {line}
                </p>
              ),
            )}
            <p className="mt-3 text-sm">{pickupNote(order)}</p>
          </div>
        )}

        <div className="space-y-4">
          {/* Themed on the storefront accent (matches the checkout "Place Order"
              button). Color is set via inline style so it beats the storefront's
              `.storefront-root a { color: inherit }` rule (which would otherwise
              drag the text to dark ink on this accent-filled button). */}
          <Link
            href="/shop"
            className="inline-flex w-full items-center justify-center rounded-[var(--sm-radius-control)] bg-[var(--sm-accent)] px-8 py-3.5 text-base font-semibold transition-colors hover:bg-[var(--sm-accent-deep)] sm:w-auto"
            style={{ color: "var(--sm-on-accent)" }}
          >
            Continue Shopping
          </Link>
          {orderId && (
            <div className="flex flex-col items-center gap-2">
              {/* The order now has a permanent home, so the confirmation isn't
                  the only place a shopper can ever see it. */}
              <Link
                href={`/orders/${orderId}`}
                className="text-sm font-medium underline underline-offset-4"
                style={{ color: "var(--sm-accent)" }}
              >
                Track this order
              </Link>
              <Link
                href={`/checkout/invoice/${orderId}`}
                className="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                View / download invoice
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
