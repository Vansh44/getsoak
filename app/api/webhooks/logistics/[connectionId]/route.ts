import { and, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { shipments } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  shiprocketConnectionById,
  verifyWebhookSecret,
} from "@/lib/logistics/connection";
import {
  parseShiprocketTracking,
  recordShipmentTrackingUpdate,
} from "@/lib/logistics/tracking";

export const runtime = "nodejs";

const MAX_WEBHOOK_BYTES = 1_000_000;

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  const connection = await shiprocketConnectionById(connectionId);
  if (!connection?.webhook_secret_hash) {
    return NextResponse.json({ error: "Unknown connection." }, { status: 404 });
  }

  const supplied = request.headers.get("x-api-key") ?? "";
  if (
    !supplied ||
    !verifyWebhookSecret(supplied, connection.webhook_secret_hash)
  ) {
    return NextResponse.json(
      { error: "Invalid webhook token." },
      { status: 401 },
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_WEBHOOK_BYTES) {
      return NextResponse.json(
        { error: "Payload too large." },
        { status: 413 },
      );
    }
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const updates = parseShiprocketTracking(body);
  const identity = updates.find(
    (update) => update.awb || update.externalShipmentId,
  );
  if (!identity) return NextResponse.json({ accepted: true, matched: false });

  const lookup = or(
    ...(identity.awb ? [eq(shipments.awb, identity.awb)] : []),
    ...(identity.externalShipmentId
      ? [eq(shipments.externalShipmentId, identity.externalShipmentId)]
      : []),
  );
  if (!lookup) return NextResponse.json({ accepted: true, matched: false });
  const rows = await withService((db) =>
    db
      .select({ id: shipments.id })
      .from(shipments)
      .where(
        and(
          eq(shipments.connectionId, connectionId),
          eq(shipments.storeId, connection.store_id),
          lookup,
        ),
      )
      .limit(1),
  );
  const shipment = rows[0];
  if (!shipment) return NextResponse.json({ accepted: true, matched: false });

  let recorded = 0;
  for (const update of updates) {
    const result = await recordShipmentTrackingUpdate(shipment.id, update);
    if (result.accepted) recorded += 1;
  }
  return NextResponse.json({ accepted: true, matched: true, recorded });
}
