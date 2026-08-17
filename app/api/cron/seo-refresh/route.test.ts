import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const submitSitemapToGoogle = vi.hoisted(() => vi.fn());
const ensureGoogleCoverageForStore = vi.hoisted(() => vi.fn());
const withService = vi.hoisted(() => vi.fn());

vi.mock("@/lib/seo/search-engines", () => ({ submitSitemapToGoogle }));
vi.mock("@/lib/seo/store-indexing", () => ({
  ensureGoogleCoverageForStore,
}));
vi.mock("@/lib/db/client", () => ({ withService }));
vi.mock("@/lib/store/host", () => ({
  PLATFORM_URL: "https://storemink.com",
  ROOT_DOMAIN: "storemink.com",
  SEARCH_INDEXABLE: true,
}));
vi.mock("@/lib/store/launch", () => ({
  isStoreSearchIndexable: vi.fn(() => true),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { GET } from "./route";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

function request() {
  return new Request("https://storemink.com/api/cron/seo-refresh", {
    headers: { authorization: "Bearer s3cret" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  submitSitemapToGoogle.mockResolvedValue({ ok: true });
  ensureGoogleCoverageForStore.mockResolvedValue({ ok: true });
  withService.mockImplementation(async (worker) =>
    worker({
      select: () => ({
        from: () => ({ where: async () => [] }),
      }),
    }),
  );
});

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
});

describe("/api/cron/seo-refresh root sitemap registration", () => {
  it("registers the platform, help, POS, and themes sitemaps", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(submitSitemapToGoogle.mock.calls.map(([url]) => url)).toEqual([
      "https://storemink.com/sitemap.xml",
      "https://help.storemink.com/sitemap.xml",
      "https://pos.storemink.com/sitemap.xml",
      "https://themes.storemink.com/sitemap.xml",
    ]);
    expect((await response.json()).roots).toEqual([
      {
        site: "platform",
        sitemap: "https://storemink.com/sitemap.xml",
        ok: true,
      },
      {
        site: "help",
        sitemap: "https://help.storemink.com/sitemap.xml",
        ok: true,
      },
      {
        site: "pos",
        sitemap: "https://pos.storemink.com/sitemap.xml",
        ok: true,
      },
      {
        site: "themes",
        sitemap: "https://themes.storemink.com/sitemap.xml",
        ok: true,
      },
    ]);
  });

  it("returns 503 and names the themes sitemap when Google rejects it", async () => {
    submitSitemapToGoogle
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "permission denied" });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.roots[3]).toEqual({
      site: "themes",
      sitemap: "https://themes.storemink.com/sitemap.xml",
      ok: false,
      error: "permission denied",
    });
  });
});
