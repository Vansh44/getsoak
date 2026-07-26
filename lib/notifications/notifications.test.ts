import { describe, it, expect } from "vitest";
import {
  EVENTS,
  EVENT_KEYS,
  EVENT_GROUPS,
  getEventDef,
  isEventKey,
  groupEvents,
  resolveChannels,
  storeAdminEvents,
  eventKeySlug,
  eventFromSlug,
  type EventDef,
} from "./events";
import { renderNotification } from "./render";
import { SECTIONS } from "@/app/dashboard/lib/permissions";

const byKey = (key: string): EventDef => {
  const def = getEventDef(key);
  if (!def) throw new Error(`missing event def: ${key}`);
  return def;
};

describe("event registry", () => {
  it("has one def per key, and no def without a key", () => {
    expect(EVENTS.map((e) => e.key).sort()).toEqual([...EVENT_KEYS].sort());
  });

  it("has no duplicate keys", () => {
    expect(new Set(EVENT_KEYS).size).toBe(EVENT_KEYS.length);
  });

  it("only uses groups declared in EVENT_GROUPS", () => {
    for (const e of EVENTS) expect(EVENT_GROUPS).toContain(e.group);
  });

  // Routing for store admins derives from the permission map, so an event
  // pointing at a section that doesn't exist would silently notify nobody.
  it("every event names a real dashboard permission section", () => {
    const sections = new Set(SECTIONS.map((s) => s.key));
    for (const e of EVENTS) {
      expect(sections, `${e.key} → ${e.section}`).toContain(e.section);
    }
  });

  it("platform events are the only ones aimed at operators", () => {
    for (const e of EVENTS) {
      if (e.audiences.operators) expect(e.group).toBe("Platform");
    }
  });

  it("keeps platform events out of the merchant settings matrix", () => {
    expect(storeAdminEvents().some((e) => e.group === "Platform")).toBe(false);
  });

  it("recognises known keys only", () => {
    expect(isEventKey("order.placed")).toBe(true);
    expect(isEventKey("order.teleported")).toBe(false);
    expect(isEventKey(undefined)).toBe(false);
  });

  it("groups events without dropping or duplicating any", () => {
    const defs = storeAdminEvents();
    const flattened = groupEvents(defs).flatMap((g) => g.events);
    expect(flattened).toHaveLength(defs.length);
    expect(new Set(flattened.map((e) => e.key)).size).toBe(defs.length);
  });
});

// Dashboard URLs must not contain dots: proxy.ts exempts asset-like paths from
// the session gate, and a dotted route segment slipped straight through it.
describe("event key slugs", () => {
  it("removes every dot", () => {
    for (const key of EVENT_KEYS) {
      expect(eventKeySlug(key), key).not.toContain(".");
    }
  });

  it("round-trips every key in the registry", () => {
    for (const key of EVENT_KEYS) {
      expect(eventFromSlug(eventKeySlug(key))?.key).toBe(key);
    }
  });

  it("produces a unique slug per key (no two events share a URL)", () => {
    const slugs = EVENT_KEYS.map(eventKeySlug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("only produces URL-safe characters", () => {
    for (const key of EVENT_KEYS) {
      expect(eventKeySlug(key), key).toMatch(/^[a-z0-9_-]+$/);
    }
  });

  it("returns undefined for an unknown or empty slug", () => {
    expect(eventFromSlug("not-a-thing")).toBeUndefined();
    expect(eventFromSlug("")).toBeUndefined();
  });

  it("still resolves a slug given in the wrong case", () => {
    expect(eventFromSlug("Order-Placed")?.key).toBe("order.placed");
  });
});

describe("resolveChannels", () => {
  const orderPlaced = byKey("order.placed");

  it("falls back to the registry default when nothing overrides", () => {
    expect(resolveChannels(orderPlaced, "store-admins")).toEqual({
      inApp: true,
      email: true,
      digest: "instant",
    });
  });

  it("lets a store default override the registry", () => {
    expect(
      resolveChannels(orderPlaced, "store-admins", { email: false }),
    ).toMatchObject({ inApp: true, email: false });
  });

  it("lets a user override beat the store default", () => {
    expect(
      resolveChannels(
        orderPlaced,
        "store-admins",
        { email: false },
        { email: true },
      ),
    ).toMatchObject({ email: true });
  });

  it("treats a null channel as 'no opinion', not as off", () => {
    expect(
      resolveChannels(
        orderPlaced,
        "store-admins",
        { email: false },
        { email: null },
      ),
    ).toMatchObject({ email: false });
  });

  it("ignores overrides on a non-configurable event", () => {
    const roleChanged = byKey("admin.role_changed");
    expect(
      resolveChannels(
        roleChanged,
        "store-admins",
        { inApp: false, email: false },
        { inApp: false, email: false },
      ),
    ).toEqual({ inApp: true, email: true, digest: "instant" });
  });

  it("delivers nothing to an audience the event doesn't target", () => {
    expect(resolveChannels(orderPlaced, "operators")).toEqual({
      inApp: false,
      email: false,
      digest: "instant",
    });
  });

  it("rejects a junk digest value stored in the DB", () => {
    expect(
      resolveChannels(orderPlaced, "store-admins", null, {
        digest: "yearly" as never,
      }).digest,
    ).toBe("instant");
  });

  it("audit-only events resolve to no delivery at all", () => {
    const audit = byKey("product.updated");
    expect(resolveChannels(audit, "store-admins")).toMatchObject({
      inApp: false,
      email: false,
    });
  });
});

describe("renderNotification", () => {
  it("speaks to the store and the shopper differently about one event", () => {
    const event = {
      type: "order.placed",
      actorLabel: "Priya S.",
      subjectId: "11111111-1111-4111-8111-111111111111",
      subjectLabel: "ORD10010004",
      payload: { total: 1240, currency: "INR" },
    };

    const admin = renderNotification(event, "store-admins");
    expect(admin?.title).toContain("ORD10010004");
    expect(admin?.body).toContain("Priya S.");
    expect(admin?.url).toBe("/dashboard/orders?q=ORD10010004");

    const customer = renderNotification(event, "customer");
    expect(customer?.title).toBe("Order confirmed");
    expect(customer?.url).toBe("/orders/11111111-1111-4111-8111-111111111111");
  });

  it("returns null for an audience the event never targets", () => {
    expect(
      renderNotification({ type: "enquiry.received" }, "customer"),
    ).toBeNull();
  });

  it("returns null for an unknown event type", () => {
    expect(
      renderNotification({ type: "not.a.thing" }, "store-admins"),
    ).toBeNull();
  });

  // A half-populated payload must never render "undefined" into someone's bell.
  it("degrades to the registry label when the payload is empty", () => {
    const rendered = renderNotification(
      { type: "order.placed" },
      "store-admins",
    );
    expect(rendered?.title).toBe("New order");
    expect(rendered?.title).not.toContain("undefined");
    expect(rendered?.body).toBeNull();
  });

  it("never renders 'undefined'/'null' into any template", () => {
    for (const def of EVENTS) {
      for (const audience of Object.keys(def.audiences) as Array<
        keyof typeof def.audiences
      >) {
        const r = renderNotification({ type: def.key }, audience);
        if (!r) continue;
        for (const text of [r.title, r.body ?? "", r.url ?? ""]) {
          expect(text, `${def.key}/${audience}`).not.toMatch(/undefined|null/);
        }
      }
    }
  });

  it("formats money in INR", () => {
    const r = renderNotification(
      { type: "order.payment_received", payload: { total: 1240 } },
      "store-admins",
    );
    expect(r?.title).toContain("1,240");
  });
});
