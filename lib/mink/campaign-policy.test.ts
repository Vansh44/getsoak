import { describe, expect, it } from "vitest";
import {
  MAX_MINK_CAMPAIGN_SCHEDULE_AHEAD_MS,
  MIN_MINK_CAMPAIGN_SCHEDULE_LEAD_MS,
  normalizeMinkCampaignAudience,
  normalizeMinkCampaignTiming,
} from "./campaign-policy";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");

describe("Mink Phase 5E campaign policy", () => {
  it("normalizes immediate sends without timing input", () => {
    expect(
      normalizeMinkCampaignTiming({ mode: "send_now", nowMs: NOW }),
    ).toEqual({ mode: "send_now", scheduledFor: null });
  });

  it("accepts only canonical UTC schedules inside the bounded window", () => {
    const scheduledFor = new Date(
      NOW + MIN_MINK_CAMPAIGN_SCHEDULE_LEAD_MS,
    ).toISOString();
    expect(
      normalizeMinkCampaignTiming({
        mode: "schedule",
        scheduledFor,
        nowMs: NOW,
      }),
    ).toEqual({ mode: "schedule", scheduledFor });
    expect(() =>
      normalizeMinkCampaignTiming({
        mode: "schedule",
        scheduledFor: new Date(
          NOW + MAX_MINK_CAMPAIGN_SCHEDULE_AHEAD_MS + 1,
        ).toISOString(),
        nowMs: NOW,
      }),
    ).toThrow("no more than 30 days");
    expect(() =>
      normalizeMinkCampaignTiming({
        mode: "schedule",
        scheduledFor: "2026-09-01T12:00:00+05:30",
        nowMs: NOW,
      }),
    ).toThrow("UTC instant");
  });

  it("allows all customers or one exact group and rejects mixed scope", () => {
    expect(normalizeMinkCampaignAudience({ mode: "all" })).toEqual({
      mode: "all",
      groupId: null,
    });
    expect(
      normalizeMinkCampaignAudience({
        mode: "group",
        groupId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      mode: "group",
      groupId: "11111111-1111-4111-8111-111111111111",
    });
    expect(() =>
      normalizeMinkCampaignAudience({
        mode: "all",
        groupId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow("cannot include a group");
  });
});
