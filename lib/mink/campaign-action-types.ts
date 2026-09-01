import type { MinkProductActionStatus } from "./product-action-types";

export type MinkCampaignValues = Record<string, string | null>;

export interface MinkCampaignSample {
  subject: string;
  html: string;
  recipientLabel: "Sample customer";
}

export interface MinkCampaignApproval {
  id: string;
  sourceApprovalId: null;
  toolName: "send_campaign";
  operation: "apply";
  status: MinkProductActionStatus;
  draftId: string;
  draftVersion: number;
  resource: {
    type: "campaign";
    id: string | null;
    label: string;
    dashboardPath: string;
  };
  before: MinkCampaignValues;
  after: MinkCampaignValues;
  sample: MinkCampaignSample | null;
  expiresAt: string;
  executedAt: string | null;
}

export interface MinkCampaignResult {
  approval: MinkCampaignApproval;
  auditId: string | null;
  repeated: boolean;
  campaign: {
    id: string;
    status: "pending" | "scheduled" | "sending" | "done";
    scheduledFor: string | null;
    recipientCount: number;
  };
}

export interface MinkCampaignExecutionResult extends MinkCampaignResult {
  /** Server-only worker hint; stripped by the route. */
  triggerWorker: boolean;
}

export interface MinkCampaignAudienceOption {
  id: string;
  label: string;
}

export interface MinkCampaignAudienceOptions {
  allLabel: string;
  groups: MinkCampaignAudienceOption[];
  maxRecipients: number;
}

export const MINK_CAMPAIGN_ACTION_FIELDS = [
  "delivery",
  "scheduled_for",
  "sender",
  "audience",
  "eligible_recipients",
  "excluded_no_email",
  "excluded_duplicate",
  "excluded_suppressed",
  "coupon",
  "offer",
  "valid_until",
  "subject",
  "body",
] as const;

export const MINK_CAMPAIGN_FIELD_LABELS: Record<string, string> = {
  delivery: "Delivery",
  scheduled_for: "Send at",
  sender: "Sender",
  audience: "Audience",
  eligible_recipients: "Eligible recipients",
  excluded_no_email: "Excluded: no/invalid email",
  excluded_duplicate: "Excluded: duplicate email",
  excluded_suppressed: "Excluded: suppressed",
  coupon: "Coupon",
  offer: "Offer",
  valid_until: "Coupon valid until",
  subject: "Subject",
  body: "Email body",
};
