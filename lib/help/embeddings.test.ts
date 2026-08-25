import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const authMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: authMocks.getAccessToken };
    }
  },
}));

import {
  DEFAULT_HELP_EMBEDDING_MODEL,
  embedHelpDocuments,
  embedHelpQuery,
  HELP_EMBEDDING_DIMENSIONS,
} from "./embeddings";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "GEMINI_EMBEDDING_MODEL",
  "GCP_PROJECT_ID",
  "GCP_LOCATION",
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

function vector(first = 3, second = 4): number[] {
  const values = Array<number>(HELP_EMBEDDING_DIMENSIONS).fill(0);
  values[0] = first;
  values[1] = second;
  return values;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
  authMocks.getAccessToken.mockResolvedValue({ token: "adc-token" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(restoreEnvironment);

describe("Help Centre embeddings", () => {
  it("embeds a retrieval query through the Gemini API with a fixed 768 dimensions", async () => {
    process.env.GEMINI_API_KEY = "developer-key";
    // Match the shared Gemini convention: an API key wins even when Vertex is
    // also configured.
    process.env.GCP_PROJECT_ID = "storemink-prod";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ embedding: { values: vector() } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedHelpQuery("How do I process a POS sale?");

    expect(result).toMatchObject({
      ok: true,
      backend: "gemini-api",
      model: DEFAULT_HELP_EMBEDDING_MODEL,
      dimensions: 768,
    });
    if (!result.ok) throw new Error("Expected an embedding");
    expect(result.value).toHaveLength(768);
    // Reduced gemini-embedding-001 vectors are normalized before storage/use.
    expect(result.value[0]).toBeCloseTo(0.6);
    expect(result.value[1]).toBeCloseTo(0.8);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent",
    );
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-goog-api-key": "developer-key",
    });
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "How do I process a POS sale?" }] },
      embedContentConfig: {
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: 768,
        autoTruncate: false,
      },
    });
    expect(authMocks.getAccessToken).not.toHaveBeenCalled();
  });

  it("batches retrieval-document embeddings and preserves input order and titles", async () => {
    process.env.GEMINI_API_KEY = "developer-key";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        embeddings: [{ values: vector(1, 0) }, { values: vector(0, 2) }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedHelpDocuments([
      { title: "Process an in-store sale", text: "Open Sell and add items." },
      { title: "Take payments", text: "Select Take payment." },
    ]);

    expect(result).toMatchObject({ ok: true, backend: "gemini-api" });
    if (!result.ok) throw new Error("Expected document embeddings");
    expect(result.value).toHaveLength(2);
    expect(result.value[0][0]).toBe(1);
    expect(result.value[1][1]).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(":batchEmbedContents");
    const body = JSON.parse(String(init.body));
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toEqual({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "Open Sell and add items." }] },
      embedContentConfig: {
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: 768,
        autoTruncate: false,
        title: "Process an in-store sale",
      },
    });
    expect(body.requests[1].embedContentConfig).toMatchObject({
      taskType: "RETRIEVAL_DOCUMENT",
      title: "Take payments",
    });
  });

  it("uses ADC and Vertex prediction requests when no Gemini API key is set", async () => {
    process.env.GCP_PROJECT_ID = "storemink-prod";
    process.env.GCP_LOCATION = "asia-south1";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const first = body.instances[0].title === "First" ? 1 : 0;
      return jsonResponse({
        predictions: [
          {
            embeddings: {
              values: vector(first, first ? 0 : 1),
              statistics: { truncated: false, token_count: 5 },
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedHelpDocuments([
      { title: "First", text: "First document" },
      { title: "Second", text: "Second document" },
    ]);

    expect(result).toMatchObject({
      ok: true,
      backend: "vertex-ai",
      dimensions: 768,
    });
    if (!result.ok) throw new Error("Expected document embeddings");
    expect(result.value[0][0]).toBe(1);
    expect(result.value[1][1]).toBe(1);
    expect(authMocks.getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [url, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(url).toBe(
        "https://asia-south1-aiplatform.googleapis.com/v1/projects/storemink-prod/locations/asia-south1/publishers/google/models/gemini-embedding-001:predict",
      );
      expect(init.headers).toMatchObject({
        Authorization: "Bearer adc-token",
      });
      const body = JSON.parse(String(init.body));
      expect(body.instances).toHaveLength(1);
      expect(body.instances[0]).toMatchObject({
        task_type: "RETRIEVAL_DOCUMENT",
      });
      expect(body.parameters).toEqual({
        autoTruncate: false,
        outputDimensionality: 768,
      });
    }
  });

  it("fails soft when embeddings are not configured or input is invalid", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(embedHelpQuery("valid query")).resolves.toMatchObject({
      ok: false,
      error: { code: "not-configured", retryable: false },
    });
    await expect(embedHelpQuery("   ")).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid-input", retryable: false },
    });
    await expect(embedHelpDocuments([])).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid-input", retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects wrong dimensions, truncated vectors, and incomplete batches", async () => {
    process.env.GEMINI_API_KEY = "developer-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ embedding: { values: vector().slice(1) } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          embedding: {
            values: vector(),
            statistics: { truncated: true },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ embeddings: [{ values: vector() }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    for (const query of ["first", "second"]) {
      await expect(embedHelpQuery(query)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid-response", retryable: true },
      });
    }
    await expect(
      embedHelpDocuments([
        { title: "One", text: "First document" },
        { title: "Two", text: "Second document" },
      ]),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid-response", retryable: true },
    });
  });

  it("maps timeouts and provider throttling to typed retryable failures", async () => {
    process.env.GEMINI_API_KEY = "developer-key";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(jsonResponse({ error: "quota" }, 429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(embedHelpQuery("timeout query")).resolves.toEqual({
      ok: false,
      error: {
        code: "timeout",
        message: "The embedding request timed out.",
        retryable: true,
      },
    });
    await expect(embedHelpQuery("rate-limited query")).resolves.toMatchObject({
      ok: false,
      error: { code: "rate-limited", retryable: true, status: 429 },
    });
  });
});
