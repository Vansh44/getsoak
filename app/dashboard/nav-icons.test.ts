import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { navIcons } from "./nav-icons";
import { SECTIONS } from "./lib/permissions";

// ---------------------------------------------------------------------------
// Guards for the bug that crashed /dashboard/settings.
//
// The icon map used to live in sidebar-nav-link.tsx, a "use client" module. A
// SERVER component importing `navIcons` across that boundary gets a client
// reference rather than the object, so `navIcons[key]` was `undefined` and
// React threw "Element type is invalid ... got: undefined" — a runtime-only
// failure that typecheck, lint and `next build` all pass straight through.
//
// Two things are asserted here, because the bug had two halves: the map has to
// stay importable from the server graph, and every icon the dashboard asks for
// has to actually exist in it.
// ---------------------------------------------------------------------------

describe("nav icon registry", () => {
  it("is NOT a client module", () => {
    // The whole point of the file. A "use client" directive here would silently
    // return undefined icons to every server component that renders one.
    const src = readFileSync(join(__dirname, "nav-icons.ts"), "utf8");
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });

  it("has an icon for every section and child the sidebar declares", () => {
    // Catches the other half: a section pointing at an icon key that was
    // renamed or never added. Same crash, different cause — and it would only
    // show for whoever has permission to see that particular entry.
    const missing: string[] = [];
    for (const s of SECTIONS) {
      if (s.icon && !(s.icon in navIcons)) missing.push(`${s.key} → ${s.icon}`);
      for (const c of s.children ?? []) {
        if (c.icon && !(c.icon in navIcons)) {
          missing.push(`${s.key}/${c.label} → ${c.icon}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every registered icon is a renderable component, not undefined", () => {
    for (const [key, Icon] of Object.entries(navIcons)) {
      expect(Icon, `navIcons.${key}`).toBeTruthy();
      expect(
        typeof Icon === "function" || typeof Icon === "object",
        `navIcons.${key} is not renderable`,
      ).toBe(true);
    }
  });
});
