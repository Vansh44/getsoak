import { describe, it, expect, afterEach } from "vitest";
import {
  resourceId,
  isManagedResource,
  assertManaged,
  MANAGED_PREFIX,
} from "./naming";

const original = process.env.DOMAIN_ENV;
afterEach(() => {
  if (original === undefined) delete process.env.DOMAIN_ENV;
  else process.env.DOMAIN_ENV = original;
});

const asProd = () => (process.env.DOMAIN_ENV = "prod");
const asStaging = () => (process.env.DOMAIN_ENV = "staging");

describe("resourceId", () => {
  it("is deterministic — the whole basis of idempotent provisioning", () => {
    // A retried job must compute the same name, hit ALREADY_EXISTS and adopt
    // the existing resource instead of creating a second billable certificate.
    asProd();
    expect(resourceId("cert", "shop.acme.com")).toBe(
      resourceId("cert", "shop.acme.com"),
    );
  });

  it("separates the three resource kinds for one domain", () => {
    asProd();
    const ids = [
      resourceId("auth", "shop.acme.com"),
      resourceId("cert", "shop.acme.com"),
      resourceId("entry", "shop.acme.com"),
    ];
    expect(new Set(ids).size).toBe(3);
  });

  it("separates environments sharing one certificate map", () => {
    asProd();
    const prod = resourceId("cert", "shop.acme.com");
    asStaging();
    expect(resourceId("cert", "shop.acme.com")).not.toBe(prod);
  });

  it("stays within the 63-character resource id limit", () => {
    asProd();
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.example.com`;
    const id = resourceId("cert", long);
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(id.endsWith("-")).toBe(false);
  });

  it("cannot collide two long domains that share a prefix", () => {
    // Truncation alone would map both onto one id, and they would then reuse
    // each other's certificate. The hash is of the FULL domain.
    asProd();
    const a = `${"a".repeat(70)}.one.example.com`;
    const b = `${"a".repeat(70)}.two.example.com`;
    expect(resourceId("cert", a)).not.toBe(resourceId("cert", b));
  });

  it("always produces a name its own guard accepts", () => {
    // If this ever failed, provisioning would create resources it could never
    // clean up — they would bill forever with nothing tracking them.
    asProd();
    for (const kind of ["auth", "cert", "entry"] as const) {
      expect(isManagedResource(resourceId(kind, "shop.acme.com"))).toBe(true);
    }
  });
});

describe("isManagedResource", () => {
  it("refuses the platform's own certificate map entries", () => {
    // The entries that would take TLS down for storemink.com and every store
    // subdomain. They live in the same map this app writes to.
    asProd();
    for (const name of [
      "prod-apex",
      "prod-wildcard",
      "staging-apex",
      "staging-wildcard",
    ]) {
      expect(isManagedResource(name), name).toBe(false);
    }
  });

  it("refuses another environment's managed resources", () => {
    asProd();
    const prodEntry = resourceId("entry", "shop.acme.com");
    asStaging();
    // Staging shares the map with production; this is the only isolation
    // available without a second load balancer.
    expect(isManagedResource(prodEntry)).toBe(false);
  });

  it("accepts a full resource path, not just a bare id", () => {
    asProd();
    const id = resourceId("entry", "shop.acme.com");
    const path = `projects/705863961054/locations/global/certificateMaps/prod-cert-map/certificateMapEntries/${id}`;
    // A guard that only understood bare ids would silently never fire on the
    // paths the API actually returns.
    expect(isManagedResource(path)).toBe(true);
  });

  it("refuses empty, null and near-miss names", () => {
    asProd();
    for (const name of [
      "",
      null,
      undefined,
      MANAGED_PREFIX,
      "sm-domain",
      "x",
    ]) {
      expect(isManagedResource(name as string | null), String(name)).toBe(
        false,
      );
    }
  });
});

describe("assertManaged", () => {
  it("throws rather than quietly skipping the delete", () => {
    // A silent no-op would leave the caller believing it cleaned up, while the
    // resource kept billing with nothing tracking it.
    asProd();
    expect(() => assertManaged("prod-wildcard")).toThrow(/Refusing to delete/);
    expect(() => assertManaged(resourceId("entry", "a.com"))).not.toThrow();
  });
});
