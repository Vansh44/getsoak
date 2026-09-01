export const MINK_CAMPAIGN_MODES = ["send_now", "schedule"] as const;
export type MinkCampaignMode = (typeof MINK_CAMPAIGN_MODES)[number];

export const MINK_CAMPAIGN_AUDIENCE_MODES = ["all", "group"] as const;
export type MinkCampaignAudienceMode =
  (typeof MINK_CAMPAIGN_AUDIENCE_MODES)[number];

export const MIN_MINK_CAMPAIGN_SCHEDULE_LEAD_MS = 5 * 60 * 1_000;
export const MAX_MINK_CAMPAIGN_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_MINK_CAMPAIGN_RECIPIENTS = 10_000;

export type MinkCampaignTiming =
  | { mode: "send_now"; scheduledFor: null }
  | { mode: "schedule"; scheduledFor: string };

export type MinkCampaignAudienceSelection =
  | { mode: "all"; groupId: null }
  | { mode: "group"; groupId: string };

export class MinkCampaignPolicyError extends Error {}

export function normalizeMinkCampaignTiming(input: {
  mode: unknown;
  scheduledFor?: unknown;
  nowMs?: number;
}): MinkCampaignTiming {
  if (!MINK_CAMPAIGN_MODES.includes(input.mode as never)) {
    throw new MinkCampaignPolicyError("Choose Send now or Schedule for later.");
  }
  if (input.mode === "send_now") {
    if (input.scheduledFor !== undefined && input.scheduledFor !== null) {
      throw new MinkCampaignPolicyError(
        "Send now cannot include a scheduled time.",
      );
    }
    return { mode: "send_now", scheduledFor: null };
  }
  if (typeof input.scheduledFor !== "string") {
    throw new MinkCampaignPolicyError(
      "Choose a date and time for the scheduled campaign.",
    );
  }
  const value = input.scheduledFor.trim();
  if (
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value)
  ) {
    throw new MinkCampaignPolicyError(
      "The scheduled time must be a timezone-aware UTC instant.",
    );
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new MinkCampaignPolicyError(
      "The scheduled campaign time is invalid.",
    );
  }
  const nowMs = input.nowMs ?? Date.now();
  if (instant < nowMs + MIN_MINK_CAMPAIGN_SCHEDULE_LEAD_MS) {
    throw new MinkCampaignPolicyError(
      "Schedule the campaign at least 5 minutes from now.",
    );
  }
  if (instant > nowMs + MAX_MINK_CAMPAIGN_SCHEDULE_AHEAD_MS) {
    throw new MinkCampaignPolicyError(
      "Schedule the campaign no more than 30 days ahead.",
    );
  }
  return { mode: "schedule", scheduledFor: new Date(instant).toISOString() };
}

export function normalizeMinkCampaignAudience(input: {
  mode: unknown;
  groupId?: unknown;
}): MinkCampaignAudienceSelection {
  if (!MINK_CAMPAIGN_AUDIENCE_MODES.includes(input.mode as never)) {
    throw new MinkCampaignPolicyError(
      "Choose all customers or one customer group.",
    );
  }
  if (input.mode === "all") {
    if (input.groupId !== undefined && input.groupId !== null) {
      throw new MinkCampaignPolicyError(
        "The all-customers audience cannot include a group.",
      );
    }
    return { mode: "all", groupId: null };
  }
  if (
    typeof input.groupId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.groupId,
    )
  ) {
    throw new MinkCampaignPolicyError("Choose a valid customer group.");
  }
  return { mode: "group", groupId: input.groupId };
}
