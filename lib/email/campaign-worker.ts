import "server-only";

import { Resend } from "resend";
import { and, count, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { emailCampaignRecipients, emailCampaigns } from "@/drizzle/schema";
import { mergeTokens, renderCouponEmail } from "@/lib/email/coupon-campaign";
import { getStoreBrandById, type StoreBrand } from "@/lib/store/brand";
import { fromAddress } from "@/lib/email/sender";
import { sendEmailBatch, type BatchSender } from "@/lib/email/send-batch";
import { findSuppressed, normalizeEmail } from "@/lib/email/suppression";
import { logEmail } from "@/lib/email/send";
import { recordEvent } from "@/lib/notifications/record";

const RESEND_BATCH = 100; // Resend batch.send() hard limit
const MAX_PER_RUN = 2000; // emails per worker invocation (stays within timeout)

interface ClaimedRecipient {
  id: string;
  campaign_id: string;
  email: string;
  first_name: string;
}

interface CampaignRow {
  id: string;
  subject: string;
  body: string;
  code: string;
  discount_label: string;
  valid_until_label: string | null;
  store_id: string;
  sender_address: string | null;
  brand_snapshot: unknown;
}

export interface WorkerResult {
  processed: number;
  sent: number;
  failed: number;
  /** Pending recipients still in the queue across all campaigns. */
  remaining: number;
}

function getResend(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.includes("placeholder")) return null;
  return new Resend(apiKey);
}

function readBrandSnapshot(value: unknown): StoreBrand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<StoreBrand>;
  if (
    typeof row.name !== "string" ||
    typeof row.primaryColor !== "string" ||
    typeof row.domain !== "string" ||
    !row.social ||
    typeof row.social !== "object" ||
    !Array.isArray(row.badges)
  ) {
    return null;
  }
  return row as StoreBrand;
}

/**
 * Drains up to `maxPerRun` recipients from the queue: claims a batch, sends it
 * via Resend, marks rows sent/failed, and refreshes campaign progress. Returns
 * how many remain so the caller can decide whether to run again.
 */
export async function processEmailQueue(
  maxPerRun = MAX_PER_RUN,
): Promise<WorkerResult> {
  const resend = getResend();
  if (!resend) {
    console.error("processEmailQueue: RESEND_API_KEY not configured.");
    return { processed: 0, sent: 0, failed: 0, remaining: 0 };
  }

  // Recover anything stuck mid-send from a previous crashed run.
  await withService((db) =>
    db.execute(
      sql`select requeue_stale_email_recipients(p_older_than_seconds => ${600})`,
    ),
  ).catch((err) => console.error("requeue_stale_email_recipients:", err));

  let processed = 0;
  let sent = 0;
  let failed = 0;

  while (processed < maxPerRun) {
    const want = Math.min(RESEND_BATCH, maxPerRun - processed);
    let batch: ClaimedRecipient[];
    try {
      const res = await withService((db) =>
        db.execute(sql`select * from claim_email_batch(p_limit => ${want})`),
      );
      batch = res.rows as unknown as ClaimedRecipient[];
    } catch (claimErr) {
      console.error("claim_email_batch error:", claimErr);
      break;
    }
    if (batch.length === 0) break;

    // Pull the campaign copy for every campaign represented in this batch.
    const campaignIds = [...new Set(batch.map((r) => r.campaign_id))];
    const campaignRows = await withService((db) =>
      db
        .select({
          id: emailCampaigns.id,
          subject: emailCampaigns.subject,
          body: emailCampaigns.body,
          code: emailCampaigns.code,
          discount_label: emailCampaigns.discountLabel,
          valid_until_label: emailCampaigns.validUntilLabel,
          store_id: emailCampaigns.storeId,
          sender_address: emailCampaigns.senderAddress,
          brand_snapshot: emailCampaigns.brandSnapshot,
        })
        .from(emailCampaigns)
        .where(inArray(emailCampaigns.id, campaignIds)),
    ).catch(() => [] as CampaignRow[]);
    const campaigns = new Map<string, CampaignRow>(
      campaignRows.map((c) => [c.id, c as CampaignRow]),
    );

    const storeIds = [
      ...new Set(
        campaignRows
          .filter((campaign) => !readBrandSnapshot(campaign.brand_snapshot))
          .map((campaign) => campaign.store_id),
      ),
    ].filter(Boolean);
    const brandsMap = new Map<string, StoreBrand>();
    for (const sid of storeIds) {
      brandsMap.set(sid, await getStoreBrandById(sid));
    }

    // Addresses taken out of service by a permanent bounce or a spam complaint.
    // A marketing blast is exactly where mailing them hurts most: it's the
    // shared sending domain's reputation being spent on mail nobody receives.
    const suppressed = await findSuppressed(batch.map((r) => r.email));

    // Pair each recipient id with its message so we mark ONLY the rows we
    // actually attempt to send. Recipients whose campaign/brand couldn't be
    // resolved — or whose address is suppressed — are "skipped" and must never
    // be recorded as sent.
    const prepared = batch.map((r) => {
      const c = campaigns.get(r.campaign_id);
      const brand = c
        ? (readBrandSnapshot(c.brand_snapshot) ?? brandsMap.get(c.store_id))
        : undefined;
      if (!c || !brand) return { id: r.id, message: null };
      if (suppressed.has(normalizeEmail(r.email))) {
        return { id: r.id, message: null };
      }

      const firstName = r.first_name?.trim() || "there";
      return {
        id: r.id,
        message: {
          from: c.sender_address ?? fromAddress(brand),
          to: r.email,
          subject: mergeTokens(c.subject, firstName),
          html: renderCouponEmail({
            body: c.body,
            firstName,
            code: c.code,
            discountLabel: c.discount_label,
            validUntilLabel: c.valid_until_label,
            brand,
          }),
        },
      };
    });

    const sendable = prepared.filter(
      (p): p is { id: string; message: NonNullable<typeof p.message> } =>
        p.message !== null,
    );
    const skippedIds = prepared
      .filter((p) => p.message === null)
      .map((p) => p.id);

    // PER-MESSAGE outcomes. A campaign recipient list is customer-entered data,
    // so a bad address in it is a matter of time — and this worker has no retry,
    // meaning an all-or-nothing batch verdict would permanently lose up to 99
    // good recipients to one typo. sendEmailBatch isolates the bad one.
    const outcome =
      sendable.length > 0
        ? await sendEmailBatch(
            resend as unknown as BatchSender,
            sendable.map((p) => ({ key: p.id, message: p.message })),
          )
        : {
            sent: [] as string[],
            failed: [] as { key: string; error: string }[],
          };

    const okIds = outcome.sent;
    // Attempted-but-failed rows join the skipped ones (no campaign/brand to
    // send them) so nothing is silently lost as "sent".
    const failedIds = [...outcome.failed.map((f) => f.key), ...skippedIds];

    // Mirror every attempt into the store's email log. Batch sends can't route
    // through sendEmail() without giving up batching, so this is explicit —
    // send-coverage.test.ts is what keeps it from being forgotten.
    const errorFor = new Map(outcome.failed.map((f) => [f.key, f.error]));
    for (const p of sendable) {
      const failure = errorFor.get(p.id);
      await logEmail({
        storeId: campaigns.get(
          batch.find((r) => r.id === p.id)?.campaign_id ?? "",
        )?.store_id,
        to: String(p.message.to ?? ""),
        from: String(p.message.from ?? ""),
        subject: String(p.message.subject ?? ""),
        html: String(p.message.html ?? ""),
        mailer: "coupon_campaign",
        status: failure ? "failed" : "sent",
        error: failure,
      });
    }

    if (okIds.length) {
      await withService((db) =>
        db
          .update(emailCampaignRecipients)
          .set({ status: "sent" })
          .where(inArray(emailCampaignRecipients.id, okIds)),
      ).catch((err) => console.error("mark sent:", err));
    }
    if (failedIds.length) {
      await withService((db) =>
        db
          .update(emailCampaignRecipients)
          .set({ status: "failed" })
          .where(inArray(emailCampaignRecipients.id, failedIds)),
      ).catch((err) => console.error("mark failed:", err));
    }

    processed += batch.length;
    sent += okIds.length;
    failed += failedIds.length;
  }

  await finalizeCampaigns();

  let remaining = 0;
  try {
    const now = new Date().toISOString();
    const [row] = await withService((db) =>
      db
        .select({ n: count() })
        .from(emailCampaignRecipients)
        .innerJoin(
          emailCampaigns,
          and(
            eq(emailCampaigns.id, emailCampaignRecipients.campaignId),
            eq(emailCampaigns.storeId, emailCampaignRecipients.storeId),
          ),
        )
        .where(
          and(
            eq(emailCampaignRecipients.status, "pending"),
            or(
              inArray(emailCampaigns.status, ["pending", "sending"]),
              and(
                eq(emailCampaigns.status, "scheduled"),
                lte(emailCampaigns.scheduledFor, now),
              ),
            ),
          ),
        ),
    );
    remaining = row?.n ?? 0;
  } catch (err) {
    console.error("processEmailQueue (remaining count):", err);
  }

  return { processed, sent, failed, remaining };
}

/**
 * Recompute sent/failed counters for in-flight campaigns and flip them to
 * 'done' once no pending/sending recipients remain.
 */
async function finalizeCampaigns(): Promise<void> {
  let active: { id: string }[];
  try {
    active = await withService((db) =>
      db
        .select({ id: emailCampaigns.id })
        .from(emailCampaigns)
        .where(inArray(emailCampaigns.status, ["pending", "sending"])),
    );
  } catch (err) {
    console.error("finalizeCampaigns (active):", err);
    return;
  }

  for (const c of active) {
    const id = c.id;
    try {
      const finished = await withService(async (db) => {
        const sentRes = await db
          .select({ n: count() })
          .from(emailCampaignRecipients)
          .where(
            and(
              eq(emailCampaignRecipients.campaignId, id),
              eq(emailCampaignRecipients.status, "sent"),
            ),
          );
        const failedRes = await db
          .select({ n: count() })
          .from(emailCampaignRecipients)
          .where(
            and(
              eq(emailCampaignRecipients.campaignId, id),
              eq(emailCampaignRecipients.status, "failed"),
            ),
          );
        const openRes = await db
          .select({ n: count() })
          .from(emailCampaignRecipients)
          .where(
            and(
              eq(emailCampaignRecipients.campaignId, id),
              inArray(emailCampaignRecipients.status, ["pending", "sending"]),
            ),
          );

        const open = openRes[0]?.n ?? 0;
        // Claim the → done transition: `ne(status, "done")` means only the
        // pass that actually finishes the campaign gets a row back, so the
        // completion notification fires exactly once no matter how often the
        // worker runs.
        const rows = await db
          .update(emailCampaigns)
          .set({
            sent: sentRes[0]?.n ?? 0,
            failed: failedRes[0]?.n ?? 0,
            status: open === 0 ? "done" : "sending",
          })
          .where(
            and(eq(emailCampaigns.id, id), ne(emailCampaigns.status, "done")),
          )
          .returning({
            storeId: emailCampaigns.storeId,
            subject: emailCampaigns.subject,
            sent: emailCampaigns.sent,
            failed: emailCampaigns.failed,
          });
        return open === 0 ? rows[0] : undefined;
      });

      if (finished?.storeId) {
        // recordEvent, not emitEvent: the worker runs from a cron route whose
        // response is already gone by the time after() would fire.
        await recordEvent({
          type: "campaign.sent",
          storeId: finished.storeId,
          actor: { type: "system" },
          subject: { type: "campaign", id, label: finished.subject },
          payload: {
            campaign: finished.subject ?? "",
            sent: Number(finished.sent ?? 0),
            failed: Number(finished.failed ?? 0),
          },
        });
      }
    } catch (err) {
      console.error(`finalizeCampaigns (campaign ${id}):`, err);
    }
  }
}
