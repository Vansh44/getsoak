import { describe, it, expect } from "vitest";
import { normalizeDomain, validateDomain, routingRecords } from "./domain";

describe("normalizeDomain", () => {
  it("reduces everything a merchant might paste to one comparable form", () => {
    // All of these are the same domain. Storing them differently would defeat
    // the UNIQUE index that stops two stores claiming one domain.
    for (const input of [
      "shop.acme.com",
      "  shop.acme.com  ",
      "SHOP.Acme.COM",
      "https://shop.acme.com",
      "http://shop.acme.com/",
      "https://shop.acme.com/products?a=1#x",
      "shop.acme.com.",
      "shop.acme.com:443",
      "user:pw@shop.acme.com",
    ]) {
      expect(normalizeDomain(input), input).toBe("shop.acme.com");
    }
  });

  it("converts an internationalised domain to the form browsers send", () => {
    // The Host header and the certificate are both ASCII.
    expect(normalizeDomain("café.fr")).toBe("xn--caf-dma.fr");
  });

  it("returns null for nothing usable", () => {
    for (const input of ["", "   ", "https://", null, undefined]) {
      expect(normalizeDomain(input as string | null)).toBeNull();
    }
  });
});

describe("validateDomain", () => {
  it("accepts ordinary apex and subdomain names", () => {
    expect(validateDomain("acme.com")).toMatchObject({
      ok: true,
      domain: "acme.com",
    });
    expect(validateDomain("shop.acme.co.uk")).toMatchObject({
      ok: true,
      domain: "shop.acme.co.uk",
    });
  });

  it("refuses our own namespace", () => {
    // proxy.ts matches the store-subdomain branch first, so a connection here
    // could never take effect — better to say so than to accept it silently.
    expect(validateDomain("acme.storemink.com").reason).toBe("platform_domain");
    expect(validateDomain("storemink.com").reason).toBe("platform_domain");
  });

  it("refuses IP addresses", () => {
    expect(validateDomain("203.0.113.10").reason).toBe("ip_address");
    expect(validateDomain("1.2.3.4").reason).toBe("ip_address");
  });

  it("refuses wildcards", () => {
    expect(validateDomain("*.acme.com").reason).toBe("wildcard");
  });

  it("refuses a bare name with no dot", () => {
    expect(validateDomain("acme").reason).toBe("not_a_domain");
  });

  it("refuses reserved and unroutable names", () => {
    expect(validateDomain("localhost").reason).toBe("reserved");
    expect(validateDomain("shop.test").reason).toBe("reserved");
  });

  it("refuses malformed labels", () => {
    for (const bad of ["-acme.com", "acme-.com", "ac me.com", "a..b.com"]) {
      expect(validateDomain(bad).ok, bad).toBe(false);
    }
  });

  it("refuses an over-long name", () => {
    // 5 × 60-char labels + ".com" = 308 chars, comfortably over the 253 limit
    // (each label is individually legal, so this tests the whole-name rule).
    const long = `${["a", "b", "c", "d", "e"].map((c) => c.repeat(60)).join(".")}.com`;
    expect(validateDomain(long).reason).toBe("too_long");
  });

  it("always reports a merchant-readable message when it rejects", () => {
    for (const bad of ["*.a.com", "acme", "localhost", "1.2.3.4"]) {
      const res = validateDomain(bad);
      expect(res.ok).toBe(false);
      expect(res.message, bad).toBeTruthy();
    }
  });
});

describe("routingRecords", () => {
  it("uses @ for a two-label domain", () => {
    expect(routingRecords("acme.com", "203.0.113.10")).toEqual([
      { type: "A", name: "@", value: "203.0.113.10", purpose: "routing" },
    ]);
  });

  it("uses the leading label for a subdomain", () => {
    expect(routingRecords("shop.acme.com", "203.0.113.10")[0]).toMatchObject({
      name: "shop",
      type: "A",
    });
  });

  it("is an A record either way", () => {
    // Not a CNAME for subdomains: telling apex from subdomain needs the Public
    // Suffix List, and the load balancer's anycast IP is stable, so one record
    // type is correct for both and removes the whole class of error.
    for (const d of ["acme.com", "shop.acme.com", "acme.co.uk"]) {
      expect(routingRecords(d, "203.0.113.10")[0]!.type, d).toBe("A");
    }
  });
});
