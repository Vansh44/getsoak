import "server-only";

export interface MinkConfig {
  enabled: boolean;
  projectId: string | null;
  location: string;
  model: string;
  maxSteps: number;
  maxToolCalls: number;
  maxParallelReadTools: number;
  maxOutputTokens: number;
}

function enabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    return fallback;
  return parsed;
}

/** Read at request time so Cloud Run revisions and tests can change config safely. */
export function getMinkConfig(): MinkConfig {
  return {
    // Fail closed: merely configuring a model must not expose an unfinished
    // merchant feature. An operator must explicitly enable the runtime.
    enabled: enabled(process.env.MINK_AI_ENABLED),
    projectId: process.env.GCP_PROJECT_ID?.trim() || null,
    location:
      process.env.MINK_VERTEX_LOCATION?.trim() ||
      process.env.GCP_LOCATION?.trim() ||
      "global",
    model: process.env.MINK_VERTEX_MODEL?.trim() || "gemini-3.7-flash",
    maxSteps: boundedInt(process.env.MINK_MAX_STEPS_PER_RUN, 8, 1, 20),
    maxToolCalls: boundedInt(
      process.env.MINK_MAX_TOOL_CALLS_PER_RUN,
      16,
      1,
      40,
    ),
    maxParallelReadTools: boundedInt(
      process.env.MINK_MAX_PARALLEL_READ_TOOLS,
      4,
      1,
      8,
    ),
    maxOutputTokens: boundedInt(
      process.env.MINK_MAX_OUTPUT_TOKENS,
      2_048,
      256,
      8_192,
    ),
  };
}
