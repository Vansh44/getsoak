import { describe, it, expect, vi, beforeEach } from "vitest";

// Force the environment answer. It is a build-time constant in the real module,
// so a getter is the only way to drive both branches from one file.
let isProdPlatform = false;
vi.mock("@/lib/store/host", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    get IS_PRODUCTION_PLATFORM() {
      return isProdPlatform;
    },
  };
});

// The gate must return before ANY of these are reached. Mocking them means the
// assertions below are about the gate, not about how well the mocks imitate
// Certificate Manager.
vi.mock("./certificates", () => ({
  ensureProvisioned: vi.fn(),
  getCertConfig: vi.fn(() => ({
    project: "p",
    location: "global",
    certificateMap: "m",
    loadBalancerIp: "1.2.3.4",
  })),
  reissueCertificate: vi.fn(),
}));
vi.mock("./dns", () => ({
  checkCnameTarget: vi.fn(),
  checkDomainPointsTo: vi.fn(),
}));

import { reconcileDomainForStore, NON_PRODUCTION_MESSAGE } from "./reconcile";
import { ensureProvisioned, getCertConfig } from "./certificates";

beforeEach(() => {
  vi.clearAllMocks();
  isProdPlatform = false;
});

// A custom domain resolves to one load balancer, whose url-map sends everything
// that isn't *.staging.storemink.com to the PRODUCTION backend. So a domain
// connected off prod can never reach the store that connected it — it only
// creates billable resources in the shared certificate map.
describe("reconcileDomainForStore — production-only provisioning", () => {
  it("refuses off production", async () => {
    const res = await reconcileDomainForStore("store-1");
    expect(res.verified).toBe(false);
    expect(res.error).toBe(NON_PRODUCTION_MESSAGE);
  });

  it("creates no Certificate Manager resources off production", async () => {
    // The point of the gate: not just an unverified result, but nothing billable
    // left behind in a map shared with production.
    await reconcileDomainForStore("store-1");
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it("refuses before the config check, so it reads as impossible not misconfigured", async () => {
    // Ordering matters for the message the developer sees: "this environment
    // can't" is the useful answer, "custom domains aren't configured" sends them
    // to check env vars that are in fact set correctly.
    await reconcileDomainForStore("store-1");
    expect(getCertConfig).not.toHaveBeenCalled();
  });

  it("does not short-circuit on production", async () => {
    // The guard must be the ONLY thing this flag changes: on prod the call has
    // to get past it and start doing real work.
    isProdPlatform = true;
    const res = await reconcileDomainForStore("store-1");
    expect(res.error).not.toBe(NON_PRODUCTION_MESSAGE);
  });
});
