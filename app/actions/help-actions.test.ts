/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("next/cache", () => ({ updateTag: vi.fn() }));
vi.mock("next/server", () => ({
  after: vi.fn((callback: () => unknown) => callback()),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => "203.0.113.10" })),
}));
vi.mock("@/lib/db/client", () => ({
  withAnon: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/app/actions/platform", () => ({ getPlatformViewer: vi.fn() }));
vi.mock("@/lib/storage/cleanup", () => ({
  deleteStorageUrls: vi.fn(async () => {}),
  extractMediaUrlsFromHtml: vi.fn((html: string) =>
    [...html.matchAll(/https:\/\/storage\.test\/[^"'<\s]+/g)].map(
      (match) => match[0],
    ),
  ),
}));
vi.mock("@/lib/ai/gemini", () => ({ callGemini: vi.fn() }));
vi.mock("@/lib/help/embedding-worker", () => ({
  refreshHelpArticleEmbeddings: vi.fn(async () => ({
    status: "indexed",
    articleId: "article-1",
    chunks: 1,
  })),
}));
vi.mock("@/lib/help/embedding-trigger", () => ({
  triggerHelpEmbeddingWorker: vi.fn(async () => undefined),
}));
vi.mock("@/lib/observability/logger", () => ({ logWarn: vi.fn() }));
vi.mock("@/lib/seo/search-engines", () => ({
  pingIndexNow: vi.fn(async () => {}),
  submitSitemapToGoogle: vi.fn(async () => ({ ok: true, status: 204 })),
}));
vi.mock("@/lib/store/host", () => ({ SEARCH_INDEXABLE: true }));
vi.mock("@/lib/site", () => ({ HELP_URL: "https://help.storemink.com" }));
vi.mock("@/lib/rate-limit", () => ({
  clientIp: vi.fn(() => "203.0.113.10"),
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/help/queries", () => ({
  searchHelpArticles: vi.fn(),
  getHelpCategories: vi.fn(),
  getHelpSearchCatalog: vi.fn(),
}));

import { updateTag } from "next/cache";
import { getServerUser } from "@/lib/auth/server-user";
import { getPlatformViewer } from "@/app/actions/platform";
import {
  deleteStorageUrls,
  extractMediaUrlsFromHtml,
} from "@/lib/storage/cleanup";
import { callGemini } from "@/lib/ai/gemini";
import { refreshHelpArticleEmbeddings } from "@/lib/help/embedding-worker";
import { triggerHelpEmbeddingWorker } from "@/lib/help/embedding-trigger";
import { pingIndexNow, submitSitemapToGoogle } from "@/lib/seo/search-engines";
import { rateLimit } from "@/lib/rate-limit";
import {
  getHelpCategories,
  getHelpSearchCatalog,
  searchHelpArticles,
} from "@/lib/help/queries";
import { helpArticles, helpCategories } from "@/drizzle/schema";
import {
  createHelpArticle,
  createHelpCategory,
  deleteHelpArticle,
  deleteHelpCategory,
  getHelpArticleForEditor,
  listHelpArticlesAdmin,
  listHelpCategoriesAdmin,
  recordHelpArticleView,
  reorderHelpArticles,
  reorderHelpCategories,
  runHelpAiCommand,
  setHelpArticleStatus,
  searchPublishedHelpWithAi,
  suggestHelpArticles,
  updateHelpArticle,
  updateHelpCategory,
  voteHelpArticle,
  type HelpArticleInput,
} from "./help-actions";

const ARTICLE_INPUT: HelpArticleInput = {
  title: " Connect a custom domain ",
  slug: "connect-domain",
  categoryId: "category-1",
  excerpt: " Connect your domain. ",
  body: '<p>Safe instructions explain how to connect and verify the domain.</p><h2>Steps</h2><ol><li>Open Domain settings.</li></ol><script>alert("x")</script>',
  status: "published",
  seoTitle: " Custom domains ",
  seoDescription: " Learn how to connect a domain. ",
};

const ARTICLE = {
  id: "article-1",
  categoryId: "category-1",
  slug: "connect-domain",
  title: "Connect a custom domain",
  excerpt: "Connect your domain.",
  body: '<p>Existing instructions explain how to connect and verify the domain safely.</p><img src="https://storage.test/old.webp">',
  status: "draft",
  position: 0,
  viewCount: 10,
  helpfulYes: 2,
  helpfulNo: 1,
  seoTitle: "Custom domains",
  seoDescription: "Learn how to connect and verify a custom store domain.",
  createdBy: "operator-1",
  updatedBy: "operator-1",
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  publishedAt: null,
};

const CATEGORY = {
  id: "category-1",
  slug: "domains",
  title: "Domains",
  description: "Domain help",
  icon: "globe",
  position: 0,
};

const SEARCH_CATALOGUE = [
  {
    id: "article-1",
    categoryId: "category-1",
    categorySlug: "domains",
    categoryTitle: "Domains",
    slug: "connect-domain",
    title: "Connect a custom domain",
    excerpt: "Connect and verify a domain you own.",
  },
];

const POS_SEARCH_CATALOGUE = [
  {
    id: "article-pos-sale",
    categoryId: "category-pos",
    categorySlug: "point-of-sale",
    categoryTitle: "Point of Sale",
    slug: "process-an-in-store-sale",
    title: "Process an in-store sale",
    excerpt:
      "Add products, attach a customer, take payment, and finish a sale safely.",
  },
  {
    id: "article-pos-device",
    categoryId: "category-pos",
    categorySlug: "point-of-sale",
    categoryTitle: "Point of Sale",
    slug: "authorise-a-pos-device",
    title: "Authorise a POS device",
    excerpt: "Connect a phone, tablet, or computer to a location.",
  },
];

const COMPLETE_HELP_SEARCH_CATALOGUE = [
  {
    categorySlug: "getting-started",
    categoryTitle: "Getting started",
    slug: "troubleshoot-signup-login-and-store-access",
    title: "Troubleshoot signup, login, and store access",
    excerpt: "Fix password and account access problems.",
  },
  {
    categorySlug: "storefront",
    categoryTitle: "Setting up your store",
    slug: "use-the-storemink-website-builder",
    title: "Use the StoreMink Website Builder",
    excerpt: "Build and publish storefront pages and sections.",
  },
  {
    categorySlug: "products",
    categoryTitle: "Products & inventory",
    slug: "track-inventory-and-allow-backorders",
    title: "Track inventory and allow backorders",
    excerpt: "Understand stock, availability, and backorders.",
  },
  {
    categorySlug: "customers",
    categoryTitle: "Customers & enquiries",
    slug: "create-and-manage-customer-groups",
    title: "Create and manage customer groups",
    excerpt: "Organize shoppers into useful customer groups.",
  },
  {
    categorySlug: "payments",
    categoryTitle: "Payments, GST & COD",
    slug: "connect-razorpay-and-accept-online-payments",
    title: "Connect Razorpay and accept online payments",
    excerpt: "Connect a gateway and take verified online payments.",
  },
  {
    categorySlug: "domains",
    categoryTitle: "Domains",
    slug: "how-to-add-custom-domain",
    title: "Connect a custom domain",
    excerpt: "Add DNS records and wait for secure HTTPS.",
  },
  {
    categorySlug: "orders",
    categoryTitle: "Orders, locations & shipping",
    slug: "set-shipping-charges-and-delivery-estimates",
    title: "Set shipping charges and delivery estimates",
    excerpt: "Configure delivery prices and promises.",
  },
  {
    categorySlug: "marketing",
    categoryTitle: "Marketing, blogs & communication",
    slug: "send-a-coupon-email-campaign",
    title: "Send a coupon email campaign",
    excerpt: "Send a discount offer to registered customers.",
  },
  {
    categorySlug: "account",
    categoryTitle: "Account, staff & billing",
    slug: "manage-your-storemink-plan-and-subscription",
    title: "Manage your StoreMink plan and subscription",
    excerpt: "Upgrade, cancel, or resume your billing plan.",
  },
].map((article, index) => ({
  id: `article-complete-${index}`,
  categoryId: `category-complete-${index}`,
  ...article,
}));

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = makeDbMock();
  vi.mocked(getPlatformViewer).mockResolvedValue({
    id: "operator-1",
  } as any);
  vi.mocked(getServerUser).mockResolvedValue({
    id: "operator-1",
    email: "ops@storemink.com",
  } as any);
  vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
  vi.mocked(searchHelpArticles).mockResolvedValue([]);
  vi.mocked(getHelpCategories).mockResolvedValue([]);
  vi.mocked(getHelpSearchCatalog).mockResolvedValue([]);
  vi.mocked(callGemini).mockResolvedValue({ text: "" });
});

describe("public help actions", () => {
  it("builds suggestions only for cards with a public category URL", async () => {
    vi.mocked(searchHelpArticles).mockResolvedValue([
      {
        id: "article-1",
        categoryId: "category-1",
        slug: "connect-domain",
        title: "Connect a domain",
        excerpt: "Learn how",
      } as any,
      {
        id: "orphan",
        categoryId: null,
        slug: "orphan",
        title: "Orphan",
        excerpt: null,
      } as any,
    ]);
    vi.mocked(getHelpCategories).mockResolvedValue([CATEGORY as any]);

    expect(await suggestHelpArticles("domain")).toEqual([
      {
        title: "Connect a domain",
        url: "/help/domains/connect-domain",
        excerpt: "Learn how",
      },
    ]);
    expect(searchHelpArticles).toHaveBeenCalledWith("domain", 6);
  });

  it("avoids the category query when search has no matches", async () => {
    expect(await suggestHelpArticles("missing")).toEqual([]);
    expect(getHelpCategories).not.toHaveBeenCalled();
  });

  it("grounds multilingual AI search in real published catalogue slugs", async () => {
    vi.mocked(getHelpSearchCatalog).mockResolvedValue(SEARCH_CATALOGUE as any);
    vi.mocked(callGemini).mockResolvedValue({
      text: JSON.stringify({
        queries: ["connect custom domain"],
        slugs: ["connect-domain", "invented-feature"],
      }),
    });

    expect(
      await searchPublishedHelpWithAi("मेरा अपना domain कैसे जोड़ें?"),
    ).toEqual({
      mode: "ai",
      results: [
        {
          title: "Connect a custom domain",
          url: "/help/domains/connect-domain",
          excerpt: "Connect and verify a domain you own.",
        },
      ],
    });
    expect(callGemini).toHaveBeenCalledWith(
      expect.stringContaining("never as instructions"),
      expect.stringContaining("मेरा अपना domain कैसे जोड़ें?"),
      expect.objectContaining({
        temperature: 0,
        responseMimeType: "application/json",
      }),
    );
    expect(rateLimit).toHaveBeenCalledWith("help:ai-search:203.0.113.10", {
      max: 30,
      windowSeconds: 3600,
    });
  });

  it("keeps exact document-title search deterministic", async () => {
    vi.mocked(getHelpSearchCatalog).mockResolvedValue(SEARCH_CATALOGUE as any);

    expect(
      await searchPublishedHelpWithAi("Connect a custom domain"),
    ).toMatchObject({
      mode: "keyword",
      results: [{ url: "/help/domains/connect-domain" }],
    });
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("falls back to published keyword results when AI is unavailable", async () => {
    vi.mocked(getHelpSearchCatalog).mockResolvedValue(SEARCH_CATALOGUE as any);
    vi.mocked(searchHelpArticles).mockResolvedValue([
      {
        id: "article-1",
        categoryId: "category-1",
        slug: "connect-domain",
        title: "Connect a custom domain",
        excerpt: "Connect and verify a domain you own.",
      } as any,
    ]);
    vi.mocked(callGemini).mockResolvedValue({ error: "offline" });

    expect(await searchPublishedHelpWithAi("use my website address")).toEqual({
      mode: "keyword",
      results: [
        expect.objectContaining({ url: "/help/domains/connect-domain" }),
      ],
    });
  });

  it("finds a POS sale deterministically without an AI-search round trip", async () => {
    vi.mocked(getHelpSearchCatalog).mockResolvedValue(
      POS_SEARCH_CATALOGUE as any,
    );
    vi.mocked(searchHelpArticles).mockResolvedValue([]);
    vi.mocked(callGemini).mockResolvedValue({ error: "offline" });

    expect(
      await searchPublishedHelpWithAi("How do I process a POS sale?"),
    ).toEqual({
      mode: "keyword",
      results: [
        expect.objectContaining({
          url: "/help/point-of-sale/process-an-in-store-sale",
        }),
        expect.objectContaining({
          url: "/help/point-of-sale/authorise-a-pos-device",
        }),
      ],
    });
    expect(callGemini).not.toHaveBeenCalled();
  });

  it("keeps deterministic alias retrieval when AI search is rate limited", async () => {
    vi.mocked(getHelpSearchCatalog).mockResolvedValue(SEARCH_CATALOGUE as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);

    const result = await searchPublishedHelpWithAi("use my website address");

    expect(result.results[0]?.url).toBe("/help/domains/connect-domain");
    expect(callGemini).not.toHaveBeenCalled();
  });

  it.each([
    ["forgot password", "troubleshoot-signup-login-and-store-access"],
    ["website builder page", "use-the-storemink-website-builder"],
    ["inventory stock backorder", "track-inventory-and-allow-backorders"],
    ["customer shopper groups", "create-and-manage-customer-groups"],
    ["Razorpay gateway payment", "connect-razorpay-and-accept-online-payments"],
    ["custom domain DNS", "how-to-add-custom-domain"],
    [
      "shipping delivery charges",
      "set-shipping-charges-and-delivery-estimates",
    ],
    ["promotion", "send-a-coupon-email-campaign"],
    [
      "billing plan subscription",
      "manage-your-storemink-plan-and-subscription",
    ],
  ])(
    "retrieves %s from the cross-category catalogue without AI",
    async (query, expectedSlug) => {
      vi.mocked(getHelpSearchCatalog).mockResolvedValue(
        COMPLETE_HELP_SEARCH_CATALOGUE as any,
      );
      vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);

      const result = await searchPublishedHelpWithAi(query);

      expect(result.results[0]?.url).toMatch(new RegExp(`/${expectedSlug}$`));
      expect(callGemini).not.toHaveBeenCalled();
    },
  );

  it("rate limits view inflation by IP and writes through the anon RPC", async () => {
    await recordHelpArticleView("article-1");
    expect(rateLimit).toHaveBeenCalledWith("help:view:203.0.113.10", {
      max: 200,
      windowSeconds: 3600,
    });
    expect(dbHolder.current.calls.execute).toHaveLength(1);

    vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);
    dbHolder.current = makeDbMock();
    await recordHelpArticleView("article-1");
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("keeps view counting best-effort", async () => {
    dbHolder.current.db.execute = vi.fn(() => {
      throw new Error("offline");
    });
    await expect(recordHelpArticleView("article-1")).resolves.toBeUndefined();
  });

  it("validates and rate limits public helpful votes", async () => {
    expect(await voteHelpArticle("", true)).toEqual({
      error: "Missing article.",
    });
    expect(await voteHelpArticle("article-1", true)).toEqual({ success: true });
    expect(rateLimit).toHaveBeenCalledWith("help:vote:203.0.113.10", {
      max: 20,
      windowSeconds: 3600,
    });
    expect(dbHolder.current.calls.execute).toHaveLength(1);
    expect(updateTag).not.toHaveBeenCalled();
  });

  it("silently accepts a throttled vote without writing", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);
    expect(await voteHelpArticle("article-1", false)).toEqual({
      success: true,
    });
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("reports an RPC failure without leaking database details", async () => {
    dbHolder.current.db.execute = vi.fn(() => {
      throw new Error("permission denied for relation help_articles");
    });
    expect(await voteHelpArticle("article-1", true)).toEqual({
      error: "Could not record your feedback.",
    });
  });
});

describe("operator gate", () => {
  it("requires both the platform allowlist and an authenticated user", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(null);
    expect(await listHelpArticlesAdmin()).toEqual([]);
    expect(await createHelpArticle(ARTICLE_INPUT)).toEqual({
      error: "Not authorized.",
    });

    vi.mocked(getPlatformViewer).mockResolvedValue({ id: "operator-1" } as any);
    vi.mocked(getServerUser).mockResolvedValue(null);
    expect(await listHelpCategoriesAdmin()).toEqual([]);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });
});

describe("article administration", () => {
  it("lists and filters every status for an operator", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[ARTICLE]] });
    const rows = await listHelpArticlesAdmin({
      q: "domain",
      categoryId: "category-1",
      status: "draft",
    });
    expect(rows).toHaveLength(1);
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toEqual(
      expect.arrayContaining(["%domain%", "category-1", "draft"]),
    );
  });

  it("returns the full editor row and contains read errors", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[ARTICLE]] });
    expect((await getHelpArticleForEditor("article-1"))?.body).toContain(
      "Existing instructions",
    );

    dbHolder.current.db.select = vi.fn(() => {
      throw new Error("offline");
    });
    await expect(getHelpArticleForEditor("article-1")).resolves.toBeNull();
  });

  it("requires a title and sanitizes bounded article fields", async () => {
    expect(await createHelpArticle({ ...ARTICLE_INPUT, title: " " })).toEqual({
      error: "Title is required.",
    });

    dbHolder.current = makeDbMock({
      selectQueue: [[]],
      returning: [{ id: "article-1", slug: "connect-domain" }],
    });
    const result = await createHelpArticle(ARTICLE_INPUT);
    expect(result).toMatchObject({
      success: true,
      data: { id: "article-1", slug: "connect-domain" },
    });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      title: "Connect a custom domain",
      excerpt: "Connect your domain.",
      body: "<p>Safe instructions explain how to connect and verify the domain.</p><h2>Steps</h2><ol><li>Open Domain settings.</li></ol>",
      status: "published",
      slug: "connect-domain",
      createdBy: "operator-1",
      updatedBy: "operator-1",
    });
    expect(refreshHelpArticleEmbeddings).toHaveBeenCalledWith("article-1");
  });

  it("refuses to publish empty or incomplete help content", async () => {
    expect(
      await createHelpArticle({
        ...ARTICLE_INPUT,
        excerpt: "",
      }),
    ).toEqual({ error: "Add a short summary before publishing." });

    expect(
      await createHelpArticle({
        ...ARTICLE_INPUT,
        body: "<p>Too short</p>",
      }),
    ).toEqual({ error: "Add useful article content before publishing." });

    expect(
      await createHelpArticle({
        ...ARTICLE_INPUT,
        seoDescription: "",
      }),
    ).toEqual({
      error: "Add an SEO title and description before publishing.",
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("chooses the next available global slug", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          { id: "a", slug: "connect-domain" },
          { id: "b", slug: "connect-domain-2" },
        ],
      ],
      returning: [{ id: "article-3", slug: "connect-domain-3" }],
    });
    await createHelpArticle(ARTICLE_INPUT);
    expect(dbHolder.current.calls.values[0].slug).toBe("connect-domain-3");
  });

  it("maps unique violations to a safe slug message", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    dbHolder.current.db.insert = vi.fn(() => {
      throw new Error("duplicate key value violates unique constraint");
    });
    expect(await createHelpArticle(ARTICLE_INPUT)).toEqual({
      error: "That slug is already in use.",
    });
  });

  it("preserves the first publish timestamp on later edits", async () => {
    const published = {
      ...ARTICLE,
      status: "published",
      publishedAt: "2026-08-01T00:00:00.000Z",
    };
    dbHolder.current = makeDbMock({
      selectQueue: [[published], [{ id: "article-1", slug: "connect-domain" }]],
    });

    const result = await updateHelpArticle("article-1", ARTICLE_INPUT);

    expect(result).toMatchObject({
      success: true,
      data: { slug: "connect-domain" },
    });
    expect(dbHolder.current.calls.set[0].publishedAt).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  it("deletes media removed from an article body after the write", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[ARTICLE], [{ id: "article-1", slug: "connect-domain" }]],
    });
    await updateHelpArticle("article-1", {
      ...ARTICLE_INPUT,
      body: "<p>New instructions explain how to connect and verify the domain safely.</p>",
    });
    await vi.waitFor(() =>
      expect(deleteStorageUrls).toHaveBeenCalledWith([
        "https://storage.test/old.webp",
      ]),
    );
  });

  it("deletes article media best-effort after the database row", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[ARTICLE]] });
    expect(await deleteHelpArticle("article-1")).toEqual({ success: true });
    expect(dbHolder.current.calls.delete[0]).toBe(helpArticles);
    expect(extractMediaUrlsFromHtml).toHaveBeenCalledWith(ARTICLE.body);
    await vi.waitFor(() => expect(deleteStorageUrls).toHaveBeenCalled());
  });

  it("sets publish state and announces all affected public URLs", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[ARTICLE]],
      returning: [{ slug: "connect-domain", categoryId: "category-1" }],
    });
    vi.mocked(getHelpCategories).mockResolvedValue([CATEGORY as any]);

    expect(await setHelpArticleStatus("article-1", "published")).toEqual({
      success: true,
    });
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      status: "published",
      updatedBy: "operator-1",
    });
    expect(refreshHelpArticleEmbeddings).toHaveBeenCalledWith("article-1");
    await vi.waitFor(() =>
      expect(pingIndexNow).toHaveBeenCalledWith([
        "https://help.storemink.com/help/domains/connect-domain",
        "https://help.storemink.com/help/domains",
        "https://help.storemink.com/help",
      ]),
    );
    expect(submitSitemapToGoogle).toHaveBeenCalledWith(
      "https://help.storemink.com/sitemap.xml",
    );
  });

  it("refuses to publish an article without a canonical category", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...ARTICLE, categoryId: null }]],
    });

    expect(await setHelpArticleStatus("article-1", "published")).toEqual({
      error: "Choose a category before publishing.",
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("refuses to publish a draft with no useful body", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...ARTICLE, body: "<p></p>" }]],
    });

    expect(await setHelpArticleStatus("article-1", "published")).toEqual({
      error: "Add useful article content before publishing.",
    });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("persists article order sequentially and invalidates once", async () => {
    expect(await reorderHelpArticles(["a", "b", "c"])).toEqual({
      success: true,
    });
    expect(dbHolder.current.calls.set).toEqual([
      { position: 0 },
      { position: 1 },
      { position: 2 },
    ]);
    expect(updateTag).toHaveBeenCalledTimes(1);
  });
});

describe("category administration", () => {
  it("lists categories in configured order", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[CATEGORY]] });
    expect(await listHelpCategoriesAdmin()).toEqual([CATEGORY]);
  });

  it("requires a title and creates a normalized category", async () => {
    expect(
      await createHelpCategory({
        slug: "",
        title: " ",
        description: "",
        icon: "",
      }),
    ).toEqual({ error: "Title is required." });

    expect(
      await createHelpCategory({
        slug: "",
        title: " Getting Started ",
        description: " First steps ",
        icon: " rocket ",
      }),
    ).toEqual({ success: true });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      slug: "getting-started",
      title: "Getting Started",
      description: "First steps",
      icon: "rocket",
    });
  });

  it("updates editable category fields without blanking an omitted slug", async () => {
    expect(
      await updateHelpCategory("category-1", {
        slug: "",
        title: " ",
        description: "",
        icon: "",
      }),
    ).toEqual({ error: "Title is required." });
    expect(dbHolder.current.calls.update).toHaveLength(0);

    expect(
      await updateHelpCategory("category-1", {
        slug: "",
        title: " Domains and DNS ",
        description: "",
        icon: " globe ",
      }),
    ).toEqual({ success: true });
    expect(dbHolder.current.calls.set[0]).toMatchObject({
      title: "Domains and DNS",
      description: null,
      icon: "globe",
    });
    expect(dbHolder.current.calls.set[0]).not.toHaveProperty("slug");
    expect(dbHolder.current.calls.set[1]).toHaveProperty("updatedAt");
    expect(triggerHelpEmbeddingWorker).toHaveBeenCalledOnce();
  });

  it("atomically deletes only an empty category", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "category-1" }] });
    expect(await deleteHelpCategory("category-1")).toEqual({ success: true });
    expect(dbHolder.current.calls.delete[0]).toBe(helpCategories);
    expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
      "category-1",
    );
  });

  it("refuses to orphan published articles and reports the exact count", async () => {
    dbHolder.current = makeDbMock({
      returning: [],
      selectQueue: [[{ n: 2 }]],
    });
    expect(await deleteHelpCategory("category-1")).toEqual({
      error:
        "This category still has 2 articles. Move them to another category (or delete them) first.",
    });
    expect(updateTag).not.toHaveBeenCalled();
  });

  it("treats an already-deleted empty category as idempotent success", async () => {
    dbHolder.current = makeDbMock({ returning: [], selectQueue: [[{ n: 0 }]] });
    expect(await deleteHelpCategory("category-1")).toEqual({ success: true });
  });

  it("persists category order", async () => {
    expect(await reorderHelpCategories(["one", "two"])).toEqual({
      success: true,
    });
    expect(dbHolder.current.calls.set).toEqual([
      { position: 0 },
      { position: 1 },
    ]);
  });
});

describe("help AI command", () => {
  it("requires an operator and a non-empty instruction", async () => {
    vi.mocked(getPlatformViewer).mockResolvedValue(null);
    expect(await runHelpAiCommand({ instruction: "draft" })).toEqual({
      error: "Not authorized.",
    });

    vi.mocked(getPlatformViewer).mockResolvedValue({ id: "operator-1" } as any);
    expect(await runHelpAiCommand({ instruction: " " })).toEqual({
      error: "Type what you'd like the AI to do.",
    });
  });

  it("returns one clarification question instead of inventing details", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      text: JSON.stringify({ action: "clarify", question: "Which feature?" }),
    });
    expect(await runHelpAiCommand({ instruction: "Write a guide" })).toEqual({
      success: true,
      data: { action: "clarify", question: "Which feature?" },
    });
  });

  it("sanitizes fenced AI HTML and trims metadata before returning it", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      text: `\`\`\`html\n${JSON.stringify({
        action: "apply",
        body: '<p>Guide</p><script>alert("x")</script>',
        excerpt: " Summary ",
        seoTitle: " Title ",
        seoDescription: " Description ",
      })}\n\`\`\``,
    });
    expect(await runHelpAiCommand({ instruction: "Write the guide" })).toEqual({
      success: true,
      data: {
        action: "apply",
        body: "<p>Guide</p>",
        excerpt: "Summary",
        seoTitle: "Title",
        seoDescription: "Description",
      },
    });
    expect(callGemini).toHaveBeenCalledWith(
      expect.stringContaining("OUTPUT CONTRACT"),
      expect.stringContaining('Instruction: "Write the guide"'),
      expect.objectContaining({ responseMimeType: "application/json" }),
    );
  });

  it("contains provider and malformed-output failures", async () => {
    vi.mocked(callGemini).mockResolvedValue({
      text: "",
      error: "quota exceeded",
    });
    expect(await runHelpAiCommand({ instruction: "draft" })).toEqual({
      error: "quota exceeded",
    });

    vi.mocked(callGemini).mockResolvedValue({ text: "not json" });
    expect(await runHelpAiCommand({ instruction: "draft" })).toEqual({
      error: "The AI returned an unexpected format. Try again.",
    });
  });
});
