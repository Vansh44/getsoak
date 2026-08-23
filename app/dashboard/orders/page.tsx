import { getOrders, type OrderChannel } from "@/app/actions/order-actions";
import {
  DASHBOARD_PAGE_SIZE,
  pickPage,
  pickParam,
} from "@/app/dashboard/lib/list-params";
import { OrdersManagementView } from "./orders-management-view";
import { RealtimeRefresher } from "../components/realtime-refresher";
import { getCurrentStore } from "@/lib/store/resolve";
import { getPosState } from "@/lib/pos/locations";

export interface ShippingAddress {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
}

export interface OrderRow {
  id: string;
  order_no: number;
  order_ref: string;
  created_at: string;
  total: number;
  payment_method: string;
  payment_status: string;
  status: string;
  shipping_address: ShippingAddress | null;
  sales_channel: string;
  receipt_no: string | null;
  cashier_name: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  location_name: string | null;
  /** 'delivery' for everything that isn't a collection. */
  fulfilment_type: string;
  pickup_status: string | null;
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const page = pickPage(sp.page);
  const q = pickParam(sp.q);
  const status = pickParam(sp.status);
  const paymentStatus = pickParam(sp.payment);
  const paymentMethod = pickParam(sp.method);
  const dateRange = pickParam(sp.date);
  const supportsPos = getPosState(await getCurrentStore()).posEnabled;
  const channelParam = pickParam(sp.channel);
  const requestedChannel: OrderChannel =
    channelParam === "website" || channelParam === "pos" ? channelParam : "all";
  const channel: OrderChannel = supportsPos ? requestedChannel : "website";
  const pageSize = DASHBOARD_PAGE_SIZE;

  const { orders, total, counts, channelCounts, error } = await getOrders({
    page,
    pageSize,
    status,
    paymentStatus,
    paymentMethod,
    q,
    dateRange,
    channel,
  });

  if (error) {
    return (
      <div className="p-8">
        <div className="bg-red-50 text-red-600 p-4 rounded-lg">
          Error loading orders: {error}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Live updates: re-fetch the list when an order is placed/updated. */}
      <RealtimeRefresher tables={["orders"]} />
      <OrdersManagementView
        key={channel}
        orders={orders as unknown as OrderRow[]}
        total={total}
        counts={counts}
        channelCounts={channelCounts}
        page={page}
        pageSize={pageSize}
        query={q}
        status={status}
        paymentStatus={paymentStatus}
        paymentMethod={paymentMethod}
        dateRange={dateRange}
        channel={channel}
        supportsPos={supportsPos}
      />
    </>
  );
}
