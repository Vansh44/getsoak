import { describe, it, expect } from "vitest";
import {
  FEATURES_KEY,
  SETTINGS,
  SETTING_KEYS,
  getSettingDef,
  normalizePlan,
  planAllows,
  resolveRawNumberSetting,
  resolveStoreSettings,
} from "./registry";
import { getSection } from "@/app/dashboard/lib/permissions";

describe("settings registry", () => {
  it("catalog and key list stay in sync", () => {
    expect(SETTINGS.map((s) => s.key)).toEqual([...SETTING_KEYS]);
  });

  it("every dependsOn points at a real setting", () => {
    for (const def of SETTINGS) {
      if (def.dependsOn) {
        expect(getSettingDef(def.dependsOn)).toBeDefined();
      }
    }
  });

  // Settings are permission-gated by their owning feature's dashboard section.
  it("every section points at a real dashboard section", () => {
    for (const def of SETTINGS) {
      expect(getSection(def.section), def.key).toBeDefined();
    }
  });

  describe("normalizePlan", () => {
    it("passes known plans through", () => {
      expect(normalizePlan("pro")).toBe("pro");
      expect(normalizePlan("basic")).toBe("basic");
    });

    it("coerces unknown values to free", () => {
      expect(normalizePlan(null)).toBe("free");
      expect(normalizePlan(undefined)).toBe("free");
      expect(normalizePlan("enterprise")).toBe("free");
      expect(normalizePlan(42)).toBe("free");
    });
  });

  describe("planAllows", () => {
    it("allows everything when no minimum is set", () => {
      expect(planAllows("free")).toBe(true);
    });

    it("enforces the plan ladder", () => {
      expect(planAllows("free", "basic")).toBe(false);
      expect(planAllows("basic", "basic")).toBe(true);
      expect(planAllows("basic", "pro")).toBe(false);
      expect(planAllows("pro", "basic")).toBe(true);
    });
  });

  describe("resolveStoreSettings", () => {
    it("returns defaults for an empty settings object", () => {
      const values = resolveStoreSettings({}, "free");
      expect(values["blogs.customerSubmissions"]).toBe(false);
      expect(values["blogs.requireApproval"]).toBe(true);
    });

    it("tolerates null settings", () => {
      const values = resolveStoreSettings(null, null);
      expect(values["blogs.customerSubmissions"]).toBe(false);
    });

    it("applies boolean overrides from settings.features", () => {
      const values = resolveStoreSettings(
        { [FEATURES_KEY]: { "blogs.customerSubmissions": false } },
        "free",
      );
      expect(values["blogs.customerSubmissions"]).toBe(false);
      // Untouched settings keep their default.
      expect(values["blogs.requireApproval"]).toBe(true);
    });

    it("ignores non-boolean and unknown overrides", () => {
      const values = resolveStoreSettings(
        {
          [FEATURES_KEY]: {
            "blogs.customerSubmissions": "no", // wrong type → default
            "made.up": true, // unknown key → dropped
          },
        },
        "free",
      );
      expect(values["blogs.customerSubmissions"]).toBe(false);
      expect("made.up" in values).toBe(false);
    });

    it("ignores overrides that live outside settings.features", () => {
      const values = resolveStoreSettings(
        { "blogs.customerSubmissions": false },
        "free",
      );
      expect(values["blogs.customerSubmissions"]).toBe(false);
    });

    it("restores paid settings without rewriting their stored values", () => {
      const settings = {
        [FEATURES_KEY]: {
          "blogs.customerSubmissions": true,
          "pages.customCode": true,
        },
      };
      expect(resolveStoreSettings(settings, "free")).toMatchObject({
        "blogs.customerSubmissions": false,
        "pages.customCode": false,
      });
      expect(resolveStoreSettings(settings, "basic")).toMatchObject({
        "blogs.customerSubmissions": true,
        "pages.customCode": true,
      });
    });
  });
});

// ★★ A REAL 0 IS NOT AN ABSENT VALUE.
//
// `offers.maxTotalDiscountPercent` is declared `min: 0` and documented as "set
// to 0 to stop offers discounting anything", so 0 is a deliberate choice. Two
// Mink readers gated on `value > 0`, which reads that choice as unset and
// substitutes the permissive 50% default — the merchant who locked it down
// hardest silently got the loosest behaviour. Same trap as
// `pos.maxDiscountPercent` (§22) and `products.return_window_days` (§28).
describe("resolveRawNumberSetting", () => {
  const KEY = "offers.maxTotalDiscountPercent" as const;

  it("★★ keeps a deliberate zero", () => {
    expect(resolveRawNumberSetting(KEY, 0)).toBe(0);
  });

  it("keeps an ordinary configured value", () => {
    expect(resolveRawNumberSetting(KEY, 15)).toBe(15);
  });

  it("falls back to the registry default when nothing is stored", () => {
    const fallback = getSettingDef(KEY)?.defaultValue;
    expect(resolveRawNumberSetting(KEY, undefined)).toBe(fallback);
    expect(resolveRawNumberSetting(KEY, null)).toBe(fallback);
    // A wrong-typed jsonb value is not a configured value either.
    expect(resolveRawNumberSetting(KEY, "20")).toBe(fallback);
    expect(resolveRawNumberSetting(KEY, NaN)).toBe(fallback);
  });

  it("★ clamps to the setting's OWN bounds rather than a hardcoded pair", () => {
    // The bounds were copied to each call site, so getting one wrong was a
    // local edit nobody else could see.
    expect(resolveRawNumberSetting(KEY, -5)).toBe(0);
    expect(resolveRawNumberSetting(KEY, 250)).toBe(100);
  });
});

// ★★ THE DEFAULT THAT MADE EVERY AUTOMATIC OFFER INERT. `offers.autoApply`
// shipped OFF and nothing ever wrote it true, so every store had it off and
// `disqualify` refused every `delivery: "automatic"` offer — silently, with the
// dashboard still calling the offer Active. It is ON now (owner's call,
// 2026-09-06), which is a deliberate exception to invariant 1: a store that has
// never touched the setting starts applying its active automatic offers.
//
// Pinned in BOTH directions, because each is a different failure. Off again and
// the feature is dead; ignoring a stored `false` and a merchant who chose codes
// only starts discounting without asking.
describe("offers.autoApply", () => {
  it("is on when the store has never set it", () => {
    expect(resolveStoreSettings({}, "basic")["offers.autoApply"]).toBe(true);
    expect(
      resolveStoreSettings({ features: {} }, "basic")["offers.autoApply"],
    ).toBe(true);
  });

  it("still honours a merchant who deliberately switched it off", () => {
    expect(
      resolveStoreSettings(
        { features: { "offers.autoApply": false } },
        "basic",
      )["offers.autoApply"],
    ).toBe(false);
  });

  it("is not plan-gated — a free store's offers apply too", () => {
    expect(resolveStoreSettings({}, "free")["offers.autoApply"]).toBe(true);
  });
});
