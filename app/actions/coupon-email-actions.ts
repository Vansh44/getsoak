"use server";

import { after } from "next/server";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
} from "drizzle-orm";
import { withService } from "@/lib/db/client";
import {
  emailCampaignRecipients,
  emailCampaigns,
  userGroupMembers,
  users,
} from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { callGemini, brandSystemText } from "@/lib/ai/gemini";
import { getBrandSoulForStore } from "@/lib/ai/brand-voice";
import { consumeAiQuota } from "@/lib/ai/quota";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import { emailConfigured } from "@/lib/email/send";
import {
  mergeTokens,
  renderCouponEmail,
  type CouponEmailContent,
} from "@/lib/email/coupon-campaign";
import { getStoreBrand } from "@/lib/store/brand";
import { storeAllowsPlanFeature } from "@/lib/plans/entitlements";

const CAMPAIGN_PLAN_ERROR =
  "Coupon email campaigns are available on Pro. Existing campaign history remains safe until you upgrade.";

const RECIPIENT_PAGE_SIZE = 50;

// Trim the search term (parameterised — no escaping needed).
function sanitizeSearch(q: string): string {
  return q.trim().slice(0, 100);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmailAudience =
  | { mode: "all" }
  | { mode: "group"; groupId: string }
  | { mode: "specific"; customerIds: string[] };

export interface RecipientOption {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string;
}

export interface GenerateEmailInput {
  code: string;
  description?: string | null;
  discountLabel: string; // e.g. "25% off" / "₹100 off"
  validUntilLabel?: string | null;
  audienceLabel: string; // e.g. "VIP shoppers" — helps the AI set the tone
  instructions?: string; // optional extra steer from the admin
}

export interface GenerateEmailResult {
  subject?: string;
  body?: string;
  error?: string;
}

export interface SendEmailInput {
  subject: string;
  body: string;
  code: string;
  discountLabel: string;
  validUntilLabel?: string | null;
  audience: EmailAudience;
}

export interface SendEmailResult {
  /** Recipients (with an email) queued for background sending. */
  queued?: number;
  skippedNoEmail?: number;
  error?: string;
}

export interface ListRecipientsResult {
  customers: RecipientOption[];
  /** Total customers with an email on file (for the "all" audience count). */
  total: number;
  error?: string;
}

// Aliased select preserving the RecipientOption snake_case shape.
const RECIPIENT_COLUMNS = {
  id: users.id,
  first_name: users.firstName,
  last_name: users.lastName,
  email: users.email,
  phone: users.phone,
};

function toRecipient(c: {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
}): RecipientOption {
  return {
    id: c.id,
    first_name: c.first_name ?? "",
    last_name: c.last_name ?? null,
    email: c.email ?? null,
    phone: c.phone ?? "",
  };
}

// ---------------------------------------------------------------------------
// Recipients — searched server-side by the email dialog's "specific" picker.
// Returns at most RECIPIENT_PAGE_SIZE matches so it stays fast with 100k+
// customers (never loads the whole table into the browser).
//
// Every `users` read is scoped to the acting store (CODEBASE.md §5.1): a store
// admin must only ever see / mail their OWN store's customers.
// ---------------------------------------------------------------------------

export async function listEmailRecipients(
  search = "",
): Promise<ListRecipientsResult> {
  const userId = await getManagerUserId("marketing");
  if (!userId) return { customers: [], total: 0, error: "Not authenticated" };
  const storeId = await getActingStoreId();
  if (!(await storeAllowsPlanFeature(storeId, "emailCampaigns"))) {
    return { customers: [], total: 0, error: CAMPAIGN_PLAN_ERROR };
  }

  const term = sanitizeSearch(search);
  try {
    return await withService(async (db) => {
      // Count of this store's emailable customers — drives the "all" estimate.
      const [countRow] = await db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.storeId, storeId), isNotNull(users.email)));
      const total = countRow?.n ?? 0;

      const conds = [eq(users.storeId, storeId), isNotNull(users.email)];
      if (term) {
        const like = `%${term}%`;
        conds.push(
          or(
            ilike(users.firstName, like),
            ilike(users.lastName, like),
            ilike(users.email, like),
            ilike(users.phone, like),
          )!,
        );
      }

      const rows = await db
        .select(RECIPIENT_COLUMNS)
        .from(users)
        .where(and(...conds))
        .orderBy(desc(users.createdAt))
        .limit(RECIPIENT_PAGE_SIZE);

      return { total, customers: rows.map(toRecipient) };
    });
  } catch (err) {
    console.error("listEmailRecipients error:", err);
    return { customers: [], total: 0, error: "Could not load customers." };
  }
}

// ---------------------------------------------------------------------------
// AI generation — one templated email body with a {{first_name}} merge tag.
// ---------------------------------------------------------------------------

const EMAIL_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
};

export async function generateCouponEmail(
  input: GenerateEmailInput,
): Promise<GenerateEmailResult> {
  const userId = await getManagerUserId("marketing");
  if (!userId) return { error: "Not authenticated" };

  // Meter against the store's plan cap, then speak in ITS voice.
  const storeId = await getActingStoreId();
  if (!(await storeAllowsPlanFeature(storeId, "emailCampaigns"))) {
    return { error: CAMPAIGN_PLAN_ERROR };
  }
  const quota = await consumeAiQuota(storeId);
  if (!quota.allowed) return { error: quota.error };

  const brand = await getBrandSoulForStore(storeId);

  const facts = [
    `Coupon code: ${input.code}`,
    `Offer: ${input.discountLabel}`,
    input.validUntilLabel ? `Valid until: ${input.validUntilLabel}` : "",
    input.description
      ? `Internal note about the coupon: ${input.description}`
      : "",
    `Audience: ${input.audienceLabel}`,
    input.instructions
      ? `Extra direction from the team: ${input.instructions}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userText = `Write a short, warm promotional email announcing a discount coupon to existing customers, in the brand's voice.

RULES:
- Address the reader using the literal token {{first_name}} once near the start (e.g. "Hi {{first_name},"). It will be replaced per recipient — do NOT invent a name.
- Do NOT print the coupon code or the discount/validity yourself — those are shown in a styled box added automatically below your copy. Just build desire and tell them a code is waiting inside.
- Keep it to 2–4 short paragraphs. Plain text only — no markdown, no HTML, no links, no images, no sign-off (a "Team {store name}" sign-off is added automatically).
- Separate paragraphs with a blank line.
- Return JSON: { "subject": "...", "body": "..." }. The subject is a single compelling line (you may use {{first_name}} in it too).

COUPON DETAILS — the only facts you may rely on:
${facts}`;

  const { text, error } = await callGemini(brandSystemText(brand), userText, {
    temperature: 0.8,
    maxOutputTokens: 1024,
    responseMimeType: "application/json",
    responseSchema: EMAIL_SCHEMA,
  });
  if (error) return { error };

  try {
    const parsed = JSON.parse(text ?? "{}") as {
      subject?: string;
      body?: string;
    };
    if (!parsed.subject || !parsed.body)
      return { error: "The AI response was incomplete. Try again." };
    return { subject: parsed.subject.trim(), body: parsed.body.trim() };
  } catch {
    return { error: "Could not parse the AI response. Try again." };
  }
}

// ---------------------------------------------------------------------------
// Preview — full branded HTML for one sample recipient (used in the dialog).
// ---------------------------------------------------------------------------

export async function renderCouponEmailPreview(input: {
  subject: string;
  body: string;
  code: string;
  discountLabel: string;
  validUntilLabel?: string | null;
  sampleName?: string;
}): Promise<{ html?: string; subject?: string; error?: string }> {
  const userId = await getManagerUserId("marketing");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();
  if (!(await storeAllowsPlanFeature(storeId, "emailCampaigns"))) {
    return { error: CAMPAIGN_PLAN_ERROR };
  }

  const firstName = input.sampleName?.trim() || "there";
  const brand = await getStoreBrand();
  const content: CouponEmailContent = {
    body: input.body,
    firstName,
    code: input.code,
    discountLabel: input.discountLabel,
    validUntilLabel: input.validUntilLabel,
    brand,
  };

  return {
    html: renderCouponEmail(content),
    subject: mergeTokens(input.subject, firstName),
  };
}

// ---------------------------------------------------------------------------
// Send — resolve the audience, merge per recipient, send via Resend in batches.
// ---------------------------------------------------------------------------

// Audience resolution is scoped to the acting store (CODEBASE.md §5.1): every
// `users` read filters by store_id so a campaign can never resolve — or mail —
// another store's customers, whatever audience/ids the client supplies.
async function resolveRecipients(
  audience: EmailAudience,
  storeId: string,
): Promise<RecipientOption[]> {
  try {
    return await withService(async (db) => {
      if (audience.mode === "group") {
        // The group is already store-unique; scope its membership too, then
        // filter the resolved users by store as defense in depth.
        const members = await db
          .select({ user_id: userGroupMembers.userId })
          .from(userGroupMembers)
          .where(
            and(
              eq(userGroupMembers.groupId, audience.groupId),
              eq(userGroupMembers.storeId, storeId),
            ),
          );
        const ids = members.map((m) => m.user_id);
        if (ids.length === 0) return [];
        const rows = await db
          .select(RECIPIENT_COLUMNS)
          .from(users)
          .where(and(inArray(users.id, ids), eq(users.storeId, storeId)));
        return rows.map(toRecipient);
      }

      if (audience.mode === "specific") {
        if (audience.customerIds.length === 0) return [];
        const rows = await db
          .select(RECIPIENT_COLUMNS)
          .from(users)
          .where(
            and(
              inArray(users.id, audience.customerIds),
              eq(users.storeId, storeId),
            ),
          );
        return rows.map(toRecipient);
      }

      // all — every emailable customer of THIS store.
      const rows = await db
        .select(RECIPIENT_COLUMNS)
        .from(users)
        .where(eq(users.storeId, storeId));
      return rows.map(toRecipient);
    });
  } catch (err) {
    console.error("resolveRecipients error:", err);
    return [];
  }
}

const RECIPIENT_INSERT_CHUNK = 1000;

/**
 * Queue a coupon campaign for background delivery. We resolve the audience and
 * write one row per recipient to email_campaign_recipients, then return
 * immediately — the worker (app/api/cron/send-emails) does the actual sending.
 * This is what lets a 100k-recipient campaign work at all: doing it inline
 * would exceed the serverless function timeout.
 */
export async function sendCouponEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const userId = await getManagerUserId("marketing");
  if (!userId) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();
  if (!(await storeAllowsPlanFeature(storeId, "emailCampaigns"))) {
    return { error: CAMPAIGN_PLAN_ERROR };
  }

  if (!input.subject.trim() || !input.body.trim())
    return { error: "Add a subject and body before sending." };

  // Fail fast in the UI if email isn't set up (the worker checks again too).
  if (!emailConfigured())
    return {
      error:
        "Email isn't configured (RESEND_API_KEY missing). Add it to send campaigns.",
    };

  const recipients = await resolveRecipients(input.audience, storeId);
  const withEmail = recipients.filter((r) => r.email);
  const skippedNoEmail = recipients.length - withEmail.length;

  if (withEmail.length === 0)
    return {
      queued: 0,
      skippedNoEmail,
      error: "None of the selected customers have an email address on file.",
    };

  // 1. Create the campaign (holds the shared subject/body/code).
  let campaignId: string;
  try {
    const [campaign] = await withService((db) =>
      db
        .insert(emailCampaigns)
        .values({
          subject: input.subject,
          body: input.body,
          code: input.code,
          discountLabel: input.discountLabel,
          validUntilLabel: input.validUntilLabel ?? null,
          total: withEmail.length,
          skippedNoEmail,
          createdBy: userId,
          storeId,
        })
        .returning({ id: emailCampaigns.id }),
    );
    campaignId = campaign.id;
  } catch (err) {
    console.error("Failed to create email campaign:", err);
    return {
      error:
        "Could not queue the campaign. Apply supabase/email_campaigns.sql, then try again.",
    };
  }

  // 2. Insert one recipient row per address, in chunks (one round trip each).
  const rows = withEmail.map((r) => ({
    campaignId,
    email: r.email as string,
    firstName: r.first_name?.trim() || "",
    storeId,
  }));
  try {
    await withService(async (db) => {
      for (let i = 0; i < rows.length; i += RECIPIENT_INSERT_CHUNK) {
        await db
          .insert(emailCampaignRecipients)
          .values(rows.slice(i, i + RECIPIENT_INSERT_CHUNK));
      }
    });
  } catch (err) {
    console.error("Failed to enqueue recipients:", err);
    return {
      error:
        "Could not queue all recipients. Some may not receive the email — check the logs.",
    };
  }

  // 3. Kick the worker after the response is sent (cron is the fallback).
  after(() => triggerEmailWorker());

  return { queued: withEmail.length, skippedNoEmail };
}
