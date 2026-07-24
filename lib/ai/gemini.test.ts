/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { GEMINI_MODEL, brandSystemText, callGemini } from "./gemini";

// Mock ADC token minting so the Vertex AI path can be tested without real
// Google Cloud credentials. Only the token fn is a vi.fn (re-armed per test);
// GoogleAuth is a plain class so it survives the other suites' restoreAllMocks.
const { mockGetAccessToken } = vi.hoisted(() => ({
  mockGetAccessToken: vi.fn(async () => ({ token: "vertex-token" })),
}));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getClient() {
      return Promise.resolve({ getAccessToken: mockGetAccessToken });
    }
  },
}));

// Build a minimal fake fetch Response.
function fakeResponse({
  ok,
  status,
  json,
  text,
}: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
}): Response {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text ?? "",
  } as unknown as Response;
}

// A canonical successful Gemini payload.
const okJson = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
});

// loadBrandSoul (the file-based brand.md reader) moved to per-store data —
// lib/ai/brand-voice.ts owns that path now, with its own tests.

describe("brandSystemText", () => {
  it("embeds the brand text and appends the brand's soul instruction", () => {
    const brand = "We are WholeSip.";
    const out = brandSystemText(brand);
    expect(out).toContain(brand);
    expect(out).toContain("The text above is the brand's soul");
    expect(out).toContain("You ARE this brand speaking.");
    // Brand text comes first, instruction after.
    expect(out.indexOf(brand)).toBeLessThan(out.indexOf("brand's soul"));
  });
});

describe("GEMINI_MODEL", () => {
  it("is a non-empty model id string", () => {
    expect(typeof GEMINI_MODEL).toBe("string");
    expect(GEMINI_MODEL.length).toBeGreaterThan(0);
  });
});

describe("callGemini", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    // Pin this suite to the Gemini Developer API path (no GCP project) so the
    // x-goog-api-key assertions are deterministic regardless of local .env.
    vi.stubEnv("GCP_PROJECT_ID", "");
    // Silence the logger's structured output (info/warn/error) during tests.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("errors when GEMINI_API_KEY is not set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const result = await callGemini("sys", "user");
    expect(result.error).toBe("GEMINI_API_KEY is not set in .env.local.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns trimmed text on a successful response and builds the request correctly", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: true, status: 200, json: okJson("  hello  ") }),
    );

    const result = await callGemini("system prompt", "user prompt");
    expect(result).toEqual({ text: "hello" });
    expect(fetch).toHaveBeenCalledTimes(1);

    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toContain(GEMINI_MODEL);
    expect(url).toContain("generateContent");
    expect(init.method).toBe("POST");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.systemInstruction.parts[0].text).toBe("system prompt");
    expect(body.contents[0].role).toBe("user");
    expect(body.contents[0].parts[0].text).toBe("user prompt");
    expect(body.generationConfig.temperature).toBe(0.7);
    expect(body.generationConfig.maxOutputTokens).toBe(1024);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    // No JSON-mode options unless requested.
    expect(body.generationConfig.responseMimeType).toBeUndefined();
    expect(body.generationConfig.responseSchema).toBeUndefined();
  });

  it("honors temperature and maxOutputTokens overrides", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: true, status: 200, json: okJson("ok") }),
    );

    await callGemini("s", "u", { temperature: 0.2, maxOutputTokens: 256 });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.generationConfig.temperature).toBe(0.2);
    expect(body.generationConfig.maxOutputTokens).toBe(256);
  });

  it("includes responseMimeType and responseSchema in generationConfig when provided", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: true, status: 200, json: okJson("ok") }),
    );

    const schema = { type: "object", properties: { name: { type: "string" } } };
    await callGemini("s", "u", {
      responseMimeType: "application/json",
      responseSchema: schema,
    });

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual(schema);
  });

  it("concatenates multiple parts of the candidate response", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({
        ok: true,
        status: 200,
        json: {
          candidates: [
            { content: { parts: [{ text: "foo" }, { text: "bar" }] } },
          ],
        },
      }),
    );
    const result = await callGemini("s", "u");
    expect(result).toEqual({ text: "foobar" });
  });

  it("bails immediately on a 400 and returns the rejection error", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: false, status: 400, text: "bad request" }),
    );

    const result = await callGemini("s", "u");
    expect(result.error).toBe(
      "AI request rejected — check that GEMINI_API_KEY is valid.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bails immediately on a 403 and returns the rejection error", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: false, status: 403, text: "forbidden" }),
    );

    const result = await callGemini("s", "u");
    expect(result.error).toBe(
      "AI request rejected — check that GEMINI_API_KEY is valid.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bails immediately on a 404 with a model-specific message", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: false, status: 404, text: "not found" }),
    );

    const result = await callGemini("s", "u");
    expect(result.error).toContain("isn't available");
    expect(result.error).toContain("GEMINI_MODEL");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bails immediately on a 429 with a quota message", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: false, status: 429, text: "quota" }),
    );

    const result = await callGemini("s", "u");
    expect(result.error).toContain("quota exceeded");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bails immediately on a 401 with an invalid-key message", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: false, status: 401, text: "unauthorized" }),
    );

    const result = await callGemini("s", "u");
    expect(result.error).toContain("GEMINI_API_KEY");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries 500s up to MAX_ATTEMPTS then returns the busy error", async () => {
    vi.useFakeTimers();
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: false, status: 500, text: "internal" }),
    );

    const promise = callGemini("s", "u");
    // Advance through the two backoff sleeps (600ms, then 1200ms).
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1200);

    const result = await promise;
    expect(result.error).toBe(
      "The AI service is busy right now. Please try again in a moment.",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("succeeds after a transient 500 on the first attempt", async () => {
    vi.useFakeTimers();
    (fetch as any)
      .mockResolvedValueOnce(
        fakeResponse({ ok: false, status: 503, text: "unavailable" }),
      )
      .mockResolvedValueOnce(
        fakeResponse({ ok: true, status: 200, json: okJson("recovered") }),
      );

    const promise = callGemini("s", "u");
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result).toEqual({ text: "recovered" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns the unreachable error when fetch rejects on every attempt", async () => {
    vi.useFakeTimers();
    (fetch as any).mockRejectedValue(new Error("network down"));

    const promise = callGemini("s", "u");
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(1200);

    const result = await promise;
    expect(result.error).toBe(
      "Could not reach the AI service. Check your connection and try again.",
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns the empty-response error when candidates are missing", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: true, status: 200, json: {} }),
    );

    const result = await callGemini("s", "u");
    expect(result.error).toBe("The AI returned an empty response. Try again.");
  });

  it("returns the empty-response error when the text is blank", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: true, status: 200, json: okJson("   ") }),
    );

    const result = await callGemini("s", "u");
    expect(result.error).toBe("The AI returned an empty response. Try again.");
  });

  it("returns the empty-response error when json parsing yields null", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("invalid json");
      },
      text: async () => "",
    } as unknown as Response);

    const result = await callGemini("s", "u");
    expect(result.error).toBe("The AI returned an empty response. Try again.");
  });
});

describe("callGemini (Vertex AI backend)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    // A configured GCP project switches the backend to Vertex AI.
    vi.stubEnv("GCP_PROJECT_ID", "my-project");
    // Empty location -> defaults to the "global" host; empty API key proves the
    // Vertex path does NOT fall back to the Developer API.
    vi.stubEnv("GCP_LOCATION", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    mockGetAccessToken.mockReset();
    mockGetAccessToken.mockResolvedValue({ token: "vertex-token" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("routes to the regional Vertex endpoint with a bearer token", async () => {
    vi.stubEnv("GCP_LOCATION", "us-central1");
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: true, status: 200, json: okJson("hi") }),
    );

    const result = await callGemini("sys", "user");
    expect(result).toEqual({ text: "hi" });

    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe(
      `https://us-central1-aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/${GEMINI_MODEL}:generateContent`,
    );
    expect(init.headers.Authorization).toBe("Bearer vertex-token");
    expect(init.headers["x-goog-api-key"]).toBeUndefined();
    // Request body is identical to the Developer API path.
    const body = JSON.parse(init.body);
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(body.contents[0].parts[0].text).toBe("user");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("uses the global host when GCP_LOCATION is unset", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: true, status: 200, json: okJson("ok") }),
    );

    await callGemini("s", "u");
    const [url] = (fetch as any).mock.calls[0];
    expect(url).toBe(
      `https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/google/models/${GEMINI_MODEL}:generateContent`,
    );
  });

  it("errors (without calling fetch) when ADC credentials can't be resolved", async () => {
    mockGetAccessToken.mockRejectedValue(new Error("no ADC"));
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: true, status: 200, json: okJson("x") }),
    );

    const result = await callGemini("s", "u");
    expect(result.error).toContain("Could not obtain Google Cloud credentials");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the Vertex-specific rejection message on a 403", async () => {
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: false, status: 403, text: "denied" }),
    );

    const result = await callGemini("s", "u");
    expect(result.error).toContain("Vertex AI User");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("prefers the free Developer API key when BOTH it and GCP_PROJECT_ID are set", async () => {
    // The precedence rule: local + staging set GEMINI_API_KEY (free) even
    // though a GCP project may exist for other services — the key wins, so
    // Vertex/ADC is never consulted.
    vi.stubEnv("GEMINI_API_KEY", "free-key");
    vi.stubEnv("GCP_PROJECT_ID", "my-project");
    (fetch as any).mockResolvedValue(
      fakeResponse({ ok: true, status: 200, json: okJson("hi") }),
    );

    const result = await callGemini("sys", "user");
    expect(result).toEqual({ text: "hi" });

    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(init.headers["x-goog-api-key"]).toBe("free-key");
    expect(init.headers.Authorization).toBeUndefined();
    expect(mockGetAccessToken).not.toHaveBeenCalled();
  });
});
