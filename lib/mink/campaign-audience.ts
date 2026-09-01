import { normalizeEmail } from "@/lib/email/suppression";
import { hashMinkActionPayload } from "./action-integrity";

export type MinkCampaignRecipient = {
  id: string;
  email: string;
  firstName: string;
};

export function normalizeMinkCampaignCandidates(
  rows: Array<{ id: string; email: string | null; firstName: string }>,
) {
  let excludedNoEmail = 0;
  let excludedDuplicate = 0;
  const seenEmails = new Set<string>();
  const candidates: MinkCampaignRecipient[] = [];
  for (const row of rows) {
    const email = normalizeEmail(row.email ?? "");
    if (!isSafeCampaignEmail(email)) {
      excludedNoEmail += 1;
      continue;
    }
    if (seenEmails.has(email)) {
      excludedDuplicate += 1;
      continue;
    }
    seenEmails.add(email);
    candidates.push({
      id: row.id,
      email,
      firstName: row.firstName.trim().slice(0, 100),
    });
  }
  return { candidates, excludedNoEmail, excludedDuplicate };
}

export function finalizeMinkCampaignRecipients(input: {
  candidates: MinkCampaignRecipient[];
  suppressedEmails: string[];
}) {
  const suppressed = new Set(input.suppressedEmails.map(normalizeEmail));
  const eligible = input.candidates.filter(
    (recipient) => !suppressed.has(recipient.email),
  );
  return {
    eligible,
    excludedSuppressed: input.candidates.length - eligible.length,
    hash: hashMinkActionPayload(
      eligible.map((recipient) => [
        recipient.id,
        recipient.email,
        recipient.firstName,
      ]),
    ),
  };
}

function isSafeCampaignEmail(value: string) {
  return (
    value.length <= 320 &&
    !/[\r\n]/.test(value) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}
