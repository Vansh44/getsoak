import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LOG_TYPES } from "@/app/dashboard/logs/log-types";
import { PLATFORM_LOG_TYPES } from "./log-types";

const LOGS_DIR = __dirname;
const PREFIX = "/dashboard/logs";

/**
 * The rail is a registry, and a registry entry that points at a route nobody
 * built is a 404 the operator finds instead of a log. `fs.readdir` is the only
 * thing that actually knows which routes exist — the same technique the
 * reserved-page-slug drift test uses.
 */
describe("PLATFORM_LOG_TYPES", () => {
  const routeDirs = readdirSync(LOGS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it("every entry has a page on disk", () => {
    for (const type of PLATFORM_LOG_TYPES) {
      const segment = type.href.slice(PREFIX.length + 1).split("?")[0];
      expect(
        routeDirs,
        `${type.key} points at ${type.href}, which has no route directory`,
      ).toContain(segment);
      expect(
        existsSync(path.join(LOGS_DIR, segment, "page.tsx")),
        `${segment}/ has no page.tsx`,
      ).toBe(true);
    }
  });

  it("every route directory is reachable from the rail", () => {
    // The other direction: a log page nobody can navigate to is a page that
    // rots. If a route is deliberately unlisted, this test is where that gets
    // stated rather than silently happening.
    const listed = new Set(
      PLATFORM_LOG_TYPES.map((t) => t.href.slice(PREFIX.length + 1)),
    );
    for (const dir of routeDirs) {
      expect(listed, `${dir}/ exists but no rail entry links to it`).toContain(
        dir,
      );
    }
  });

  it("keys and hrefs are unique", () => {
    const keys = PLATFORM_LOG_TYPES.map((t) => t.key);
    const hrefs = PLATFORM_LOG_TYPES.map((t) => t.href);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  // ★ THE TWO CONSOLES' REGISTRIES ARE NOT INTERCHANGEABLE, and this is the
  // guard against someone "tidying up" by pointing the platform sidebar at
  // LOG_TYPES. An operator has no import/export jobs and no per-store activity
  // feed; those entries would render as rail links to routes that 404.
  it("does not carry the merchant-only log types", () => {
    const platformKeys = new Set(PLATFORM_LOG_TYPES.map((t) => t.key));
    for (const merchantOnly of ["activity", "imports", "exports"]) {
      expect(
        LOG_TYPES.some((t) => t.key === merchantOnly),
        `${merchantOnly} should still exist in the merchant registry`,
      ).toBe(true);
      expect(platformKeys).not.toContain(merchantOnly);
    }
  });
});
