import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));

import { parseShiprocketTracking } from "./tracking";

describe("parseShiprocketTracking", () => {
  it("normalizes and orders AWB activity history", () => {
    const result = parseShiprocketTracking({
      tracking_data: {
        shipment_track: [{ awb_code: "AWB123", shipment_id: 456 }],
        shipment_track_activities: [
          {
            date: "2026-08-12 12:00:00",
            status: "IN TRANSIT",
            "sr-status": 18,
          },
          { date: "2026-08-12 10:00:00", status: "PICKED UP", "sr-status": 6 },
        ],
      },
    });
    expect(result.map((event) => event.status)).toEqual([
      "picked_up",
      "in_transit",
    ]);
    expect(result[0]?.awb).toBe("AWB123");
    expect(result[0]?.externalShipmentId).toBe("456");
  });

  it("normalizes a webhook payload", () => {
    const [event] = parseShiprocketTracking({
      awb: "777",
      current_status: "OUT FOR DELIVERY",
      current_status_id: 17,
      current_timestamp: "2026-08-12T12:00:00Z",
    });
    expect(event?.status).toBe("out_for_delivery");
    expect(event?.awb).toBe("777");
  });
});
