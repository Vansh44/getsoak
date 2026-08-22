import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// ★★ THE TOKENS ARE ONLY DEFINED UNDER `.pos-root`. app/pos/layout.tsx has
// three return paths — POS-unavailable, signed-out, and the signed-in shell —
// and the signed-in one shipped WITHOUT the class. Every token-backed
// background in the register then resolved to an undefined variable, so the
// whole till rendered with nothing behind it: transparent panels, a
// see-through tender modal, product tiles showing through it.
//
// ⚠ DO NOT WRITE A TAILWIND CLASS WITH A WILDCARD IN IT ANYWHERE IN A SCANNED
// FILE, COMMENTS INCLUDED. This comment originally spelled the class out with
// a `*` where the token name goes. Tailwind scans source text, not syntax, so
// it dutifully emitted a rule whose value was an unresolvable wildcard —
// invalid CSS,
// which failed the parse of the whole generated stylesheet and blanked every
// page in the app, storefront and dashboard included. Name tokens in prose.
//
// It was invisible in review because /pos/login takes the signed-out branch
// and looked perfect. A branch that forgets the class is exactly the failure
// the idle-lock coverage test exists for, so it gets the same treatment.
const root = join(process.cwd(), "app", "pos");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

describe("POS theme coverage", () => {
  it("every layout branch renders inside .pos-root", () => {
    const layout = read("layout.tsx");
    // Each JSX return in the layout is a branch a cashier can land on. Both
    // shapes count — the signed-out branch is a single-line `return <div…`.
    const returns = layout.match(/return\s*[(<]/g) ?? [];
    expect(returns.length).toBeGreaterThanOrEqual(3);

    // ⚠ Anchored to `className="pos-root`, NOT to the string anywhere in the
    // file. The first version of this guard searched the whole text and so
    // matched the COMMENT that explains the class — it passed with the class
    // deleted, which is the one thing a regression guard must never do.
    const inClassName = /className="pos-root[\s"]/g;
    const direct = (layout.match(inClassName) ?? []).length;
    const viaNav = inClassName.test(read("pos-nav.tsx"));
    expect(direct + (viaNav ? 1 : 0)).toBeGreaterThanOrEqual(returns.length);
    expect(
      viaNav,
      "PosNav must carry pos-root — it is the signed-in shell",
    ).toBe(true);
  });

  it("no screen hardcodes a colour the theme cannot reach", () => {
    // The first light pass mapped one dark hex and missed another, so three
    // raised panels — the nav drawer, the receipt overlay and a sell modal —
    // stayed dark while the page around them went pale, and their now-dark
    // text became invisible on them. A hardcoded colour is a screen the theme
    // does not control, so there should be none.
    const offenders: string[] = [];
    for (const dir of ["app/pos", "components/pos"]) {
      const base = join(process.cwd(), dir);
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith(".tsx")) {
            for (const m of readFileSync(full, "utf8").matchAll(
              /(?:bg|text|border|ring)-\[#[0-9a-fA-F]{3,8}\]/g,
            )) {
              offenders.push(
                `${full.replace(process.cwd() + "/", "")}: ${m[0]}`,
              );
            }
          }
        }
      };
      walk(base);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no semantic colour is left at a dark-ground lightness", () => {
    // ★★ SEMANTIC COLOUR IS TWO DECISIONS. The hue carries across themes; the
    // lightness does not. These all shipped in the 100-400 range because they
    // were picked to glow on a near-black till, and on the light one "Change
    // due ₹48.00" was pale amber on pale amber — invisible — as were both
    // pickup queue headings. Hue stays a Tailwind utility; lightness must come
    // from a token.
    const offenders: string[] = [];
    for (const dir of ["app/pos", "components/pos"]) {
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith(".tsx")) {
            for (const m of readFileSync(full, "utf8").matchAll(
              /text-(?:emerald|amber|red|sky|green|orange)-[1-4]00/g,
            )) {
              offenders.push(
                `${full.replace(process.cwd() + "/", "")}: ${m[0]}`,
              );
            }
          }
        }
      };
      walk(join(process.cwd(), dir));
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("a solid semantic fill always names its own foreground", () => {
    // ★★ THE THIRD TIME THIS EXACT FAULT SHIPPED. `.pos-root` sets
    // `color: var(--pos-ink)`, which on the light theme is near-black — so a
    // button that paints itself emerald-600 and says nothing about text
    // inherits dark ink onto a saturated green fill and the label all but
    // disappears. It is invisible in review because on the DARK theme the
    // inherited ink was already light, and invisible in the colour guard above
    // because nothing here is out of range: the fault is a MISSING class, not
    // a wrong one.
    //
    // Scoped to the individual quoted string, not the file, because these live
    // in ternary branches — the other branch's `text-white` says nothing about
    // this one's fill.
    const SOLID =
      /bg-(?:emerald|green|red|rose|amber|orange|sky|blue)-(?:500|600|700|800|900)/;
    const FOREGROUND = /text-white|text-black|text-\[/;
    const offenders: string[] = [];
    for (const dir of ["app/pos", "components/pos"]) {
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith(".tsx")) {
            for (const lit of readFileSync(full, "utf8").match(/"[^"\n]*"/g) ??
              []) {
              // A `hover:` fill repaints on hover only; the resting state's
              // string is what has to carry the foreground.
              const resting = lit.replace(/hover:\S+/g, "");
              if (SOLID.test(resting) && !FOREGROUND.test(lit)) {
                offenders.push(
                  `${full.replace(process.cwd() + "/", "")}: ${lit}`,
                );
              }
            }
          }
        }
      };
      walk(join(process.cwd(), dir));
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the token block defines every variable the till reads", () => {
    const css = read("pos.css");
    const declared = new Set(
      [...css.matchAll(/(--pos-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
    );
    // Anything referenced anywhere under app/pos must be declared, or it
    // silently renders as nothing — which is precisely how this broke.
    const used = new Set<string>();
    for (const f of [
      "layout.tsx",
      "pos-nav.tsx",
      "pos-screen.tsx",
      "sell/tender-panel.tsx",
      "collection-detail.tsx",
      "sell/sell-client.tsx",
      "login/login-client.tsx",
    ]) {
      for (const m of read(f).matchAll(/var\((--pos-[a-z0-9-]+)\)/g)) {
        used.add(m[1]);
      }
    }
    expect(used.size).toBeGreaterThan(5);
    for (const v of used) {
      expect(
        declared.has(v),
        `${v} is used but never declared in pos.css`,
      ).toBe(true);
    }
  });
});
