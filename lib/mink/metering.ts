export type MinkCostCohort =
  | "read_lookup"
  | "read_analysis"
  | "read_failed"
  | "read_unknown";

export function minkShadowMeter(input: {
  status: "succeeded" | "failed" | "cancelled";
  toolCalls: number;
  usageKnown: boolean;
}): { shadowCredits: number; costCohort: MinkCostCohort } {
  if (!input.usageKnown) {
    return { shadowCredits: 0, costCohort: "read_unknown" };
  }
  if (input.status !== "succeeded") {
    return { shadowCredits: 3, costCohort: "read_failed" };
  }
  return input.toolCalls <= 1
    ? { shadowCredits: 3, costCohort: "read_lookup" }
    : { shadowCredits: 3, costCohort: "read_analysis" };
}
