/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const after = vi.hoisted(() => vi.fn());
const ensureGoogleCoverageForStore = vi.hoisted(() => vi.fn());
const reconcileStoreSearchSource = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({ after }));
vi.mock("@/lib/domains/reconcile", () => ({ sweepPendingDomains: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({
  recordEvent: vi.fn(async () => {}),
  emitEvent: vi.fn(),
}));
vi.mock("@/lib/site", () => ({ getStoreOriginById: vi.fn(async () => null) }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("@/lib/seo/store-indexing", () => ({ ensureGoogleCoverageForStore }));
vi.mock("@/lib/seo/search-metrics", () => ({ reconcileStoreSearchSource }));

import { GET, POST } from "./route";
import { sweepPendingDomains } from "@/lib/domains/reconcile";
import { recordEvent } from "@/lib/notifications/record";
import { getStoreOriginById } from "@/lib/site";
import { logError } from "@/lib/observability/logger";

function req(auth?: string): Request {
  return new Request("https://storemink.com/api/cron/domain-reconcile", {
    headers: auth ? { authorization: auth } : {},
  });
}

const EMPTY = {
  pending: 0,
  live: 0,
  becameLive: [] as any[],
  reverted: [] as any[],
  reissued: [] as string[],
  failures: [] as any[],
};

// The custom-domain backstop (§30). Connecting a domain cannot complete in one
// sitting, so without this the certificate reaches ACTIVE at Google and nothing
// ever attaches it — the domain never serves and the dashboard still says
// "waiting for your DNS records".
describe("/api/cron/domain-reconcile", () => {
  const OLD = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
    vi.mocked(sweepPendingDomains).mockResolvedValue({ ...EMPTY } as any);
  });

  afterEach(() => {
    if (OLD === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = OLD;
  });

  it("refuses a request with no Authorization header", async () => {
    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(sweepPendingDomains).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret", async () => {
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    expect(sweepPendingDomains).not.toHaveBeenCalled();
  });

  it("refuses everything when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;

    expect((await GET(req("Bearer undefined"))).status).toBe(401);
    expect(sweepPendingDomains).not.toHaveBeenCalled();
  });

  it("reports the sweep's tallies", async () => {
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      pending: 3,
      live: 11,
      reissued: ["acme.com"],
      failures: [{ domain: "slow.com", waitingDays: 2 }],
    } as any);

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      pending: 3,
      live: 11,
      reissued: ["acme.com"],
      waiting: [{ domain: "slow.com", waitingDays: 2 }],
    });
  });

  it("answers 200 while domains are still waiting", async () => {
    // The common "failure" is a merchant who hasn't added their DNS records
    // yet. Retrying within the hour cannot help, and a permanently-red job is
    // a job nobody looks at.
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      pending: 5,
      failures: [{ domain: "a.com" }, { domain: "b.com" }],
    } as any);

    expect((await GET(req("Bearer s3cret"))).status).toBe(200);
  });

  it("tells the merchant AND the operators when a domain goes live", async () => {
    // Same moment, two audiences — the store.created / platform.store_created
    // precedent, not duplication.
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      becameLive: [
        {
          storeId: "store-1",
          domain: "acme.com",
          extraHosts: ["www.acme.com"],
        },
      ],
    } as any);

    const res = await GET(req("Bearer s3cret"));

    expect(await res.json()).toMatchObject({ becameLive: ["acme.com"] });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "store.domain_live",
        storeId: "store-1",
        actor: { type: "system" },
        payload: expect.objectContaining({
          domain: "acme.com",
          store_url: "https://acme.com",
          extra_hosts: "www.acme.com",
        }),
      }),
    );
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "platform.domain_verified",
        storeId: "store-1",
      }),
    );
    expect(after).toHaveBeenCalledOnce();
    const continuation = after.mock.calls[0][0] as () => Promise<void>;
    await continuation();
    expect(ensureGoogleCoverageForStore).toHaveBeenCalledWith("store-1");
    expect(reconcileStoreSearchSource).toHaveBeenCalledWith("store-1");
  });

  it("uses recordEvent, not emitEvent", async () => {
    // emitEvent defers through after(), which has nothing to defer onto once a
    // cron response is sent — the merchant's mail would simply never go.
    const { emitEvent } = await import("@/lib/notifications/record");
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      becameLive: [{ storeId: "store-1", domain: "acme.com", extraHosts: [] }],
    } as any);

    await GET(req("Bearer s3cret"));

    expect(recordEvent).toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("copes with a live domain that reports no extra hosts", async () => {
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      becameLive: [{ storeId: "store-1", domain: "acme.com" }],
    } as any);

    await GET(req("Bearer s3cret"));

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ extra_hosts: "" }),
      }),
    );
  });

  it("copes with a live entry carrying no domain string", async () => {
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      becameLive: [{ storeId: "store-1", domain: null, extraHosts: null }],
    } as any);

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ domain: "", extra_hosts: "" }),
      }),
    );
  });

  it("notifies when a live domain is reverted, with the working address", async () => {
    // Their public address just changed under them and every link they shared
    // now goes elsewhere — the one notification here that must not be missable.
    vi.mocked(getStoreOriginById).mockResolvedValue(
      "https://acme.storemink.com",
    );
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      reverted: [
        { storeId: "store-9", domain: "broken.com", error: "NXDOMAIN" },
      ],
    } as any);

    const res = await GET(req("Bearer s3cret"));

    expect(await res.json()).toMatchObject({ reverted: ["broken.com"] });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "store.domain_reverted",
        storeId: "store-9",
        payload: {
          domain: "broken.com",
          store_url: "https://acme.storemink.com",
          reason: "NXDOMAIN",
        },
      }),
    );
  });

  it("still notifies a revert when the fallback origin cannot be resolved", async () => {
    vi.mocked(getStoreOriginById).mockResolvedValue(null);
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      reverted: [{ storeId: "store-9", domain: "broken.com", error: null }],
    } as any);

    await GET(req("Bearer s3cret"));

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "store.domain_reverted",
        payload: { domain: "broken.com", store_url: "", reason: "" },
      }),
    );
  });

  it("copes with a reverted entry carrying no domain string", async () => {
    vi.mocked(getStoreOriginById).mockResolvedValue(null);
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      reverted: [{ storeId: "store-9", domain: null, error: null }],
    } as any);

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "store.domain_reverted",
        subject: { type: "store", id: "store-9", label: "" },
        payload: { domain: "", store_url: "", reason: "" },
      }),
    );
  });

  it("notifies every store in a multi-domain sweep", async () => {
    vi.mocked(sweepPendingDomains).mockResolvedValue({
      ...EMPTY,
      becameLive: [
        { storeId: "s1", domain: "one.com", extraHosts: [] },
        { storeId: "s2", domain: "two.com", extraHosts: [] },
      ],
    } as any);

    await GET(req("Bearer s3cret"));

    // Two events per live domain (merchant + operator).
    expect(recordEvent).toHaveBeenCalledTimes(4);
  });

  it("answers 500 and logs when the sweep itself throws", async () => {
    vi.mocked(sweepPendingDomains).mockRejectedValue(new Error("GCP 503"));

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "GCP 503" });
    expect(logError).toHaveBeenCalledWith(
      "domain-reconcile cron failed",
      expect.anything(),
    );
  });

  it("reports a non-Error throw with a usable fallback message", async () => {
    vi.mocked(sweepPendingDomains).mockRejectedValue("boom");

    const res = await GET(req("Bearer s3cret"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      ok: false,
      error: "domain reconcile failed",
    });
  });

  it("serves POST identically to GET", async () => {
    const res = await POST(req("Bearer s3cret"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("refuses an unauthorized POST too", async () => {
    expect((await POST(req())).status).toBe(401);
  });
});
