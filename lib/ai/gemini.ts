// Shared Gemini access for every AI copy feature (product descriptions, SEO,
// coupon emails, brand-voice setup). Plain server module — NOT a "use server"
// file — so it can export sync helpers, constants and types alongside the call.
//
// The brand "soul" is PER-STORE data — lib/ai/brand-voice.ts
// (store_brand_profiles); it replaced an earlier file-based loader.
//
// TWO BACKENDS (GCP migration, Phase 1 — see docs/gcp-migration-phase5-6.md):
//   * Vertex AI  — used when GCP_PROJECT_ID is set. Auth via Application Default
//     Credentials (ADC): a service-account bearer token, no API key. This is the
//     GCP-native path (automatic on Cloud Run; local dev uses
//     `gcloud auth application-default login` or GOOGLE_APPLICATION_CREDENTIALS).
//   * Gemini Developer API — the fallback when GCP_PROJECT_ID is unset. Auth via
//     the GEMINI_API_KEY header. This keeps the app working before/without GCP.
// The request body and response shape are identical across both, so only the
// URL + auth header differ. Callers see the same {text,error} contract either way.

import { logInfo, logWarn, logError } from "@/lib/observability/logger";

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Mint a Google Cloud access token from Application Default Credentials for the
// Vertex AI call. Lazily imported so the Developer-API path (and edge bundles)
// never load the Node-only auth library. Returns null if credentials can't be
// resolved (unconfigured ADC), letting the caller surface a friendly error.
async function getVertexAccessToken(): Promise<string | null> {
  try {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      scopes: "https://www.googleapis.com/auth/cloud-platform",
    });
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    return token ?? null;
  } catch (err) {
    console.error("Vertex AI ADC token error:", err);
    return null;
  }
}

// The brand soul becomes Gemini's system instruction — its persistent identity.
export function brandSystemText(brand: string): string {
  return `${brand}

The text above is the brand's soul — its voice, tone, values and vocabulary. You ARE this brand speaking. Everything you write must sound exactly like it.`;
}

export interface GeminiOptions {
  temperature?: number;
  maxOutputTokens?: number;
  // Set both to make Gemini return validated JSON instead of free text.
  responseMimeType?: string;
  responseSchema?: unknown;
}

/**
 * One shared call into Gemini: builds the request, retries transient 5xx /
 * network failures with a short backoff, and returns the raw text (or a
 * friendly error). Routes through Vertex AI when GCP_PROJECT_ID is set, else the
 * Gemini Developer API. Credentials are read here and never leave the server.
 */
export async function callGemini(
  systemText: string,
  userText: string,
  options: GeminiOptions = {},
): Promise<{ text?: string; error?: string }> {
  const startedAt = Date.now();
  // Resolve the backend at call time (so env stubbing / hot config works).
  //
  // Backend precedence: the FREE Gemini Developer API key wins whenever one is
  // set — local + staging set GEMINI_API_KEY so their AI costs nothing — and we
  // fall back to Vertex AI (via ADC, GCP_PROJECT_ID) only when no key is
  // present. Production therefore omits GEMINI_API_KEY and sets GCP_PROJECT_ID
  // to route through Vertex. (An env that sets BOTH prefers the free key.)
  const projectId = process.env.GCP_PROJECT_ID;
  const hasApiKey = Boolean(process.env.GEMINI_API_KEY);
  const useVertex = Boolean(projectId) && !hasApiKey;
  const backend = useVertex ? "vertex" : "developer";

  let url: string;
  let authHeaders: Record<string, string>;
  // Message shown on a 400/403 — the likely cause differs by backend.
  const rejectionError = useVertex
    ? "AI request rejected by Vertex AI — check the project has the Vertex AI API enabled and the credentials hold the 'Vertex AI User' role."
    : "AI request rejected — check that GEMINI_API_KEY is valid.";

  if (useVertex) {
    // Vertex AI: OAuth bearer token from ADC; project- and location-scoped URL.
    // "global" uses the location-agnostic host; a region uses its regional host.
    const location = process.env.GCP_LOCATION || "global";
    const token = await getVertexAccessToken();
    if (!token)
      return {
        error:
          "Could not obtain Google Cloud credentials. Configure Application Default Credentials (ADC) for Vertex AI.",
      };
    const host =
      location === "global"
        ? "aiplatform.googleapis.com"
        : `${location}-aiplatform.googleapis.com`;
    url = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
    authHeaders = { Authorization: `Bearer ${token}` };
  } else {
    // Gemini Developer API: API-key header.
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { error: "GEMINI_API_KEY is not set in .env.local." };
    url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    authHeaders = { "x-goog-api-key": apiKey };
  }

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxOutputTokens ?? 1024,
      thinkingConfig: { thinkingBudget: 0 },
      ...(options.responseMimeType
        ? { responseMimeType: options.responseMimeType }
        : {}),
      ...(options.responseSchema
        ? { responseSchema: options.responseSchema }
        : {}),
    },
  });

  // Gemini intermittently returns a transient 500 (INTERNAL) or 503
  // (UNAVAILABLE); its docs say to retry. Try a few times with a short backoff.
  // Bail immediately on permanent client errors (400/403).
  const MAX_ATTEMPTS = 3;
  let res: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: requestBody,
        cache: "no-store",
      });
    } catch (err) {
      logWarn("ai.generate: network error (will retry)", {
        backend,
        model: GEMINI_MODEL,
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        error: err instanceof Error ? err.message : String(err),
      });
      res = null;
    }

    if (res?.ok) break;
    // Don't retry permanent client errors — bad request, auth, missing model,
    // or a hard quota cap (retrying just adds latency before the same failure).
    if (
      res &&
      (res.status === 400 ||
        res.status === 401 ||
        res.status === 403 ||
        res.status === 404 ||
        res.status === 429)
    )
      break;
    if (attempt < MAX_ATTEMPTS)
      await new Promise((r) => setTimeout(r, 600 * attempt));
  }

  if (!res) {
    logError("ai.generate: unreachable after retries", undefined, {
      backend,
      model: GEMINI_MODEL,
      ms: Date.now() - startedAt,
    });
    return {
      error:
        "Could not reach the AI service. Check your connection and try again.",
    };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    logWarn("ai.generate: non-OK response", {
      backend,
      model: GEMINI_MODEL,
      status: res.status,
      ms: Date.now() - startedAt,
      detail: errBody.slice(0, 500),
    });
    if (res.status === 400 || res.status === 403)
      return {
        error: rejectionError,
      };
    if (res.status === 401)
      return {
        error: useVertex
          ? "AI request unauthorized — the Vertex AI credentials are invalid or expired."
          : "AI request unauthorized — GEMINI_API_KEY is invalid or missing. Create one at https://aistudio.google.com/apikey.",
      };
    if (res.status === 404)
      return {
        error: `The AI model "${GEMINI_MODEL}" isn't available to these credentials. Set GEMINI_MODEL to a supported model (e.g. gemini-2.0-flash).`,
      };
    if (res.status === 429)
      return {
        error: useVertex
          ? "AI quota exceeded on Vertex AI — check the project's quota."
          : "AI quota exceeded — this GEMINI_API_KEY's project has no remaining Gemini quota. Enable billing on the key's Google Cloud project, or use a key that has quota.",
      };
    if (res.status >= 500)
      return {
        error:
          "The AI service is busy right now. Please try again in a moment.",
      };
    return { error: `AI request failed (${res.status}). Try again.` };
  }

  const json = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  } | null;

  const text = json?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("")
    .trim();

  if (!text) {
    logWarn("ai.generate: empty response", {
      backend,
      model: GEMINI_MODEL,
      ms: Date.now() - startedAt,
    });
    return { error: "The AI returned an empty response. Try again." };
  }

  // Success — record latency + token usage. On GCP this lands in Cloud Logging;
  // a log-based metric can then chart token spend over time (credit tracking).
  const usage = json?.usageMetadata;
  logInfo("ai.generate: ok", {
    backend,
    model: GEMINI_MODEL,
    ms: Date.now() - startedAt,
    promptTokens: usage?.promptTokenCount,
    outputTokens: usage?.candidatesTokenCount,
    totalTokens: usage?.totalTokenCount,
  });
  return { text };
}
