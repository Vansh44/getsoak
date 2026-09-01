import { describe, expect, it } from "vitest";
import {
  finalizeMinkCampaignRecipients,
  normalizeMinkCampaignCandidates,
} from "./campaign-audience";

describe("Mink Phase 5E audience snapshots", () => {
  it("normalizes and deduplicates before suppression", () => {
    const normalized = normalizeMinkCampaignCandidates([
      { id: "1", email: " ADA@Example.COM ", firstName: " Ada " },
      { id: "2", email: "ada@example.com", firstName: "Duplicate" },
      { id: "3", email: "not-an-email", firstName: "Invalid" },
      { id: "4", email: null, firstName: "Missing" },
      { id: "5", email: "live@example.com", firstName: "Live" },
    ]);
    expect(normalized).toMatchObject({
      excludedNoEmail: 2,
      excludedDuplicate: 1,
      candidates: [
        { id: "1", email: "ada@example.com", firstName: "Ada" },
        { id: "5", email: "live@example.com", firstName: "Live" },
      ],
    });
    const result = finalizeMinkCampaignRecipients({
      candidates: normalized.candidates,
      suppressedEmails: ["ADA@EXAMPLE.COM"],
    });
    expect(result.eligible).toEqual([
      { id: "5", email: "live@example.com", firstName: "Live" },
    ]);
    expect(result.excludedSuppressed).toBe(1);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds recipient identity and personalization into the snapshot hash", () => {
    const candidate = [{ id: "1", email: "a@example.com", firstName: "Ada" }];
    const first = finalizeMinkCampaignRecipients({
      candidates: candidate,
      suppressedEmails: [],
    });
    const renamed = finalizeMinkCampaignRecipients({
      candidates: [{ ...candidate[0], firstName: "Grace" }],
      suppressedEmails: [],
    });
    expect(first.hash).not.toBe(renamed.hash);
  });
});
