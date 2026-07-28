import { describe, it, expect } from "vitest";
import {
  CAPABILITY_REGISTRY,
  LOCATION_CAPABILITIES,
  LOCATION_TYPES,
  applyCapability,
  capabilityIssues,
  defaultCapabilitiesFor,
  enabledCapabilityLabels,
  isLocationCapability,
  isLocationType,
  locationCan,
  normalizeCapabilities,
  type CapabilityMap,
} from "./capabilities";

const caps = (over: Partial<CapabilityMap> = {}): CapabilityMap => ({
  ...defaultCapabilitiesFor("shop"),
  ...over,
});

describe("registry shape", () => {
  it("gives every capability a default for every type", () => {
    for (const cap of LOCATION_CAPABILITIES) {
      for (const type of LOCATION_TYPES) {
        expect(typeof CAPABILITY_REGISTRY[cap].defaultFor[type]).toBe(
          "boolean",
        );
      }
    }
  });

  // A requirement pointing at a capability that doesn't exist would silently
  // make the dependent one permanently unreachable.
  it("only requires capabilities that exist", () => {
    for (const cap of LOCATION_CAPABILITIES) {
      for (const dep of CAPABILITY_REGISTRY[cap].requires ?? []) {
        expect(LOCATION_CAPABILITIES).toContain(dep);
      }
    }
  });

  it("has no self-referential requirement", () => {
    for (const cap of LOCATION_CAPABILITIES) {
      expect(CAPABILITY_REGISTRY[cap].requires ?? []).not.toContain(cap);
    }
  });

  it("recognises its own types and capabilities", () => {
    expect(isLocationType("warehouse")).toBe(true);
    expect(isLocationType("popup")).toBe(false);
    expect(isLocationCapability("pickup")).toBe(true);
    expect(isLocationCapability("teleport")).toBe(false);
  });
});

describe("defaults by type", () => {
  // Nobody walks into a warehouse.
  it("gives a shop POS and a warehouse online fulfilment", () => {
    expect(defaultCapabilitiesFor("shop")).toMatchObject({
      pos: true,
      online_fulfil: false,
    });
    expect(defaultCapabilitiesFor("warehouse")).toMatchObject({
      pos: false,
      online_fulfil: true,
    });
  });

  // THE decision from locations-ia.md §6.2: nothing customer-facing is assumed.
  it("never turns pickup or returns on by default, for any type", () => {
    for (const type of LOCATION_TYPES) {
      const d = defaultCapabilitiesFor(type);
      expect(d.pickup).toBe(false);
      expect(d.returns).toBe(false);
    }
  });

  // Adding a second shop must not silently start diverting website orders.
  it("does not put a new shop into online fulfilment", () => {
    expect(defaultCapabilitiesFor("shop").online_fulfil).toBe(false);
  });
});

describe("normalizeCapabilities", () => {
  it("fills a missing capability from the type default", () => {
    const out = normalizeCapabilities({ pos: false }, "shop");
    expect(out.pos).toBe(false);
    expect(out.receive_stock).toBe(true);
  });

  // The reason this is jsonb: a new registry entry gets a sensible value on
  // every existing row without a migration.
  it("gives an empty blob the full type defaults", () => {
    expect(normalizeCapabilities({}, "warehouse")).toEqual(
      defaultCapabilitiesFor("warehouse"),
    );
  });

  it("survives junk without losing the other flags", () => {
    for (const junk of [null, undefined, "nope", 42, []]) {
      expect(normalizeCapabilities(junk, "shop")).toEqual(
        defaultCapabilitiesFor("shop"),
      );
    }
    const mixed = normalizeCapabilities(
      { pos: "yes", teleport: true, pickup: true },
      "shop",
    );
    expect(mixed.pos).toBe(true); // non-boolean ignored, default kept
    expect(mixed.pickup).toBe(true);
    expect("teleport" in mixed).toBe(false);
  });
});

describe("locationCan", () => {
  it("is false when the flag is off", () => {
    expect(locationCan(caps({ receive_stock: false }), "receive_stock")).toBe(
      false,
    );
  });

  // Collection at a counter with nobody behind it.
  it("is false when a requirement is off, even if the flag is on", () => {
    const c = caps({ pos: false, pickup: true });
    expect(c.pickup).toBe(true);
    expect(locationCan(c, "pickup", { plan: "pro" })).toBe(false);
  });

  it("honours the plan gate", () => {
    const c = caps({ pos: true, pickup: true });
    expect(locationCan(c, "pickup", { plan: "pro" })).toBe(true);
    expect(locationCan(c, "pickup", { plan: "basic" })).toBe(false);
    expect(locationCan(c, "pickup", { plan: "free" })).toBe(false);
  });

  // Callers that genuinely have no plan context (a migration, a test) should
  // not be silently denied — the plan gate applies only when a plan is given.
  it("skips the plan gate when no plan is supplied", () => {
    expect(locationCan(caps({ pos: true, pickup: true }), "pickup")).toBe(true);
  });

  it("allows an ungated capability on any plan", () => {
    expect(locationCan(caps(), "receive_stock", { plan: "free" })).toBe(true);
  });
});

describe("applyCapability", () => {
  // Otherwise the stored state disagrees with what locationCan reports, and
  // the checkboxes lie.
  it("switches off whatever depended on it", () => {
    const before = caps({ pos: true, pickup: true, returns: true });
    const after = applyCapability(before, "pos", false);
    expect(after).toMatchObject({ pos: false, pickup: false, returns: false });
  });

  it("leaves unrelated capabilities alone", () => {
    const after = applyCapability(caps({ pos: true }), "pos", false);
    expect(after.receive_stock).toBe(true);
    expect(after.transfer_stock).toBe(true);
  });

  it("does not cascade when switching something ON", () => {
    const after = applyCapability(caps({ pos: false }), "pickup", true);
    expect(after.pickup).toBe(true);
    expect(after.pos).toBe(false); // enabling pickup must not enable POS behind the merchant's back
  });

  it("does not mutate the input", () => {
    const before = caps({ pos: true, pickup: true });
    applyCapability(before, "pos", false);
    expect(before.pickup).toBe(true);
  });
});

describe("capabilityIssues", () => {
  it("reports a capability that is on but unusable", () => {
    const issues = capabilityIssues(caps({ pos: false, pickup: true }));
    expect(issues).toEqual([
      { capability: "pickup", reason: expect.stringContaining("Sell here") },
    ]);
  });

  it("reports a plan-gated capability on too small a plan", () => {
    const issues = capabilityIssues(caps({ pos: true, pickup: true }), {
      plan: "basic",
    });
    expect(issues[0]).toMatchObject({ capability: "pickup" });
    expect(issues[0].reason).toMatch(/pro/i);
  });

  it("is silent when everything on is usable", () => {
    expect(capabilityIssues(caps(), { plan: "pro" })).toEqual([]);
  });

  it("says nothing about capabilities that are off", () => {
    expect(capabilityIssues(caps({ pickup: false }), { plan: "free" })).toEqual(
      [],
    );
  });
});

describe("enabledCapabilityLabels", () => {
  it("lists only what actually takes effect", () => {
    const labels = enabledCapabilityLabels(
      caps({ pos: true, pickup: true }),
      { plan: "basic" }, // pickup is Pro-gated
    );
    expect(labels).toContain("Sell here");
    expect(labels).not.toContain("Customer pickup");
  });
});
