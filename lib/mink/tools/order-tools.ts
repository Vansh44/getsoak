import "server-only";

import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { orders, users } from "@/drizzle/schema";
import { parseAnalyticsRange } from "@/lib/analytics/range";
import { withUser } from "@/lib/db/client";
import { MinkToolInputError } from "../errors";
import type { MinkActorContext, MinkArtifact } from "../types";
import {
  resolveMinkLocation,
  type MinkResolvedLocation,
} from "./location-scope";
import type { MinkTool } from "./registry";

const PERIODS = ["today", "yesterday", "7d", "30d", "mtd", "ytd"] as const;
const CHANNELS = ["all", "online", "pos"] as const;
const STATUSES = [
  "all",
  "pending",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "completed",
  "refunded",
] as const;

interface CompactOrder {
  id: string;
  reference: string;
  status: string;
  paymentStatus: string;
  channel: string;
  total: number;
  currency: string;
  createdAt: string;
  customer: string;
  dashboardPath: string;
}

export function minkCustomerLabel(
  actor: Pick<MinkActorContext, "permissions" | "isSuperadmin">,
  customer: { firstName: string | null; lastName: string | null } | null,
): string {
  if (!can(actor.permissions, "users", "view", actor.isSuperadmin)) {
    return "Customer details hidden";
  }
  const first = customer?.firstName?.trim();
  const lastInitial = customer?.lastName?.trim().slice(0, 1);
  if (!first) return "Guest customer";
  return lastInitial ? `${first} ${lastInitial}.` : first;
}

async function readOrders(
  actor: MinkActorContext,
  input: {
    period: (typeof PERIODS)[number];
    channel: (typeof CHANNELS)[number];
    status: (typeof STATUSES)[number];
    location: MinkResolvedLocation;
    limit: number;
    selectedId?: string;
  },
) {
  const range = parseAnalyticsRange(
    { range: input.period, compare: "none" },
    actor.analyticsTimeZone,
  );
  const locationCondition =
    input.location.locationIds === null
      ? undefined
      : input.location.includeUnassigned
        ? input.location.locationIds.length
          ? or(
              isNull(orders.locationId),
              inArray(orders.locationId, input.location.locationIds),
            )
          : isNull(orders.locationId)
        : input.location.locationIds.length
          ? inArray(orders.locationId, input.location.locationIds)
          : sql`false`;
  const rows = await withUser(
    { uid: actor.adminId, email: actor.email },
    (db) =>
      db
        .select({
          id: orders.id,
          reference: orders.orderRef,
          status: orders.status,
          paymentStatus: orders.paymentStatus,
          channel: orders.salesChannel,
          total: orders.total,
          currency: orders.currency,
          createdAt: orders.createdAt,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(orders)
        .leftJoin(
          users,
          and(
            eq(users.id, orders.customerId),
            eq(users.storeId, actor.storeId),
          ),
        )
        .where(
          and(
            eq(orders.storeId, actor.storeId),
            ...(input.selectedId ? [eq(orders.id, input.selectedId)] : []),
            ...(!input.selectedId
              ? [
                  gte(orders.createdAt, range.current.from.toISOString()),
                  lt(orders.createdAt, range.current.to.toISOString()),
                ]
              : []),
            ...(input.channel === "all"
              ? []
              : [eq(orders.salesChannel, input.channel)]),
            ...(input.status === "all"
              ? []
              : [eq(orders.status, input.status)]),
            ...(locationCondition ? [locationCondition] : []),
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(input.limit),
  );
  const compact: CompactOrder[] = rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    status: row.status,
    paymentStatus: row.paymentStatus,
    channel: row.channel,
    total: Number(row.total),
    currency: row.currency,
    createdAt: row.createdAt,
    customer: minkCustomerLabel(actor, {
      firstName: row.firstName,
      lastName: row.lastName,
    }),
    dashboardPath: `/dashboard/orders?q=${encodeURIComponent(row.reference)}`,
  }));
  return {
    period: input.period,
    range: {
      label: range.label,
      fromInclusive: range.current.from.toISOString(),
      toExclusive: range.current.to.toISOString(),
      timeZone: range.timeZone,
    },
    channel: input.channel,
    status: input.status,
    locationScope: input.location.label,
    count: compact.length,
    orders: compact,
    dataAsOf: new Date().toISOString(),
    dashboardPath: "/dashboard/orders",
  };
}

function ordersArtifact(output: Record<string, unknown>): MinkArtifact {
  const rows = (output.orders as CompactOrder[] | undefined) ?? [];
  return {
    type: "records",
    title: rows.length === 1 ? "Order" : "Orders",
    recordType: "order",
    records: rows.map((order) => ({
      id: order.id,
      title: order.reference,
      subtitle: `${order.customer} · ${order.channel}`,
      value: `${order.currency} ${order.total.toLocaleString("en-IN")}`,
      status: order.status,
      dashboardPath: order.dashboardPath,
    })),
    filters: [
      { label: "Period", value: String(output.period ?? "Selected order") },
      { label: "Location", value: String(output.locationScope ?? "Store") },
      { label: "Channel", value: String(output.channel ?? "all") },
      { label: "Status", value: String(output.status ?? "all") },
    ],
    dataAsOf: typeof output.dataAsOf === "string" ? output.dataAsOf : undefined,
    dashboardPath:
      typeof output.dashboardPath === "string"
        ? output.dashboardPath
        : undefined,
  };
}

export const listOrdersTool: MinkTool = {
  declaration: {
    name: "list_orders",
    description:
      "List up to 20 compact orders for a date period, exact accessible location, sales channel, and status. Customer identity is minimized and permission-masked. Use this for recent, waiting, delivery, payment, or order-status questions.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        period: { type: "string", enum: [...PERIODS], default: "today" },
        channel: { type: "string", enum: [...CHANNELS], default: "all" },
        status: { type: "string", enum: [...STATUSES], default: "all" },
        location_name: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional exact accessible dashboard location name.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      additionalProperties: false,
    },
  },
  permission: { section: "orders", action: "view" },
  timeoutMs: 7_000,
  artifact: ordersArtifact,
  async execute(actor, args) {
    return readOrders(actor, {
      period: readEnum(args.period, PERIODS, "period", "today"),
      channel: readEnum(args.channel, CHANNELS, "channel", "all"),
      status: readEnum(args.status, STATUSES, "status", "all"),
      location: await resolveMinkLocation(actor, args.location_name),
      limit: readLimit(args.limit),
    });
  },
};

export const currentOrderTool: MinkTool = {
  declaration: {
    name: "get_current_order",
    description:
      "Read the order currently selected in the dashboard. The signed-in browser context is revalidated against the current store; this tool accepts no order ID.",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  permission: { section: "orders", action: "view" },
  available: (actor) => actor.selectedResource?.type === "order",
  timeoutMs: 5_000,
  artifact: ordersArtifact,
  async execute(actor) {
    if (actor.selectedResource?.type !== "order") {
      throw new MinkToolInputError("No order is selected in the dashboard.");
    }
    return readOrders(actor, {
      period: "today",
      channel: "all",
      status: "all",
      location: await resolveMinkLocation(actor, undefined),
      limit: 1,
      selectedId: actor.selectedResource.id,
    });
  },
};

function readLimit(value: unknown): number {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 20) {
    throw new MinkToolInputError("limit must be an integer from 1 to 20.");
  }
  return Number(value);
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
  fallback: T[number],
): T[number] {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new MinkToolInputError(
      `${field} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T[number];
}
