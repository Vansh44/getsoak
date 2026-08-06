import { describe, expect, it } from "vitest";
import {
  entryCovers,
  entryForDomain,
  planAdd,
  planRemove,
} from "./authorized-domains";

// ---------------------------------------------------------------------------
// entryCovers mirrors matchDomain in @firebase/auth. If these assertions ever
// disagree with the SDK, the coverage optimisation in planAdd starts skipping
// entries that are genuinely required and Google sign-in dies on those hosts.
// ---------------------------------------------------------------------------

const PLATFORM = [
  "localhost",
  "storemink-prod.firebaseapp.com",
  "storemink-prod.web.app",
  "storemink.com",
];

describe("entryCovers", () => {
  it("covers the entry itself and every subdomain", () => {
    // The rule that makes ONE platform entry enough for every store subdomain.
    expect(entryCovers("storemink.com", "storemink.com")).toBe(true);
    expect(entryCovers("storemink.com", "acme.storemink.com")).toBe(true);
    expect(entryCovers("storemink.com", "a.b.storemink.com")).toBe(true);
  });

  it("does not cover a different registrable domain", () => {
    // The whole reason custom domains need their own entry.
    expect(entryCovers("storemink.com", "wholesip.com")).toBe(false);
    expect(entryCovers("storemink.com", "notstoremink.com")).toBe(false);
  });

  it("is not fooled by a domain that merely ends with the same text", () => {
    // "evilstoremink.com" must NOT match "storemink.com": the SDK requires a dot
    // before the suffix, and so must we.
    expect(entryCovers("storemink.com", "evilstoremink.com")).toBe(false);
  });

  it("requires an exact match for an IP entry", () => {
    expect(entryCovers("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(entryCovers("127.0.0.1", "sub.127.0.0.1")).toBe(false);
  });

  it("ignores trailing dots and case", () => {
    expect(entryCovers("Storemink.COM.", "ACME.storemink.com")).toBe(true);
  });

  it("never matches a chrome-extension entry against a web host", () => {
    expect(entryCovers("chrome-extension://abc", "storemink.com")).toBe(false);
  });
});

describe("entryForDomain", () => {
  it("uses the registrable domain, so apex and www need one entry", () => {
    // A merchant may connect either form and we serve both; listing
    // www.xyz.com alone would leave the apex — the commoner address — dead.
    expect(entryForDomain("xyz.com")).toBe("xyz.com");
    expect(entryForDomain("www.xyz.com")).toBe("xyz.com");
    expect(entryForDomain("shop.xyz.co.uk")).toBe("xyz.co.uk");
  });

  it("falls back to the host when there is no registrable domain", () => {
    expect(entryForDomain("localhost")).toBe("localhost");
  });

  it("returns null for nothing usable", () => {
    expect(entryForDomain("   ")).toBeNull();
  });
});

describe("planAdd", () => {
  it("adds a custom domain that nothing covers", () => {
    const p = planAdd(PLATFORM, "wholesip.com");
    expect(p.changed).toBe(true);
    expect(p.next).toContain("wholesip.com");
    expect(p.next).toHaveLength(PLATFORM.length + 1);
  });

  it("is idempotent", () => {
    const once = planAdd(PLATFORM, "wholesip.com");
    const twice = planAdd(once.next, "wholesip.com");
    expect(twice.changed).toBe(false);
    expect(twice.next).toEqual(once.next);
  });

  it("adds nothing when an existing entry already covers the host", () => {
    // The list is capped, so a redundant entry is pure cost.
    expect(planAdd(PLATFORM, "acme.storemink.com").changed).toBe(false);
    expect(planAdd(["xyz.com"], "www.xyz.com").changed).toBe(false);
  });

  it("normalises the www form onto the apex entry", () => {
    const p = planAdd(PLATFORM, "www.wholesip.com");
    expect(p.entry).toBe("wholesip.com");
    expect(p.next).toContain("wholesip.com");
  });
});

describe("planRemove", () => {
  it("removes a merchant entry", () => {
    const list = [...PLATFORM, "wholesip.com"];
    const p = planRemove(list, "wholesip.com", "storemink.com");
    expect(p.changed).toBe(true);
    expect(p.next).not.toContain("wholesip.com");
  });

  it("★ REFUSES to remove the platform's own domain", () => {
    // Removing storemink.com would kill Google sign-in for the platform AND
    // every store subdomain in a single call.
    const p = planRemove(PLATFORM, "storemink.com", "storemink.com");
    expect(p.changed).toBe(false);
    expect(p.next).toEqual(PLATFORM);
  });

  it("★ refuses localhost and the Firebase-owned hosts", () => {
    for (const d of [
      "localhost",
      "storemink-prod.firebaseapp.com",
      "storemink-prod.web.app",
    ]) {
      expect(planRemove(PLATFORM, d, "storemink.com").changed, d).toBe(false);
    }
  });

  it("★ removes by EXACT entry, never by coverage", () => {
    // Coverage-based removal is the trap: a subdomain-shaped input would match
    // and delete the platform entry that covers it.
    const p = planRemove(PLATFORM, "acme.storemink.com", "storemink.com");
    expect(p.changed).toBe(false);
    expect(p.next).toContain("storemink.com");
  });

  it("is a no-op for a domain that was never listed", () => {
    expect(
      planRemove(PLATFORM, "never-added.com", "storemink.com").changed,
    ).toBe(false);
  });
});
