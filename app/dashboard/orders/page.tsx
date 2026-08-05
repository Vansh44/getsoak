import { getOrders } from "@/app/actions/order-actions";
import {
  DASHBOARD_PAGE_SIZE,
  pickPage,
  pickParam,
} from "@/app/dashboard/lib/list-params";
import { OrdersManagementView } from "./orders-management-view";
import { RealtimeRefresher } from "../components/realtime-refresher";

export interface ShippingAddress {
  firstName?: string;
  lastName?: string;
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
  const pageSize = DASHBOARD_PAGE_SIZE;

  const { orders, total, counts, error } = await getOrders({
    page,
    pageSize,
    status,
    paymentStatus,
    paymentMethod,
    q,
    dateRange,
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
        orders={orders as unknown as OrderRow[]}
        total={total}
        counts={counts}
        page={page}
        pageSize={pageSize}
        query={q}
        status={status}
        paymentStatus={paymentStatus}
        paymentMethod={paymentMethod}
        dateRange={dateRange}
      />
    </>
  );
}
