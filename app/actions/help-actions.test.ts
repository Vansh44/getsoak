/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

const dbHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
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
vi.mock("@/lib/seo/search-engines", () => ({
  pingIndexNow: vi.fn(async () => {}),
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
}));

import { revalidateTag } from "next/cache";
import { getServerUser } from "@/lib/auth/server-user";
import { getPlatformViewer } from "@/app/actions/platform";
import {
  deleteStorageUrls,
  extractMediaUrlsFromHtml,
} from "@/lib/storage/cleanup";
import { callGemini } from "@/lib/ai/gemini";
import { pingIndexNow } from "@/lib/seo/search-engines";
import { rateLimit } from "@/lib/rate-limit";
import { getHelpCategories, searchHelpArticles } from "@/lib/help/queries";
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
  body: '<p>Safe</p><script>alert("x")</script>',
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
  body: '<p>Old</p><img src="https://storage.test/old.webp">',
  status: "draft",
  position: 0,
  viewCount: 10,
  helpfulYes: 2,
  helpfulNo: 1,
  seoTitle: "Custom domains",
  seoDescription: "Learn how.",
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
    expect(revalidateTag).not.toHaveBeenCalled();
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
    expect((await getHelpArticleForEditor("article-1"))?.body).toContain("Old");

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
      body: "<p>Safe</p>",
      status: "published",
      slug: "connect-domain",
      createdBy: "operator-1",
      updatedBy: "operator-1",
    });
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
      body: "<p>New body</p>",
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
    await vi.waitFor(() =>
      expect(pingIndexNow).toHaveBeenCalledWith([
        "https://help.storemink.com/help/domains/connect-domain",
        "https://help.storemink.com/help/domains",
        "https://help.storemink.com/help",
      ]),
    );
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
    expect(revalidateTag).toHaveBeenCalledTimes(1);
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
    expect(revalidateTag).not.toHaveBeenCalled();
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
