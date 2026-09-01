import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  coupons,
  emailCampaignRecipients,
  emailCampaigns,
  emailSuppressions,
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  stores,
  userGroupMembers,
  userGroups,
  users,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { mergeTokens, renderCouponEmail } from "@/lib/email/coupon-campaign";
import { emailConfigured } from "@/lib/email/send";
import { fromAddress, senderDomainFor } from "@/lib/email/sender";
import { limitsFor } from "@/lib/plans";
import { brandFromSettings, type StoreBrand } from "@/lib/store/brand";
import { hashMinkActionPayload } from "./action-integrity";
import {
  finalizeMinkCampaignRecipients,
  normalizeMinkCampaignCandidates,
  type MinkCampaignRecipient,
} from "./campaign-audience";
import type {
  MinkCampaignApproval,
  MinkCampaignAudienceOptions,
  MinkCampaignExecutionResult,
  MinkCampaignResult,
  MinkCampaignSample,
  MinkCampaignValues,
} from "./campaign-action-types";
import {
  MAX_MINK_CAMPAIGN_RECIPIENTS,
  MinkCampaignPolicyError,
  normalizeMinkCampaignAudience,
  normalizeMinkCampaignTiming,
  type MinkCampaignAudienceSelection,
  type MinkCampaignTiming,
} from "./campaign-policy";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import type { MinkActorContext } from "./types";

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const TOOL_VERSION = 1;
const RECIPIENT_INSERT_CHUNK = 1_000;

type ApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: "send_campaign";
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  resourceType: "campaign";
  resourceId: string;
};

type AudienceSnapshot = {
  selection: MinkCampaignAudienceSelection;
  label: string;
  eligible: MinkCampaignRecipient[];
  excludedNoEmail: number;
  excludedDuplicate: number;
  excludedSuppressed: number;
  hash: string;
};

export async function getMinkCampaignAudienceOptions(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkCampaignAudienceOptions> {
  assertCampaignEmailConfigured();
  return withService(async (db) => {
    assertCampaignAuthority(actor);
    await assertToolEnabled(db, actor.storeId);
    await readDraft(db, actor, draftId);
    const rows = await db
      .select({ id: userGroups.id, label: userGroups.name })
      .from(userGroups)
      .where(eq(userGroups.storeId, actor.storeId))
      .orderBy(userGroups.name)
      .limit(100);
    return {
      allLabel: "All customers",
      groups: rows,
      maxRecipients: MAX_MINK_CAMPAIGN_RECIPIENTS,
    };
  });
}

export async function getLatestMinkCampaign(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkCampaignResult | null> {
  return withService(async (db) => {
    assertCampaignDraftAuthority(actor);
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.toolName, "send_campaign"),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    const approval = validateApproval(rows[0]);
    const campaign = await readCampaign(db, actor.storeId, approval.resultId!);
    const audit = await readAudit(db, actor.storeId, approval.id);
    return result(approval, campaign, audit?.id ?? null, true, null);
  });
}

export async function previewMinkCampaign(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
  audienceMode: unknown;
  groupId?: unknown;
  mode: unknown;
  scheduledFor?: unknown;
}): Promise<MinkCampaignApproval> {
  assertCampaignEmailConfigured();
  const timing = timingForRequest(input.mode, input.scheduledFor);
  const selection = audienceForRequest(input.audienceMode, input.groupId);
  return withService(async (db) => {
    assertCampaignAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw conflict(
        "mink_campaign_draft_conflict",
        "The saved campaign proposal changed. Save and review it again.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId);
    const content = normalizeCampaignContent(draft.content);
    const coupon = await readCoupon(
      db,
      input.actor.storeId,
      draft.destinationId,
    );
    assertCouponSendable(coupon, timing);
    const brand = await readBrand(db, input.actor.storeId);
    const audience = await resolveAudience(db, input.actor.storeId, selection);
    if (audience.eligible.length === 0) {
      throw new MinkRequestError(
        "mink_campaign_audience_empty",
        "No eligible, unsuppressed customer email addresses are in this audience.",
        409,
      );
    }
    const before = beforeValues();
    const after = campaignValues({ content, coupon, brand, audience, timing });
    return createApproval(db, {
      actor: input.actor,
      draftId: draft.id,
      draftVersion: draft.currentVersion,
      couponId: coupon.id,
      couponVersion: coupon.updatedAt,
      label: `Coupon campaign · ${coupon.code}`,
      before,
      after,
      idempotencyKey: input.idempotencyKey,
      sample: sampleFor(content, coupon, brand),
    });
  });
}

export async function executeMinkCampaign(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkCampaignExecutionResult> {
  assertCampaignEmailConfigured();
  const outcome = await withService(async (db) => {
    assertCampaignAuthority(input.actor);
    await lockApproval(db, input.actor, input.approvalId);
    const approval = await readApproval(db, input.actor, input.approvalId);
    if (approval.draftId !== input.draftId) throw approvalNotFound();
    if (approval.status === "executed") {
      const campaign = await readCampaign(
        db,
        input.actor.storeId,
        approval.resultId!,
      );
      const audit = await readAudit(db, input.actor.storeId, approval.id);
      return {
        result: {
          ...result(approval, campaign, audit?.id ?? null, true, null),
          triggerWorker: false,
        },
      };
    }
    if (approval.status !== "pending") {
      throw conflict(
        "mink_campaign_approval_terminal",
        "This campaign approval is no longer available.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId, true);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      await finalizeWithoutWrite(db, approval, "expired", "Approval expired.");
      return {
        error: conflict(
          "mink_campaign_approval_expired",
          "This campaign approval expired. Review the audience and sample again.",
        ),
      };
    }
    await lockDraft(db, input.actor, approval.draftId);
    const draft = await readDraft(db, input.actor, approval.draftId);
    if (draft.currentVersion !== approval.draftVersion) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The campaign proposal changed after preview.",
      );
      return {
        error: conflict(
          "mink_campaign_draft_conflict",
          "The campaign proposal changed after preview. Review it again.",
        ),
      };
    }
    const approvedBefore = valuesFromJson(approval.beforeJson);
    const approvedAfter = valuesFromJson(approval.afterJson);
    const timing = timingFromApproval(approval, approvedAfter);
    if (
      timing.mode === "schedule" &&
      Date.parse(timing.scheduledFor) <= Date.now()
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The scheduled send time passed before final confirmation.",
      );
      return {
        error: conflict(
          "mink_campaign_schedule_passed",
          "The scheduled time has passed. Choose a new future time and review again.",
        ),
      };
    }
    const content = normalizeCampaignContent(draft.content);
    const coupon = await readCoupon(
      db,
      input.actor.storeId,
      approval.resourceId,
    );
    const brand = await readBrand(db, input.actor.storeId);
    const audience = await resolveAudience(
      db,
      input.actor.storeId,
      audienceFromApproval(approvedAfter),
    );
    assertCouponSendable(coupon, timing);
    const currentBefore = beforeValues();
    const currentAfter = campaignValues({
      content,
      coupon,
      brand,
      audience,
      timing,
    });
    if (
      coupon.updatedAt !== approval.resourceVersion ||
      hashMinkActionPayload(currentBefore) !==
        hashMinkActionPayload(approvedBefore) ||
      hashMinkActionPayload(currentAfter) !==
        hashMinkActionPayload(approvedAfter) ||
      approval.requestHash !==
        requestHash(approval, approvedBefore, approvedAfter)
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The coupon, sender or exact audience changed after preview.",
      );
      return {
        error: conflict(
          "mink_campaign_checkpoint_conflict",
          "The coupon, sender or audience changed. Review the campaign again before sending.",
        ),
      };
    }

    const now = new Date().toISOString();
    const campaignId = crypto.randomUUID();
    const campaignStatus = timing.mode === "send_now" ? "pending" : "scheduled";
    await db.insert(emailCampaigns).values({
      id: campaignId,
      subject: content.subject,
      body: content.body,
      code: coupon.code,
      discountLabel: discountLabel(coupon),
      validUntilLabel: validUntilLabel(coupon.validUntil),
      status: campaignStatus,
      total: audience.eligible.length,
      skippedNoEmail:
        audience.excludedNoEmail +
        audience.excludedDuplicate +
        audience.excludedSuppressed,
      createdBy: input.actor.adminId,
      storeId: input.actor.storeId,
      scheduledFor: timing.scheduledFor,
      minkApprovalId: approval.id,
      audienceMode: audience.selection.mode,
      audienceLabel: audience.label,
      senderAddress: fromAddress(brand),
      brandSnapshot: brand,
      confirmedAt: now,
    });
    const recipientRows = audience.eligible.map((recipient) => ({
      campaignId,
      email: recipient.email,
      firstName: recipient.firstName,
      storeId: input.actor.storeId,
    }));
    for (
      let start = 0;
      start < recipientRows.length;
      start += RECIPIENT_INSERT_CHUNK
    ) {
      await db
        .insert(emailCampaignRecipients)
        .values(recipientRows.slice(start, start + RECIPIENT_INSERT_CHUNK));
    }
    const finalized = await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: now,
        executedAt: now,
        resultId: campaignId,
        resultVersion: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkActionApprovals.id, approval.id),
          eq(minkActionApprovals.storeId, input.actor.storeId),
          eq(minkActionApprovals.status, "pending"),
        ),
      )
      .returning({ id: minkActionApprovals.id });
    if (!finalized[0]) throw invalidApproval();
    const auditId = crypto.randomUUID();
    await db.insert(minkActionAudit).values({
      id: auditId,
      approvalId: approval.id,
      storeId: approval.storeId,
      adminId: approval.adminId,
      draftId: approval.draftId,
      productId: null,
      resourceType: "campaign",
      resourceId: approval.resourceId,
      locationId: null,
      variantId: null,
      resourceVersionBefore: approval.resourceVersion,
      resourceVersionAfter: coupon.updatedAt,
      resultId: campaignId,
      toolName: "send_campaign",
      operation: "apply",
      outcome: "executed",
      beforeJson: approvedBefore,
      afterJson: approvedAfter,
      productVersionBefore: null,
      productVersionAfter: null,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail:
        timing.mode === "send_now"
          ? `Final confirmation queued ${audience.eligible.length} exact campaign recipients.`
          : `Final confirmation scheduled ${audience.eligible.length} exact campaign recipients for ${timing.scheduledFor}.`,
    });
    const executed: ApprovalRow = {
      ...approval,
      status: "executed",
      approvedAt: now,
      executedAt: now,
      resultId: campaignId,
      resultVersion: now,
    };
    const campaign = {
      id: campaignId,
      status: campaignStatus,
      scheduledFor: timing.scheduledFor,
      total: audience.eligible.length,
    };
    return {
      result: {
        ...result(executed, campaign, auditId, false, null),
        triggerWorker: timing.mode === "send_now",
      },
    };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

async function resolveAudience(
  db: Db,
  storeId: string,
  selection: MinkCampaignAudienceSelection,
): Promise<AudienceSnapshot> {
  let label = "All customers";
  let rows: Array<{ id: string; email: string | null; firstName: string }>;
  if (selection.mode === "group") {
    const groups = await db
      .select({ name: userGroups.name })
      .from(userGroups)
      .where(
        and(
          eq(userGroups.id, selection.groupId),
          eq(userGroups.storeId, storeId),
        ),
      )
      .limit(1);
    if (!groups[0]) {
      throw new MinkRequestError(
        "mink_campaign_group_unavailable",
        "That customer group is not available in this store.",
        404,
      );
    }
    label = groups[0].name;
    rows = await db
      .select({ id: users.id, email: users.email, firstName: users.firstName })
      .from(userGroupMembers)
      .innerJoin(
        users,
        and(eq(users.id, userGroupMembers.userId), eq(users.storeId, storeId)),
      )
      .where(
        and(
          eq(userGroupMembers.groupId, selection.groupId),
          eq(userGroupMembers.storeId, storeId),
        ),
      )
      .orderBy(users.id)
      .limit(MAX_MINK_CAMPAIGN_RECIPIENTS + 1);
  } else {
    rows = await db
      .select({ id: users.id, email: users.email, firstName: users.firstName })
      .from(users)
      .where(eq(users.storeId, storeId))
      .orderBy(users.id)
      .limit(MAX_MINK_CAMPAIGN_RECIPIENTS + 1);
  }
  if (rows.length > MAX_MINK_CAMPAIGN_RECIPIENTS) {
    throw new MinkRequestError(
      "mink_campaign_audience_too_large",
      `Mink campaign audiences are capped at ${MAX_MINK_CAMPAIGN_RECIPIENTS.toLocaleString("en-IN")} customers in this beta.`,
      409,
    );
  }
  const normalized = normalizeMinkCampaignCandidates(rows);
  const suppressedRows = normalized.candidates.length
    ? await db
        .select({ email: emailSuppressions.email })
        .from(emailSuppressions)
        .where(
          inArray(
            emailSuppressions.email,
            normalized.candidates.map((row) => row.email),
          ),
        )
    : [];
  const finalized = finalizeMinkCampaignRecipients({
    candidates: normalized.candidates,
    suppressedEmails: suppressedRows.map((row) => row.email),
  });
  return {
    selection,
    label,
    eligible: finalized.eligible,
    excludedNoEmail: normalized.excludedNoEmail,
    excludedDuplicate: normalized.excludedDuplicate,
    excludedSuppressed: finalized.excludedSuppressed,
    hash: finalized.hash,
  };
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    couponId: string;
    couponVersion: string;
    label: string;
    before: MinkCampaignValues;
    after: MinkCampaignValues;
    idempotencyKey: string;
    sample: MinkCampaignSample;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const requestHashValue = hashMinkActionPayload({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    couponId: input.couponId,
    couponVersion: input.couponVersion,
    before: input.before,
    after: input.after,
  });
  const inserted = await db
    .insert(minkActionApprovals)
    .values({
      id,
      storeId: input.actor.storeId,
      adminId: input.actor.adminId,
      draftId: input.draftId,
      productId: null,
      resourceType: "campaign",
      resourceId: input.couponId,
      resourceVersion: input.couponVersion,
      resourceLabel: input.label,
      locationId: null,
      variantId: null,
      sourceApprovalId: null,
      toolName: "send_campaign",
      operation: "apply",
      draftVersion: input.draftVersion,
      productVersion: null,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash: requestHashValue,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateApproval(inserted[0])
    : await readByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== requestHashValue) {
    throw conflict(
      "mink_campaign_idempotency_conflict",
      "This request key was already used for a different campaign preview.",
    );
  }
  return toApproval(row, input.sample);
}

function campaignValues(input: {
  content: { subject: string; body: string };
  coupon: Awaited<ReturnType<typeof readCoupon>>;
  brand: StoreBrand;
  audience: AudienceSnapshot;
  timing: MinkCampaignTiming;
}): MinkCampaignValues {
  return {
    delivery:
      input.timing.mode === "send_now"
        ? "Queue after final confirmation"
        : "Scheduled",
    scheduled_for:
      input.timing.mode === "schedule" ? input.timing.scheduledFor : null,
    sender: fromAddress(input.brand),
    audience: input.audience.label,
    eligible_recipients: String(input.audience.eligible.length),
    excluded_no_email: String(input.audience.excludedNoEmail),
    excluded_duplicate: String(input.audience.excludedDuplicate),
    excluded_suppressed: String(input.audience.excludedSuppressed),
    coupon: input.coupon.code,
    offer: discountLabel(input.coupon),
    valid_until: validUntilLabel(input.coupon.validUntil),
    subject: input.content.subject,
    body: input.content.body,
    audience_mode: input.audience.selection.mode,
    audience_group_id: input.audience.selection.groupId,
    audience_hash: input.audience.hash,
  };
}

function beforeValues(): MinkCampaignValues {
  return {
    delivery: "Not queued",
    scheduled_for: null,
    sender: null,
    audience: null,
    eligible_recipients: "0",
    excluded_no_email: "0",
    excluded_duplicate: "0",
    excluded_suppressed: "0",
    coupon: null,
    offer: null,
    valid_until: null,
    subject: null,
    body: null,
  };
}

function sampleFor(
  content: { subject: string; body: string },
  coupon: Awaited<ReturnType<typeof readCoupon>>,
  brand: StoreBrand,
): MinkCampaignSample {
  const firstName = "Customer";
  return {
    subject: mergeTokens(content.subject, firstName),
    html: renderCouponEmail({
      body: content.body,
      firstName,
      code: coupon.code,
      discountLabel: discountLabel(coupon),
      validUntilLabel: validUntilLabel(coupon.validUntil),
      brand,
    }),
    recipientLabel: "Sample customer",
  };
}

async function readDraft(db: Db, actor: MinkActorContext, draftId: string) {
  const rows = await db
    .select({
      id: minkDrafts.id,
      kind: minkDrafts.kind,
      status: minkDrafts.status,
      content: minkDrafts.contentJson,
      currentVersion: minkDrafts.currentVersion,
      destinationId: minkDrafts.destinationId,
    })
    .from(minkDrafts)
    .where(
      and(
        eq(minkDrafts.id, draftId),
        eq(minkDrafts.storeId, actor.storeId),
        eq(minkDrafts.adminId, actor.adminId),
      ),
    )
    .limit(1);
  const draft = rows[0];
  if (
    !draft ||
    draft.kind !== "coupon_email" ||
    draft.status !== "draft" ||
    draft.currentVersion < 1 ||
    !draft.destinationId
  ) {
    throw new MinkRequestError(
      "mink_campaign_draft_unavailable",
      "Save this private coupon-email proposal before reviewing a campaign.",
      409,
    );
  }
  return { ...draft, destinationId: draft.destinationId } as typeof draft & {
    destinationId: string;
  };
}

async function readCoupon(db: Db, storeId: string, couponId: string) {
  const rows = await db
    .select({
      id: coupons.id,
      code: coupons.code,
      status: coupons.status,
      discountType: coupons.discountType,
      discountValue: coupons.discountValue,
      maxUses: coupons.maxUses,
      usedCount: coupons.usedCount,
      validFrom: coupons.validFrom,
      validUntil: coupons.validUntil,
      updatedAt: coupons.updatedAt,
    })
    .from(coupons)
    .where(and(eq(coupons.id, couponId), eq(coupons.storeId, storeId)))
    .limit(1);
  if (!rows[0]) {
    throw new MinkRequestError(
      "mink_campaign_coupon_unavailable",
      "The linked coupon is not available in this store.",
      404,
    );
  }
  return rows[0];
}

/**
 * Read the store's sending identity.
 *
 * ★ IT DELIBERATELY DOES NOT LOCK THE STORE ROW. Execution used to take it
 * `FOR UPDATE`, which reads as protection against a branding edit landing
 * mid-send — but a row lock is held until the TRANSACTION commits, and this one
 * goes on to insert the campaign plus up to 10,000 recipients. That serialised
 * every other write to the same store row (a settings save, enabling POS, a
 * plan change, the SEO hook stamping `settings.google_*`) behind the batch, and
 * on a large audience an unrelated dashboard save could time out with nothing
 * pointing back at the campaign.
 *
 * It bought nothing, because two things already close that window: the approved
 * brand and sender are SNAPSHOTTED onto the campaign row (`brandSnapshot` /
 * `senderAddress`), which is what the worker sends with, and the checkpoint
 * hash re-compares this brand against the previewed one, so drift becomes a
 * conflict rather than a surprise. Don't reintroduce the lock.
 */
async function readBrand(db: Db, storeId: string) {
  const rows = await db
    .select({
      name: stores.name,
      settings: stores.settings,
      customDomain: stores.customDomain,
    })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  const store = rows[0];
  if (!store)
    throw new MinkRequestError(
      "mink_campaign_store_missing",
      "Store unavailable.",
      404,
    );
  return brandFromSettings(
    store.settings as Record<string, unknown>,
    store.name,
    senderDomainFor({
      custom_domain: store.customDomain,
      settings: store.settings as Record<string, unknown>,
    }),
  );
}

function assertCouponSendable(
  coupon: Awaited<ReturnType<typeof readCoupon>>,
  timing: MinkCampaignTiming,
) {
  const sendAt =
    timing.mode === "schedule" ? Date.parse(timing.scheduledFor) : Date.now();
  if (coupon.status !== "active") {
    throw conflict(
      "mink_campaign_coupon_inactive",
      "Activate the coupon before reviewing a campaign.",
    );
  }
  if (coupon.validFrom && Date.parse(coupon.validFrom) > sendAt) {
    throw conflict(
      "mink_campaign_coupon_not_started",
      "The coupon is not active at the selected send time.",
    );
  }
  if (coupon.validUntil && Date.parse(coupon.validUntil) <= sendAt) {
    throw conflict(
      "mink_campaign_coupon_expired",
      "The coupon expires before the selected send time.",
    );
  }
  if (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) {
    throw conflict(
      "mink_campaign_coupon_exhausted",
      "The coupon has reached its maximum uses.",
    );
  }
}

function normalizeCampaignContent(value: unknown) {
  let content: { subject: string; body: string };
  try {
    content = normalizeMinkDraftContent("coupon_email", value) as {
      subject: string;
      body: string;
    };
  } catch (error) {
    throw new MinkRequestError(
      "mink_campaign_draft_invalid",
      error instanceof Error ? error.message : "Invalid campaign proposal.",
      400,
    );
  }
  if (/\r|\n/.test(content.subject)) {
    throw new MinkRequestError(
      "mink_campaign_subject_invalid",
      "Campaign subject must be one line.",
      400,
    );
  }
  return content;
}

function discountLabel(coupon: {
  discountType: string;
  discountValue: number;
}) {
  return coupon.discountType === "percentage"
    ? `${coupon.discountValue}% off`
    : `₹${coupon.discountValue.toLocaleString("en-IN")} off`;
}

function validUntilLabel(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function audienceFromApproval(after: MinkCampaignValues) {
  try {
    return normalizeMinkCampaignAudience({
      mode: after.audience_mode,
      groupId: after.audience_group_id,
    });
  } catch {
    throw invalidApproval();
  }
}

function timingForRequest(mode: unknown, scheduledFor: unknown) {
  try {
    return normalizeMinkCampaignTiming({ mode, scheduledFor });
  } catch (error) {
    throw new MinkRequestError(
      "mink_campaign_timing_invalid",
      error instanceof Error ? error.message : "Invalid campaign timing.",
      400,
    );
  }
}

function audienceForRequest(mode: unknown, groupId: unknown) {
  try {
    return normalizeMinkCampaignAudience({ mode, groupId });
  } catch (error) {
    throw new MinkRequestError(
      "mink_campaign_audience_invalid",
      error instanceof Error ? error.message : "Invalid campaign audience.",
      400,
    );
  }
}

function timingFromApproval(approval: ApprovalRow, after: MinkCampaignValues) {
  const mode = after.delivery === "Scheduled" ? "schedule" : "send_now";
  try {
    return normalizeMinkCampaignTiming({
      mode,
      scheduledFor: mode === "schedule" ? after.scheduled_for : undefined,
      nowMs: Date.parse(approval.createdAt),
    });
  } catch (error) {
    if (error instanceof MinkCampaignPolicyError) throw invalidApproval();
    throw error;
  }
}

function result(
  approval: ApprovalRow,
  campaign: {
    id: string;
    status: string;
    scheduledFor: string | null;
    total: number;
  },
  auditId: string | null,
  repeated: boolean,
  sample: MinkCampaignSample | null,
): MinkCampaignResult {
  if (!["pending", "scheduled", "sending", "done"].includes(campaign.status)) {
    throw invalidApproval();
  }
  return {
    approval: toApproval(approval, sample),
    auditId,
    repeated,
    campaign: {
      id: campaign.id,
      status: campaign.status as "pending" | "scheduled" | "sending" | "done",
      scheduledFor: campaign.scheduledFor,
      recipientCount: campaign.total,
    },
  };
}

function toApproval(
  row: ApprovalRow,
  sample: MinkCampaignSample | null,
): MinkCampaignApproval {
  return {
    id: row.id,
    sourceApprovalId: null,
    toolName: "send_campaign",
    operation: "apply",
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "campaign",
      id: row.resultId,
      label: row.resourceLabel ?? "Coupon campaign",
      dashboardPath: "/dashboard/marketing/coupons",
    },
    before: valuesFromJson(row.beforeJson),
    after: valuesFromJson(row.afterJson),
    sample,
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function validateApproval(
  row: typeof minkActionApprovals.$inferSelect,
): ApprovalRow {
  if (
    row.toolName !== "send_campaign" ||
    row.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "campaign" ||
    !row.resourceId ||
    row.productId ||
    row.locationId ||
    row.variantId ||
    row.sourceApprovalId
  ) {
    throw invalidApproval();
  }
  return row as ApprovalRow;
}

async function readCampaign(db: Db, storeId: string, campaignId: string) {
  const rows = await db
    .select({
      id: emailCampaigns.id,
      status: emailCampaigns.status,
      scheduledFor: emailCampaigns.scheduledFor,
      total: emailCampaigns.total,
    })
    .from(emailCampaigns)
    .where(
      and(
        eq(emailCampaigns.id, campaignId),
        eq(emailCampaigns.storeId, storeId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw invalidApproval();
  return rows[0];
}

async function assertToolEnabled(db: Db, storeId: string, lock = false) {
  if (lock) {
    const result = await db.execute(sql`
      select enabled from public.mink_action_tool_access
      where store_id = ${storeId}::uuid and tool_name = 'send_campaign'
      for update
    `);
    if ((result.rows[0] as { enabled?: boolean } | undefined)?.enabled) return;
  } else {
    const rows = await db
      .select({ enabled: minkActionToolAccess.enabled })
      .from(minkActionToolAccess)
      .where(
        and(
          eq(minkActionToolAccess.storeId, storeId),
          eq(minkActionToolAccess.toolName, "send_campaign"),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled) return;
  }
  throw new MinkRequestError(
    "mink_campaign_tool_disabled",
    "StoreMink support has not enabled Mink campaign sending for this store.",
    403,
  );
}

function assertCampaignAuthority(actor: MinkActorContext) {
  assertCampaignDraftAuthority(actor);
  if (!limitsFor(actor.effectivePlan).emailCampaigns) {
    throw new MinkRequestError(
      "mink_campaign_access_denied",
      "Your current plan does not include email campaigns.",
      403,
    );
  }
}

function assertCampaignDraftAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "marketing", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_campaign_access_denied",
      "You do not have permission to access Mink campaign drafts.",
      403,
    );
  }
}

function assertCampaignEmailConfigured() {
  if (!emailConfigured()) {
    throw new MinkRequestError(
      "mink_campaign_email_unavailable",
      "Email delivery is not configured for this environment.",
      503,
    );
  }
}

async function lockDraft(db: Db, actor: MinkActorContext, draftId: string) {
  await db.execute(sql`
    select id from public.mink_drafts
    where id = ${draftId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function lockApproval(
  db: Db,
  actor: MinkActorContext,
  approvalId: string,
) {
  await db.execute(sql`
    select id from public.mink_action_approvals
    where id = ${approvalId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function readApproval(db: Db, actor: MinkActorContext, id: string) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.id, id),
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validateApproval(rows[0]);
}

async function readByIdempotency(
  db: Db,
  actor: MinkActorContext,
  idempotencyKey: string,
) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
        eq(minkActionApprovals.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validateApproval(rows[0]);
}

async function readAudit(db: Db, storeId: string, approvalId: string) {
  const rows = await db
    .select({ id: minkActionAudit.id })
    .from(minkActionAudit)
    .where(
      and(
        eq(minkActionAudit.storeId, storeId),
        eq(minkActionAudit.approvalId, approvalId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function finalizeWithoutWrite(
  db: Db,
  approval: ApprovalRow,
  status: "conflicted" | "expired",
  detail: string,
) {
  await db
    .update(minkActionApprovals)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(minkActionApprovals.id, approval.id),
        eq(minkActionApprovals.storeId, approval.storeId),
      ),
    );
  await db.insert(minkActionAudit).values({
    id: crypto.randomUUID(),
    approvalId: approval.id,
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    productId: null,
    resourceType: "campaign",
    resourceId: approval.resourceId,
    locationId: null,
    variantId: null,
    resourceVersionBefore: approval.resourceVersion,
    resourceVersionAfter: null,
    resultId: null,
    toolName: "send_campaign",
    operation: "apply",
    outcome: status,
    beforeJson: valuesFromJson(approval.beforeJson),
    afterJson: valuesFromJson(approval.afterJson),
    productVersionBefore: null,
    productVersionAfter: null,
    requestHash: approval.requestHash,
    toolVersion: TOOL_VERSION,
    detail,
  });
}

function requestHash(
  approval: ApprovalRow,
  before: MinkCampaignValues,
  after: MinkCampaignValues,
) {
  return hashMinkActionPayload({
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    draftVersion: approval.draftVersion,
    couponId: approval.resourceId,
    couponVersion: approval.resourceVersion,
    before,
    after,
  });
}

function valuesFromJson(value: unknown): MinkCampaignValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const result: MinkCampaignValues = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item !== "string") throw invalidApproval();
    result[key] = item;
  }
  return result;
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_campaign_approval_invalid",
    "This campaign approval is invalid. Create a new preview.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_campaign_approval_not_found",
    "This campaign approval is unavailable.",
    404,
  );
}

function conflict(code: string, message: string) {
  return new MinkRequestError(code, message, 409);
}
