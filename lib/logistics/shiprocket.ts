import "server-only";

// Thin Shiprocket REST client. All StoreMink/provider translation stays outside
// this module; this file knows endpoints and wire shapes only.

const DEFAULT_BASE = "https://apiv2.shiprocket.in/v1/external";
const REQUEST_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

const PICKUP_PRIMARY_MARKER =
  /\d|\b(?:house|flat|plot|road|street|lane|building|office|shop|unit|floor|block|sector|village|ward)\b/i;

export class ShiprocketError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ShiprocketError";
  }
}

function baseUrl(): string {
  return (process.env.SHIPROCKET_API_URL || DEFAULT_BASE).replace(/\/$/, "");
}

function errorDetails(value: unknown): string[] {
  if (typeof value === "string") {
    const message = value.trim();
    if (!message) return [];
    if (
      (message.startsWith("{") && message.endsWith("}")) ||
      (message.startsWith("[") && message.endsWith("]"))
    ) {
      try {
        return errorDetails(JSON.parse(message));
      } catch {
        // It looked like JSON but was ordinary provider text. Show it as-is.
      }
    }
    return [message];
  }
  if (Array.isArray(value)) return value.flatMap(errorDetails);
  if (value && typeof value === "object") {
    return Object.values(value as JsonObject).flatMap(errorDetails);
  }
  return [];
}

function messageFrom(body: unknown): string {
  if (!body || typeof body !== "object") return "Shiprocket request failed.";
  const b = body as JsonObject;
  for (const value of [b.message, b.error, b.status_message, b.errors]) {
    const details = [...new Set(errorDetails(value))];
    if (details.length > 0) return details.join(" ");
  }
  return "Shiprocket request failed.";
}

/**
 * Adapt StoreMink's two location lines to Shiprocket's pickup-address rules.
 *
 * Shiprocket validates the primary line for house/flat/road details and
 * requires each supplied line to be at least ten characters. Existing stores
 * may have put those details in line 2 because the editor described it as the
 * apartment/unit field. Promote that more-specific line when necessary, and
 * merge a short secondary fragment instead of sending an invalid address_2.
 */
export function shiprocketPickupAddressFields(input: {
  line1?: unknown;
  line2?: unknown;
}): { address: string; address_2: string } {
  const clean = (value: unknown) =>
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  let primary = clean(input.line1);
  let secondary = clean(input.line2);

  if (
    secondary &&
    !PICKUP_PRIMARY_MARKER.test(primary) &&
    PICKUP_PRIMARY_MARKER.test(secondary)
  ) {
    [primary, secondary] = [secondary, primary];
  }

  // `address_2`, when supplied, has its own minimum-length validation. Keep
  // all information while presenting Shiprocket with one valid primary line.
  if (secondary && (primary.length < 10 || secondary.length < 10)) {
    primary = `${primary}, ${secondary}`;
    secondary = "";
  }

  return { address: primary, address_2: secondary };
}

async function request<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    token?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | null | undefined>;
    fetchImpl?: FetchLike;
  } = {},
): Promise<T> {
  const url = new URL(`${baseUrl()}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ShiprocketError(
      error instanceof Error ? error.message : "Shiprocket is unreachable.",
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new ShiprocketError(messageFrom(body), response.status, body);
  }
  return body as T;
}

export interface ShiprocketSession {
  token: string;
  expiresAt: Date;
}

export async function shiprocketLogin(
  email: string,
  password: string,
  fetchImpl?: FetchLike,
): Promise<ShiprocketSession> {
  const result = await request<{ token?: string }>("/auth/login", {
    method: "POST",
    body: { email, password },
    fetchImpl,
  });
  if (!result.token) throw new ShiprocketError("Shiprocket returned no token.");
  // Public docs state ten days. Refresh twelve hours early rather than learn
  // about clock skew while a warehouse operator is booking a parcel.
  return {
    token: result.token,
    expiresAt: new Date(Date.now() + 9.5 * 24 * 60 * 60 * 1000),
  };
}

export interface ShiprocketPickupInput {
  pickup_location: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  address_2?: string;
  city: string;
  state: string;
  country: string;
  pin_code: string;
}

export function addShiprocketPickup(
  token: string,
  input: ShiprocketPickupInput,
) {
  return request<JsonObject>("/settings/company/addpickup", {
    method: "POST",
    token,
    body: input,
  });
}

export interface ShiprocketOrderInput extends JsonObject {
  order_id: string;
  order_date: string;
  pickup_location: string;
  billing_customer_name: string;
  billing_last_name: string;
  billing_address: string;
  billing_address_2: string;
  billing_city: string;
  billing_pincode: string;
  billing_state: string;
  billing_country: string;
  billing_email: string;
  billing_phone: string;
  shipping_is_billing: boolean;
  order_items: Array<{
    name: string;
    sku: string;
    units: number;
    selling_price: number;
    discount?: number;
    tax?: number;
    hsn?: string;
  }>;
  payment_method: "COD" | "Prepaid";
  shipping_charges: number;
  total_discount: number;
  sub_total: number;
  length: number;
  breadth: number;
  height: number;
  weight: number;
}

export interface ShiprocketCreatedOrder {
  orderId: string;
  shipmentId: string;
  raw: JsonObject;
}

export async function createShiprocketOrder(
  token: string,
  input: ShiprocketOrderInput,
): Promise<ShiprocketCreatedOrder> {
  const raw = await request<JsonObject>("/orders/create/adhoc", {
    method: "POST",
    token,
    body: input,
  });
  const orderId = String(raw.order_id ?? "");
  const shipmentId = String(raw.shipment_id ?? "");
  if (!orderId || !shipmentId) {
    throw new ShiprocketError(messageFrom(raw), 200, raw);
  }
  return { orderId, shipmentId, raw };
}

export interface ShiprocketAwb {
  awb: string;
  courierId: string | null;
  courierName: string | null;
  raw: JsonObject;
}

export async function assignShiprocketAwb(
  token: string,
  shipmentId: string,
  courierId?: string,
): Promise<ShiprocketAwb> {
  const raw = await request<JsonObject>("/courier/assign/awb", {
    method: "POST",
    token,
    body: {
      shipment_id: Number(shipmentId) || shipmentId,
      ...(courierId ? { courier_id: Number(courierId) || courierId } : {}),
    },
  });
  const response =
    raw.response && typeof raw.response === "object"
      ? (raw.response as JsonObject)
      : raw;
  const data =
    response.data && typeof response.data === "object"
      ? (response.data as JsonObject)
      : response;
  const awb = String(data.awb_code ?? data.awb ?? "");
  if (!awb) throw new ShiprocketError(messageFrom(raw), 200, raw);
  return {
    awb,
    courierId:
      data.courier_company_id == null ? null : String(data.courier_company_id),
    courierName:
      typeof data.courier_name === "string" ? data.courier_name : null,
    raw,
  };
}

export async function generateShiprocketLabel(
  token: string,
  shipmentId: string,
): Promise<string | null> {
  const raw = await request<JsonObject>("/courier/generate/label", {
    method: "POST",
    token,
    body: { shipment_id: [Number(shipmentId) || shipmentId] },
  });
  return typeof raw.label_url === "string" ? raw.label_url : null;
}

export async function scheduleShiprocketPickup(
  token: string,
  shipmentId: string,
): Promise<JsonObject> {
  return request<JsonObject>("/courier/generate/pickup", {
    method: "POST",
    token,
    body: { shipment_id: [Number(shipmentId) || shipmentId] },
  });
}

export async function generateShiprocketManifest(
  token: string,
  shipmentId: string,
): Promise<string | null> {
  const generated = await request<JsonObject>("/manifests/generate", {
    method: "POST",
    token,
    body: { shipment_id: [Number(shipmentId) || shipmentId] },
  });
  const direct = generated.manifest_url;
  if (typeof direct === "string") return direct;
  const printed = await request<JsonObject>("/manifests/print", {
    method: "POST",
    token,
    body: { order_ids: [generated.order_id].filter(Boolean) },
  });
  return typeof printed.manifest_url === "string" ? printed.manifest_url : null;
}

export function trackShiprocketAwb(token: string, awb: string) {
  return request<unknown>(`/courier/track/awb/${encodeURIComponent(awb)}`, {
    token,
  });
}

export function cancelShiprocketAwb(token: string, awb: string) {
  return request<JsonObject>("/orders/cancel/shipment/awbs", {
    method: "POST",
    token,
    body: { awbs: [awb] },
  });
}

export function actOnShiprocketNdr(
  token: string,
  awb: string,
  action: "re-attempt" | "return",
  comments: string,
) {
  return request<JsonObject>(`/ndr/${encodeURIComponent(awb)}/action`, {
    method: "POST",
    token,
    body: { action, comments },
  });
}

export interface ServiceabilityInput {
  pickupPostcode: string;
  deliveryPostcode: string;
  cod: boolean;
  weightKg: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  declaredValue?: number;
}

export function checkShiprocketServiceability(
  token: string,
  input: ServiceabilityInput,
) {
  return request<JsonObject>("/courier/serviceability/", {
    token,
    query: {
      pickup_postcode: input.pickupPostcode,
      delivery_postcode: input.deliveryPostcode,
      cod: input.cod ? 1 : 0,
      weight: input.weightKg,
      length: input.lengthCm,
      breadth: input.widthCm,
      height: input.heightCm,
      declared_value: input.declaredValue,
      is_return: 0,
    },
  });
}
