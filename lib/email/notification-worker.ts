import "server-only";

// ---------------------------------------------------------------------------
// Notification email worker — drains notification_email_queue.
//
// Mirrors the coupon campaign worker (campaign-worker.ts): claim a batch with
// FOR UPDATE SKIP LOCKED, send, mark the outcome, report what's left so the
// caller can chain another run. The differences are all about grouping:
//
//   • Rows are GROUPED BY (store, recipient) before sending. A recipient with
//     several due rows gets ONE digest email instead of several — that is what
//     the hourly/daily settings buy.
//   • A send failure RETRIES with backoff (up to MAX_ATTEMPTS) instead of being
//     marked failed on the first hiccup. Resend having a bad minute shouldn't
//     cost a merchant the notification that an order came in.
//
// Every row carries its own rendered copy (title/body/url snapshotted at
// enqueue), so the worker needs no joins into orders/products and old mail is
// never rewritten by a later template edit.
// ---------------------------------------------------------------------------

import { Resend } from "resend";
import { count, eq, inArray, lte, and, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { notificationEmailQueue } from "@/drizzle/schema";
import { getStoreBrandById } from "@/lib/store/brand";
import { lookupStoreById } from "@/lib/store/resolve";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { PLATFORM_URL } from "@/lib/site";
import { fromAddress } from "@/lib/email/sender";
import { logError, logInfo } from "@/lib/observability/logger";
import {
  platformBrand,
  renderNotificationDigest,
  renderNotificationEmail,
  type NotificationEmailItem,
} from "@/lib/email/notification-emails";
import type { Digest } from "@/lib/notifications/events";
import type { StoreBrand } from "@/lib/store/brand";

/** Rows claimed per run. One row ≈ one queued notification, not one email —
 *  digests collapse many rows into a single send. */
const MAX_PER_RUN = 500;
/** Resend's batch.send() hard limit. */
const RESEND_BATCH = 100;
/** After this many tries a row is parked as failed rather than retried forever. */
const MAX_ATTEMPTS = 3;
/** A row claimed longer ago than this is assumed to be from a crashed run. */
const STALE_CLAIM_SECONDS = 600;

export interface NotificationWorkerResult {
  /** Queue rows processed. */
  processed: number;
  /** Emails actually sent (a digest of 9 rows counts as 1). */
  sent: number;
  failed: number;
  /** Rows retried after a send failure — they stay in the queue. */
  retried: number;
  /** Due rows still pending after this run. */
  remaining: number;
}

const EMPTY: NotificationWorkerResult = {
  processed: 0,
  sent: 0,
  failed: 0,
  retried: 0,
  remaining: 0,
};

interface QueueRow {
  id: string;
  store_id: string | null;
  recipient_id: string;
  email: string;
  cc: string | null;
  bcc: string | null;
  digest: string;
  title: string;
  body: string | null;
  url: string | null;
  severity: string;
  attempts: number;
  created_at: string;
}

function getResend(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.includes("placeholder")) return null;
  return new Resend(apiKey);
}

/** Exponential-ish backoff before the next attempt: 5, 15, 45 minutes. */
function retryDelayMinutes(attempts: number): number {
  return 5 * Math.pow(3, Math.max(0, attempts - 1));
}

/**
 * The origin a store's notification links should point at — its custom domain
 * if it has one, else its subdomain. Platform rows (no store) use the platform
 * origin. Resolved once per store per run, not per row.
 */
async function resolveBase(
  storeId: string | null,
): Promise<{ brand: StoreBrand; baseUrl: string } | null> {
  if (!storeId) {
    return { brand: platformBrand(), baseUrl: PLATFORM_URL };
  }
  try {
    const store = await lookupStoreById(storeId);
    // A deleted/suspended store has nowhere to link to — its queued mail is
    // dropped rather than sent pointing at a dead host.
    if (!store) return null;
    const brand = await getStoreBrandById(storeId);
    const host = store.custom_domain ?? `${store.slug}.${ROOT_DOMAIN}`;
    return { brand, baseUrl: `https://${host}` };
  } catch (error) {
    logError("notification worker: store resolve failed", error, { storeId });
    return null;
  }
}

/** Group claimed rows by the (store, recipient) pair that shares one email. */
function groupRows(rows: QueueRow[]): Map<string, QueueRow[]> {
  const groups = new Map<string, QueueRow[]>();
  for (const row of rows) {
    const key = `${row.store_id ?? "platform"}::${row.recipient_id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** Stored as a comma-separated string; Resend wants an array. */
function splitAddresses(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

function toItem(row: QueueRow): NotificationEmailItem {
  return {
    title: row.title,
    body: row.body,
    url: row.url,
    severity: row.severity,
    createdAt: row.created_at,
  };
}

/**
 * Drain up to `maxPerRun` due rows. Returns how many remain so the route can
 * chain another run.
 */
export async function processNotificationEmails(
  maxPerRun = MAX_PER_RUN,
): Promise<NotificationWorkerResult> {
  const resend = getResend();
  if (!resend) {
    // Not an error in dev/staging without a key — just nothing to do. The rows
    // stay pending rather than being marked sent.
    logInfo("notification worker: RESEND_API_KEY not configured, skipping");
    return EMPTY;
  }

  // Recover anything stuck mid-send from a crashed run (and park rows that
  // have burned through their retries).
  await withService((db) =>
    db.execute(
      sql`select requeue_stale_notification_emails(p_older_than_seconds => ${STALE_CLAIM_SECONDS}, p_max_attempts => ${MAX_ATTEMPTS})`,
    ),
  ).catch((err) => logError("notification worker: requeue stale failed", err));

  let claimed: QueueRow[];
  try {
    const res = await withService((db) =>
      db.execute(
        sql`select * from claim_notification_emails(p_limit => ${maxPerRun})`,
      ),
    );
    claimed = res.rows as unknown as QueueRow[];
  } catch (error) {
    logError("notification worker: claim failed", error);
    return EMPTY;
  }
  if (claimed.length === 0) {
    return { ...EMPTY, remaining: await countDue() };
  }

  // Resolve each store's brand + link origin ONCE for the whole run.
  const storeIds = [...new Set(claimed.map((r) => r.store_id))];
  const contexts = new Map<
    string,
    { brand: StoreBrand; baseUrl: string } | null
  >();
  for (const storeId of storeIds) {
    contexts.set(storeId ?? "platform", await resolveBase(storeId));
  }

  const messages: { rowIds: string[]; message: Record<string, unknown> }[] = [];
  const undeliverable: string[] = [];

  for (const [, rows] of groupRows(claimed)) {
    const ctx = contexts.get(rows[0].store_id ?? "platform");
    if (!ctx) {
      // No store to brand or link to — these can never be sent.
      undeliverable.push(...rows.map((r) => r.id));
      continue;
    }

    // Newest first, matching how the bell reads.
    const ordered = [...rows].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    const rendered =
      ordered.length === 1
        ? renderNotificationEmail({
            item: toItem(ordered[0]),
            brand: ctx.brand,
            baseUrl: ctx.baseUrl,
          })
        : renderNotificationDigest({
            items: ordered.map(toItem),
            brand: ctx.brand,
            baseUrl: ctx.baseUrl,
            digest: (ordered[0].digest as Digest) ?? "instant",
          });

    // Cc/Bcc come from the OLDEST row in the group: they were snapshotted at
    // enqueue, and the group shares one recipient, so any row's copy line is
    // the one that was configured when this batch started.
    const cc = splitAddresses(ordered[ordered.length - 1].cc);
    const bcc = splitAddresses(ordered[ordered.length - 1].bcc);

    messages.push({
      rowIds: ordered.map((r) => r.id),
      message: {
        from: fromAddress(ctx.brand, { suffix: "Notifications" }),
        to: ordered[0].email,
        ...(cc.length ? { cc } : {}),
        ...(bcc.length ? { bcc } : {}),
        subject: rendered.subject,
        html: rendered.html,
      },
    });
  }

  let sent = 0;
  let failed = undeliverable.length;
  let retried = 0;

  if (undeliverable.length > 0) {
    await markFailed(undeliverable, "Store could not be resolved");
  }

  // Send in Resend-sized batches. A batch is all-or-nothing from the API's
  // point of view, so its rows share an outcome.
  for (let i = 0; i < messages.length; i += RESEND_BATCH) {
    const slice = messages.slice(i, i + RESEND_BATCH);
    let ok = false;
    let errorText = "Unknown send error";
    try {
      const { error } = await resend.batch.send(
        slice.map((m) => m.message) as Parameters<typeof resend.batch.send>[0],
      );
      ok = !error;
      if (error) {
        errorText = error.message ?? String(error);
        logError("notification worker: resend batch error", error);
      }
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      logError("notification worker: resend batch threw", error);
    }

    const ids = slice.flatMap((m) => m.rowIds);
    if (ok) {
      await markSent(ids);
      sent += slice.length;
    } else {
      // Split by whether the row has retries left: exhausted rows are parked,
      // the rest go back to pending with a delay.
      const exhausted = ids.filter(
        (id) => attemptsFor(claimed, id) >= MAX_ATTEMPTS,
      );
      const retryable = ids.filter(
        (id) => attemptsFor(claimed, id) < MAX_ATTEMPTS,
      );
      if (exhausted.length) await markFailed(exhausted, errorText);
      if (retryable.length) {
        await markForRetry(retryable, claimed, errorText);
        retried += retryable.length;
      }
      failed += exhausted.length;
    }
  }

  const result: NotificationWorkerResult = {
    processed: claimed.length,
    sent,
    failed,
    retried,
    remaining: await countDue(),
  };
  logInfo("notification worker: run complete", { ...result });
  return result;
}

function attemptsFor(rows: QueueRow[], id: string): number {
  return rows.find((r) => r.id === id)?.attempts ?? MAX_ATTEMPTS;
}

async function markSent(ids: string[]): Promise<void> {
  await withService((db) =>
    db
      .update(notificationEmailQueue)
      .set({ status: "sent", sentAt: sql`NOW()`, lastError: null })
      .where(inArray(notificationEmailQueue.id, ids)),
  ).catch((err) => logError("notification worker: mark sent failed", err));
}

async function markFailed(ids: string[], error: string): Promise<void> {
  await withService((db) =>
    db
      .update(notificationEmailQueue)
      .set({ status: "failed", lastError: error.slice(0, 500) })
      .where(inArray(notificationEmailQueue.id, ids)),
  ).catch((err) => logError("notification worker: mark failed failed", err));
}

/** Back to pending, eligible again after a backoff proportional to attempts. */
async function markForRetry(
  ids: string[],
  rows: QueueRow[],
  error: string,
): Promise<void> {
  // Group by delay so retries stay one UPDATE per distinct backoff, not per row.
  const byDelay = new Map<number, string[]>();
  for (const id of ids) {
    const delay = retryDelayMinutes(attemptsFor(rows, id));
    const bucket = byDelay.get(delay);
    if (bucket) bucket.push(id);
    else byDelay.set(delay, [id]);
  }

  for (const [minutes, group] of byDelay) {
    await withService((db) =>
      db
        .update(notificationEmailQueue)
        .set({
          status: "pending",
          claimedAt: null,
          lastError: error.slice(0, 500),
          sendAfter: sql`NOW() + make_interval(mins => ${minutes})`,
        })
        .where(inArray(notificationEmailQueue.id, group)),
    ).catch((err) => logError("notification worker: mark retry failed", err));
  }
}

/** Due pending rows — drives the self-chaining decision in the cron route. */
async function countDue(): Promise<number> {
  try {
    const rows = await withService((db) =>
      db
        .select({ n: count() })
        .from(notificationEmailQueue)
        .where(
          and(
            eq(notificationEmailQueue.status, "pending"),
            lte(notificationEmailQueue.sendAfter, sql`NOW()`),
          ),
        ),
    );
    return rows[0]?.n ?? 0;
  } catch (error) {
    logError("notification worker: count due failed", error);
    return 0;
  }
}
