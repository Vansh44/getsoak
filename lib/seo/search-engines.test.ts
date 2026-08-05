import { afterEach, describe, it, expect, vi } from "vitest";
import {
  indexNowPayload,
  googleSitemapEndpoint,
  INDEXNOW_KEY,
  pingIndexNow,
} from "./search-engines";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("indexNowPayload", () => {
  it("declares host + keyLocation and carries the urlList", () => {
    const payload = indexNowPayload("acme.storemink.com", [
      "https://acme.storemink.com/shop/tomatoes",
    ]);
    expect(payload).toEqual({
      host: "acme.storemink.com",
      key: INDEXNOW_KEY,
      keyLocation: `https://acme.storemink.com/${INDEXNOW_KEY}.txt`,
      urlList: ["https://acme.storemink.com/shop/tomatoes"],
    });
  });
});

describe("pingIndexNow", () => {
  it("submits one payload per host instead of dropping later hosts", async () => {
    const fetchMock = vi.fn(
      async (...args: [string | URL | Request, RequestInit?]) => {
        void args;
        return new Response(null, { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await pingIndexNow([
      "https://acme.storemink.com/shop/a",
      "https://acme.storemink.com/shop/b",
      "https://other.example/blogs/c",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: "acme.storemink.com",
          urlList: [
            "https://acme.storemink.com/shop/a",
            "https://acme.storemink.com/shop/b",
          ],
        }),
        expect.objectContaining({
          host: "other.example",
          urlList: ["https://other.example/blogs/c"],
        }),
      ]),
    );
  });
});

describe("googleSitemapEndpoint", () => {
  it("encodes the property and the sitemap URL into the submit path", () => {
    const endpoint = googleSitemapEndpoint(
      "sc-domain:storemink.com",
      "https://acme.storemink.com/sitemap.xml",
    );
    expect(endpoint).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/" +
        encodeURIComponent("sc-domain:storemink.com") +
        "/sitemaps/" +
        encodeURIComponent("https://acme.storemink.com/sitemap.xml"),
    );
    // The `:` and `/` must be percent-encoded so they don't break the path.
    expect(endpoint).toContain("sc-domain%3Astoremink.com");
    expect(endpoint).toContain(
      "https%3A%2F%2Facme.storemink.com%2Fsitemap.xml",
    );
  });
});
