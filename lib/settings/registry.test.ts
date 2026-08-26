import { describe, it, expect } from "vitest";
import {
  FEATURES_KEY,
  SETTINGS,
  SETTING_KEYS,
  getSettingDef,
  normalizePlan,
  planAllows,
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
