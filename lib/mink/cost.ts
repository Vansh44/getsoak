import type { MinkUsage } from "./types";

export interface MinkCostEstimate {
  estimatedCostMicrousd: number | null;
  pricingVersion: string | null;
}

/**
 * Shadow-cost one run using the public on-demand token price in effect when it
 * ran. A null estimate is deliberate: an unknown model must not be presented
 * to operators as free.
 */
export function estimateMinkCost(input: {
  model: string;
  location: string;
  usage: MinkUsage;
  at?: Date;
}): MinkCostEstimate {
  if (!isGemini37Flash(input.model)) {
    return { estimatedCostMicrousd: null, pricingVersion: null };
  }

  const global = input.location.trim().toLowerCase() === "global";
  const intro = (input.at ?? new Date()) < new Date("2027-01-01T00:00:00Z");
  const inputRate = intro ? (global ? 0.75 : 0.825) : global ? 1.5 : 1.65;
  const outputRate = intro ? (global ? 3.75 : 4.125) : global ? 7.5 : 8.25;
  // The provider prices visible response and reasoning as text output. The SDK
  // reports candidate and thought tokens separately, so both are billable here.
  const outputTokens = input.usage.outputTokens + input.usage.thoughtTokens;
  return {
    // A USD-per-million-token rate is numerically equal to micro-USD per token.
    estimatedCostMicrousd: Math.max(
      0,
      Math.round(
        input.usage.promptTokens * inputRate + outputTokens * outputRate,
      ),
    ),
    pricingVersion: `gemini-3.7-flash-${global ? "global" : "regional"}-${intro ? "2026-intro" : "2027-standard"}`,
  };
}

function isGemini37Flash(model: string): boolean {
  const leaf = model.trim().toLowerCase().split("/").at(-1) ?? "";
  return leaf === "gemini-3.7-flash";
}
