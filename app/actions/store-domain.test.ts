/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));
const resendHolder = vi.hoisted(() => ({
  verify: vi.fn(),
  get: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({
  after: vi.fn((callback: () => unknown) => callback()),
}));
vi.mock("resend", () => ({
  Resend: class {
    domains = {
      verify: resendHolder.verify,
      get: resendHolder.get,
    };
  },
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getActingStoreId: vi.fn(async () => "store-1"),
  getManagerUserId: vi.fn(),
  getViewerAccess: vi.fn(),
}));
vi.mock("@/lib/store/resolve", () => ({ STORE_TAG: "stores" }));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/domains/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domains/domain")>();
  return {
    ...actual,
    routingRecords: vi.fn(() => [
      {
        type: "A",
        name: "@",
        fqdn: "acme.com",
        value: "203.0.113.9",
        purpose: "routing",
      },
    ]),
  };
});
vi.mock("@/lib/domains/certificates", () => ({
  deprovision: vi.fn(async () => ({})),
  getCertConfig: vi.fn(),
}));
vi.mock("@/lib/domains/reconcile", () => ({
  reconcileDomainForStore: vi.fn(),
  readStoreDomainRow: vi.fn(),
  storeAllowsCustomDomain: vi.fn(),
  UPGRADE_MESSAGE: "Upgrade to Pro to use a custom domain.",
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/auth/authorized-domains", () => ({
  removeAuthorizedDomain: vi.fn(async () => ({})),
}));
vi.mock("@/lib/store/host", () => ({ ROOT_DOMAIN: "storemink.com" }));
vi.mock("@/lib/seo/store-indexing", () => ({
  ensureGoogleCoverageForStore: vi.fn(async () => {}),
  GOOGLE_INDEXING_SETTINGS_KEYS: [
    "google_site_verification",
    "google_search_console_property",
  ],
}));
vi.mock("@/lib/seo/search-metrics", () => ({
  reconcileStoreSearchSource: vi.fn(async () => {}),
}));

import { revalidateTag } from "next/cache";
import { getManagerUserId, getViewerAccess } from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { routingRecords } from "@/lib/domains/domain";
import { deprovision, getCertConfig } from "@/lib/domains/certificates";
import {
  reconcileDomainForStore,
  readStoreDomainRow,
  storeAllowsCustomDomain,
} from "@/lib/domains/reconcile";
import { logError } from "@/lib/observability/logger";
import { removeAuthorizedDomain } from "@/lib/auth/authorized-domains";
import { ensureGoogleCoverageForStore } from "@/lib/seo/store-indexing";
import { stores } from "@/drizzle/schema";
import {
  disconnectDomain,
  getDomainConnectionState,
  updateCustomDomain,
  verifyDomain,
  verifyResendDomain,
} from "./store-domain";

const OLD_SETTINGS = {
  theme: "classic",
  custom_domain_verified: true,
  resend_domain_id: "resend-1",
  resend_domain_verified: true,
  domain_challenge: { name: "old", value: "old" },
  domain_challenges: [{ name: "old", value: "old" }],
  domain_cert_state: "ACTIVE",
  domain_cert_issue: "none",
  domain_extra_hosts: ["www.old.com"],
  domain_health_checked_at: "yesterday",
  domain_health_failures: 2,
  domain_reissued: true,
  domain_pending_since: "yesterday",
  google_site_verification: "token",
  google_search_console_property: "sc-domain:old.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  dbHolder.current = makeDbMock();
  resendHolder.verify.mockResolvedValue({ data: {}, error: null });
  resendHolder.get.mockResolvedValue({
    data: { status: "verified" },
    error: null,
  });
  vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
  vi.mocked(getViewerAccess).mockResolvedValue({
    can: vi.fn(() => true),
  } as any);
  vi.mocked(getCertConfig).mockReturnValue({
    loadBalancerIp: "203.0.113.9",
  } as any);
  vi.mocked(storeAllowsCustomDomain).mockResolvedValue({
    allowed: true,
  } as any);
  vi.mocked(readStoreDomainRow).mockResolvedValue({
    custom_domain: "old.com",
    settings: OLD_SETTINGS,
  } as any);
  vi.mocked(reconcileDomainForStore).mockResolvedValue({
    verified: true,
    becameLive: false,
    domain: "acme.com",
    extraHosts: ["www.acme.com"],
  } as any);
  vi.mocked(deprovision).mockResolvedValue({} as any);
  vi.mocked(removeAuthorizedDomain).mockResolvedValue({} as any);
});

describe("updateCustomDomain", () => {
  it("requires settings.manage before validation or provider work", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    expect(await updateCustomDomain("acme.com")).toEqual({
      error: "You don't have permission to manage domain settings.",
    });
    expect(readStoreDomainRow).not.toHaveBeenCalled();
  });

  it.each([
    ["*.acme.com", /wildcard/i],
    ["203.0.113.9", /not an ip address/i],
    ["storemink.com", /free storemink\.com address/i],
  ])(
    "rejects an unsafe domain before reading the store (%s)",
    async (domain, message) => {
      expect((await updateCustomDomain(domain)).error).toMatch(message);
      expect(readStoreDomainRow).not.toHaveBeenCalled();
    },
  );

  it("enforces plan entitlement server-side but always permits disconnect", async () => {
    vi.mocked(storeAllowsCustomDomain).mockResolvedValue({
      allowed: false,
    } as any);
    expect((await updateCustomDomain("acme.com")).error).toMatch(
      /upgrade to pro/i,
    );
    expect(await updateCustomDomain(null)).toEqual({ success: true });
  });

  it("normalizes the hostname and clears every proof inherited from the old domain", async () => {
    const result = await updateCustomDomain("  Shop.Acme.COM.  ");

    expect(result).toEqual({ success: true });
    expect(dbHolder.current.calls.update[0]).toBe(stores);
    expect(dbHolder.current.calls.set[0].customDomain).toBe("shop.acme.com");
    expect(dbHolder.current.calls.set[0].settings).toEqual({
      theme: "classic",
    });
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
      "store-1",
    );
    expect(revalidateTag).toHaveBeenCalledWith("stores", "max");
  });

  it("releases the replaced domain and removes its Google sign-in authorization", async () => {
    await updateCustomDomain("acme.com");
    await vi.waitFor(() => expect(deprovision).toHaveBeenCalledWith("old.com"));
    expect(removeAuthorizedDomain).toHaveBeenCalledWith(
      "old.com",
      "storemink.com",
    );
  });

  it("does not deprovision when the normalized domain is unchanged", async () => {
    vi.mocked(readStoreDomainRow).mockResolvedValue({
      custom_domain: "acme.com",
      settings: {},
    } as any);
    await updateCustomDomain("ACME.COM");
    expect(deprovision).not.toHaveBeenCalled();
  });

  it("does not touch the database if the current row cannot be read", async () => {
    vi.mocked(readStoreDomainRow).mockRejectedValue(new Error("offline"));
    expect(await updateCustomDomain("acme.com")).toEqual({
      error: "Failed to load the store. Please try again.",
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("does not release the old domain unless the new domain was saved", async () => {
    dbHolder.current.db.update = vi.fn(() => {
      throw new Error("write failed");
    });
    expect(await updateCustomDomain("acme.com")).toEqual({
      error: "Failed to save domain in database.",
    });
    expect(deprovision).not.toHaveBeenCalled();
    expect(removeAuthorizedDomain).not.toHaveBeenCalled();
  });
});

describe("verifyResendDomain", () => {
  it("requires settings.manage and a configured provider", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    expect(await verifyResendDomain("resend-1")).toEqual({
      error: "You don't have permission to manage domain settings.",
    });

    vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await verifyResendDomain("resend-1")).toEqual({
      error: "Resend API key not configured.",
    });
  });

  it("returns the provider error without changing store settings", async () => {
    resendHolder.verify.mockResolvedValue({
      data: null,
      error: { message: "DNS not ready" },
    });
    expect(await verifyResendDomain("resend-1")).toEqual({
      error: "DNS not ready",
    });
    expect(resendHolder.get).not.toHaveBeenCalled();
  });

  it("mirrors email verification without marking storefront routing verified", async () => {
    vi.mocked(readStoreDomainRow).mockResolvedValue({
      custom_domain: "acme.com",
      settings: { custom_domain_verified: false },
    } as any);

    expect(await verifyResendDomain("resend-1")).toEqual({ success: true });

    expect(dbHolder.current.calls.set[0].settings).toEqual({
      custom_domain_verified: false,
      resend_domain_verified: true,
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("getDomainConnectionState", () => {
  it("returns no store information without settings.view", async () => {
    vi.mocked(getViewerAccess).mockResolvedValue({
      can: vi.fn(() => false),
    } as any);
    expect(await getDomainConnectionState()).toMatchObject({
      domain: null,
      verified: false,
      allowed: false,
      records: [],
    });
    expect(readStoreDomainRow).not.toHaveBeenCalled();
  });

  it("reports entitlement even when domain infrastructure is unavailable", async () => {
    vi.mocked(getCertConfig).mockReturnValue(null);
    vi.mocked(readStoreDomainRow).mockResolvedValue({
      custom_domain: "acme.com",
      settings: { custom_domain_verified: true },
    } as any);

    expect(await getDomainConnectionState()).toMatchObject({
      domain: "acme.com",
      verified: true,
      allowed: true,
      available: false,
      records: [],
    });
  });

  it("returns routing and one challenge instruction per certificate host", async () => {
    vi.mocked(readStoreDomainRow).mockResolvedValue({
      custom_domain: "acme.com",
      settings: {
        custom_domain_verified: false,
        domain_cert_state: "PROVISIONING",
        domain_extra_hosts: ["www.acme.com"],
        domain_challenges: [
          { name: "_acme.acme.com", value: "token-a" },
          { name: "_www.www.acme.com", value: "token-www" },
        ],
      },
    } as any);

    const result = await getDomainConnectionState();

    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toMatchObject({ type: "A", name: "@" });
    expect(result.records.slice(1)).toEqual([
      expect.objectContaining({ type: "CNAME", value: "token-a" }),
      expect.objectContaining({ type: "CNAME", value: "token-www" }),
    ]);
    expect(result.certificateState).toBe("PROVISIONING");
    expect(result.extraHosts).toEqual(["www.acme.com"]);
    expect(routingRecords).toHaveBeenCalledWith("acme.com", "203.0.113.9");
  });

  it("contains a store-row read failure and returns an empty domain", async () => {
    vi.mocked(readStoreDomainRow).mockRejectedValue(new Error("offline"));
    expect(await getDomainConnectionState()).toMatchObject({
      domain: null,
      verified: false,
      allowed: true,
    });
  });
});

describe("verifyDomain", () => {
  it("requires settings.manage before reconciliation", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    expect(await verifyDomain()).toEqual({
      error: "You don't have permission to manage domain settings.",
    });
    expect(reconcileDomainForStore).not.toHaveBeenCalled();
  });

  it("returns the precise reconciliation blocker", async () => {
    vi.mocked(reconcileDomainForStore).mockResolvedValue({
      verified: false,
      error: "Add the CNAME record.",
    } as any);
    expect(await verifyDomain()).toEqual({ error: "Add the CNAME record." });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("emits merchant and platform milestones exactly when the domain becomes live", async () => {
    vi.mocked(reconcileDomainForStore).mockResolvedValue({
      verified: true,
      becameLive: true,
      domain: "acme.com",
      extraHosts: ["www.acme.com"],
    } as any);

    expect(await verifyDomain()).toEqual({ success: true });

    expect(emitEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "store.domain_live",
        storeId: "store-1",
        payload: expect.objectContaining({ domain: "acme.com" }),
      }),
    );
    expect(emitEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "platform.domain_verified",
        storeId: "store-1",
      }),
    );
    await vi.waitFor(() =>
      expect(ensureGoogleCoverageForStore).toHaveBeenCalledWith("store-1"),
    );
  });

  it("does not duplicate milestones on an already-live domain", async () => {
    expect(await verifyDomain()).toEqual({ success: true });
    expect(emitEvent).not.toHaveBeenCalled();
    expect(ensureGoogleCoverageForStore).not.toHaveBeenCalled();
  });
});

describe("disconnectDomain", () => {
  it("is idempotent when no custom domain exists", async () => {
    vi.mocked(readStoreDomainRow).mockResolvedValue({
      custom_domain: null,
      settings: {},
    } as any);
    expect(await disconnectDomain()).toEqual({ success: true });
    expect(dbHolder.current.calls.update).toHaveLength(0);
    expect(deprovision).not.toHaveBeenCalled();
  });

  it("stops serving first, clears routing/indexing state, then releases resources", async () => {
    expect(await disconnectDomain()).toEqual({ success: true });

    expect(dbHolder.current.calls.set[0]).toEqual({
      customDomain: null,
      settings: {
        theme: "classic",
        resend_domain_id: "resend-1",
        resend_domain_verified: true,
      },
    });
    expect(revalidateTag).toHaveBeenCalledWith("stores", "max");
    expect(deprovision).toHaveBeenCalledWith("old.com");
    expect(removeAuthorizedDomain).toHaveBeenCalledWith(
      "old.com",
      "storemink.com",
    );
  });

  it("does not deprovision if the routing write fails", async () => {
    dbHolder.current.db.update = vi.fn(() => {
      throw new Error("write failed");
    });
    expect(await disconnectDomain()).toEqual({
      error: "Couldn't disconnect the domain. Please try again.",
    });
    expect(deprovision).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "disconnectDomain (db)",
      expect.any(Error),
      { storeId: "store-1" },
    );
  });

  it("reports cleanup failures but keeps the successful disconnect", async () => {
    vi.mocked(deprovision).mockResolvedValue({
      error: "cert cleanup failed",
    } as any);
    vi.mocked(removeAuthorizedDomain).mockResolvedValue({
      error: "deauth failed",
    } as any);
    expect(await disconnectDomain()).toEqual({ success: true });
    expect(logError).toHaveBeenCalledWith(
      "disconnectDomain (deprovision)",
      "cert cleanup failed",
      { domain: "old.com" },
    );
    expect(logError).toHaveBeenCalledWith(
      "disconnectDomain (deauthorize)",
      "deauth failed",
      { domain: "old.com" },
    );
  });
});
