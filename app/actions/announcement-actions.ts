"use server";

// ---------------------------------------------------------------------------
// Platform announcements (§38) — StoreMink telling its merchants something.
//
// ★ EVERY EXPORT HERE IS A PUBLIC POST ENDPOINT, and these ones mail every
// merchant on the platform. So every one of them re-gates on
// `getPlatformViewer()` for itself; the page's gate is not the boundary.
// Sending is superadmin-only — a member can draft and preview, because
// reviewing copy is exactly the delegable half.
// ---------------------------------------------------------------------------

import { desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import {
  platformAnnouncementRecipients,
  platformAnnouncements,
} from "@/drizzle/schema";
import { getPlatformViewer } from "@/app/actions/platform";
import { logError } from "@/lib/observability/logger";
import { sanitizeBlogContent } from "@/lib/sanitize";
import { sendEmail } from "@/lib/email/send";
import { renderAnnouncementEmail } from "@/lib/email/announcement-email";
import { PLATFORM_EMAIL_DOMAIN } from "@/lib/email/sender";
import { triggerEmailWorker } from "@/lib/email/trigger-worker";
import { PLATFORM_URL } from "@/lib/site";
import type { StoreBrand } from "@/lib/store/brand";
import {
  normalizeAudience,
  type AnnouncementCategory,
  type AudienceFilter,
} from "@/lib/announcements/audience";
import { smsAvailability } from "@/lib/announcements/sms-availability";
import {
  materialiseRecipients,
  previewAudience,
  type AudiencePreview,
} from "@/lib/announcements/resolve";

export interface ActionResult {
  success?: boolean;
  error?: string;
  id?: string;
}

const PLATFORM_BRAND: StoreBrand = {
  name: "StoreMink",
  logoUrl: null,
  primaryColor: "#202223",
  tagline: null,
  blurb: null,
  legalName: "StoreMink",
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: PLATFORM_EMAIL_DOMAIN,
};

export interface AnnouncementRow {
  id: string;
  title: string;
  category: AnnouncementCategory;
  subject: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  smsBody: string | null;
  dltTemplateId: string | null;
  channels: { email: boolean; sms: boolean };
  audience: AudienceFilter;
  status: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  createdBy: string | null;
  createdAt: string;
  sentAt: string | null;
}

function toRow(raw: Record<string, unknown>): AnnouncementRow {
  const channels = (raw.channels ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id),
    title: String(raw.title ?? ""),
    category: raw.category === "operational" ? "operational" : "feature",
    subject: String(raw.subject ?? ""),
    body: String(raw.body ?? ""),
    ctaLabel: (raw.ctaLabel as string) ?? null,
    ctaUrl: (raw.ctaUrl as string) ?? null,
    smsBody: (raw.smsBody as string) ?? null,
    dltTemplateId: (raw.dltTemplateId as string) ?? null,
    channels: { email: channels.email !== false, sms: channels.sms === true },
    audience: normalizeAudience(raw.audience),
    status: String(raw.status ?? "draft"),
    total: Number(raw.total) || 0,
    sent: Number(raw.sent) || 0,
    failed: Number(raw.failed) || 0,
    skipped: Number(raw.skipped) || 0,
    createdBy: (raw.createdBy as string) ?? null,
    createdAt: String(raw.createdAt),
    sentAt: (raw.sentAt as string) ?? null,
  };
}

export async function listAnnouncements(): Promise<AnnouncementRow[]> {
  if (!(await getPlatformViewer())) return [];
  try {
    const rows = await withService((db) =>
      db
        .select()
        .from(platformAnnouncements)
        .orderBy(desc(platformAnnouncements.createdAt))
        .limit(100),
    );
    return rows.map((r) => toRow(r as unknown as Record<string, unknown>));
  } catch (error) {
    logError("listAnnouncements failed", error);
    return [];
  }
}

export async function getAnnouncement(
  id: string,
): Promise<AnnouncementRow | null> {
  if (!(await getPlatformViewer())) return null;
  try {
    const rows = await withService((db) =>
      db
        .select()
        .from(platformAnnouncements)
        .where(eq(platformAnnouncements.id, id))
        .limit(1),
    );
    return rows[0]
      ? toRow(rows[0] as unknown as Record<string, unknown>)
      : null;
  } catch (error) {
    logError("getAnnouncement failed", error, { id });
    return null;
  }
}

export interface SaveAnnouncementInput {
  id?: string;
  title: string;
  category: string;
  subject: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  smsBody?: string;
  dltTemplateId?: string;
  channels: { email: boolean; sms: boolean };
  audience: unknown;
}

/**
 * Create or update a draft.
 *
 * ★ A SENT ANNOUNCEMENT IS IMMUTABLE. Editing the copy of something already in
 * people's inboxes makes the log a record of what we *currently say* we sent,
 * which is worth nothing. The same rule the billing invoices follow.
 */
export async function saveAnnouncement(
  input: SaveAnnouncementInput,
): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (!viewer) return { error: "Not authorized." };

  const title = input.title.trim().slice(0, 200);
  if (!title) return { error: "Give it a name." };

  const subject = input.subject.trim().slice(0, 200);
  const category: AnnouncementCategory =
    input.category === "operational" ? "operational" : "feature";
  // Sanitized on write AND on render — the blog trust model (§11).
  const body = sanitizeBlogContent(input.body).slice(0, 100_000);
  const audience = normalizeAudience(input.audience);

  // At least one channel, or this is a note to nobody.
  const channels = {
    email: input.channels?.email !== false,
    sms: input.channels?.sms === true,
  };
  if (!channels.email && !channels.sms) {
    return { error: "Pick at least one channel." };
  }

  const values = {
    title,
    category,
    subject,
    body,
    ctaLabel: input.ctaLabel?.trim().slice(0, 60) || null,
    ctaUrl: input.ctaUrl?.trim().slice(0, 500) || null,
    smsBody: input.smsBody?.trim().slice(0, 1000) || null,
    dltTemplateId: input.dltTemplateId?.trim().slice(0, 60) || null,
    channels,
    audience,
    updatedAt: new Date().toISOString(),
  };

  try {
    const id = await withService(async (db) => {
      if (input.id) {
        const updated = await db
          .update(platformAnnouncements)
          .set(values)
          // The immutability guard, as a predicate rather than a read-then-write:
          // a send that starts between the check and the update cannot slip past.
          .where(
            sql`${platformAnnouncements.id} = ${input.id}::uuid and ${platformAnnouncements.status} = 'draft'`,
          )
          .returning({ id: platformAnnouncements.id });
        return updated[0]?.id ?? null;
      }
      const created = await db
        .insert(platformAnnouncements)
        .values({ ...values, createdBy: viewer.email })
        .returning({ id: platformAnnouncements.id });
      return created[0]?.id ?? null;
    });

    if (!id) {
      return {
        error: input.id
          ? "This announcement has already been sent, so its copy is locked."
          : "Couldn't save.",
      };
    }

    revalidatePath("/dashboard/announcements");
    return { success: true, id };
  } catch (error) {
    logError("saveAnnouncement failed", error);
    return { error: "Couldn't save the announcement." };
  }
}

export async function deleteAnnouncement(id: string): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can delete an announcement." };
  }
  try {
    // Drafts only. A sent announcement is the record that it went out, and
    // deleting it destroys the answer to "who did we tell, and when?".
    const deleted = await withService((db) =>
      db
        .delete(platformAnnouncements)
        .where(
          sql`${platformAnnouncements.id} = ${id}::uuid and ${platformAnnouncements.status} = 'draft'`,
        )
        .returning({ id: platformAnnouncements.id }),
    );
    if (!deleted[0]) {
      return { error: "Only a draft can be deleted." };
    }
    revalidatePath("/dashboard/announcements");
    return { success: true };
  } catch (error) {
    logError("deleteAnnouncement failed", error, { id });
    return { error: "Couldn't delete it." };
  }
}

/** Who this would reach, running the same rules the send will. */
export async function previewAnnouncementAudience(
  audience: unknown,
  category: string,
  channels: { email: boolean; sms: boolean },
): Promise<AudiencePreview> {
  const empty: AudiencePreview = {
    reach: { email: 0, sms: 0 },
    matched: 0,
    skipped: {
      no_email: 0,
      no_phone: 0,
      suppressed: 0,
      no_consent: 0,
      duplicate: 0,
    },
    sample: [],
    ok: false,
  };
  if (!(await getPlatformViewer())) return empty;

  return previewAudience(
    normalizeAudience(audience),
    category === "operational" ? "operational" : "feature",
    {
      email: channels?.email !== false,
      sms: channels?.sms === true,
    },
  );
}

/**
 * Send one copy to the operator, to their own address.
 *
 * ★ THE ADDRESS IS THE SESSION'S, NEVER AN ARGUMENT. A test-send taking a
 * recipient would be an open relay: any signed-in operator could mail
 * arbitrary HTML to any address from StoreMink's verified sending domain.
 */
export async function sendAnnouncementTest(id: string): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (!viewer) return { error: "Not authorized." };

  const announcement = await getAnnouncement(id);
  if (!announcement) return { error: "Announcement not found." };

  const { subject, html } = renderAnnouncementEmail({
    brand: PLATFORM_BRAND,
    subject: announcement.subject || announcement.title,
    bodyHtml: announcement.body,
    ctaLabel: announcement.ctaLabel,
    ctaUrl: announcement.ctaUrl,
    category: announcement.category,
    preferencesUrl: `${PLATFORM_URL}/dashboard/settings/account`,
    recipientName: null,
  });

  const result = await sendEmail({
    storeId: null,
    to: viewer.email,
    from: `StoreMink <hello@${PLATFORM_EMAIL_DOMAIN}>`,
    subject: `[Test] ${subject}`,
    html,
    mailer: "announcement",
  });

  if (!result.sent) {
    return { error: result.error ?? "Couldn't send the test." };
  }
  return { success: true };
}

/**
 * Resolve the audience and start sending.
 *
 * ★ SUPERADMIN ONLY. This is the one action that reaches every merchant on the
 * platform, and it cannot be recalled once the worker starts.
 *
 * ★ SMS IS REFUSED WITH ITS REASON RATHER THAN QUEUED. Accepting it would
 * write recipient rows for messages every carrier drops silently, and the log
 * would show them as pending forever. See lib/announcements/sms-availability.ts.
 */
export async function sendAnnouncement(id: string): Promise<ActionResult> {
  const viewer = await getPlatformViewer();
  if (viewer?.role !== "superadmin") {
    return { error: "Only a platform superadmin can send an announcement." };
  }

  const announcement = await getAnnouncement(id);
  if (!announcement) return { error: "Announcement not found." };
  if (announcement.status !== "draft") {
    return { error: "This announcement has already been sent." };
  }
  if (!announcement.subject.trim()) {
    return { error: "Add a subject line before sending." };
  }
  if (!announcement.body.trim()) {
    return { error: "Add some copy before sending." };
  }

  let channels = announcement.channels;
  if (channels.sms) {
    const availability = smsAvailability(announcement.dltTemplateId);
    if (!availability.available) {
      return { error: `SMS can't be sent: ${availability.reason}` };
    }
  }
  // Belt and braces: even if the check above ever changes, nothing writes SMS
  // recipient rows while there is no platform sender.
  if (channels.sms && !smsAvailability(announcement.dltTemplateId).available) {
    channels = { ...channels, sms: false };
  }

  const result = await materialiseRecipients(
    id,
    announcement.audience,
    announcement.category,
    channels,
  );
  if (result.error) return { error: result.error };

  // Kick the worker so "send" means seconds, not the next heartbeat.
  await triggerEmailWorker().catch(() => {});

  revalidatePath("/dashboard/announcements");
  revalidatePath(`/dashboard/announcements/${id}`);
  return { success: true };
}

export interface AnnouncementRecipientRow {
  id: string;
  channel: string;
  email: string | null;
  name: string | null;
  status: string;
  error: string | null;
  sentAt: string | null;
}

/** The send log for one announcement: who was told, and what happened. */
export async function getAnnouncementRecipients(
  id: string,
  status?: string,
): Promise<AnnouncementRecipientRow[]> {
  if (!(await getPlatformViewer())) return [];
  const valid = ["pending", "sending", "sent", "failed", "skipped"];
  const filter = status && valid.includes(status) ? status : null;

  try {
    const rows = await withService((db) =>
      db
        .select({
          id: platformAnnouncementRecipients.id,
          channel: platformAnnouncementRecipients.channel,
          email: platformAnnouncementRecipients.email,
          name: platformAnnouncementRecipients.name,
          status: platformAnnouncementRecipients.status,
          error: platformAnnouncementRecipients.error,
          sentAt: platformAnnouncementRecipients.sentAt,
        })
        .from(platformAnnouncementRecipients)
        .where(
          filter
            ? sql`${platformAnnouncementRecipients.announcementId} = ${id}::uuid and ${platformAnnouncementRecipients.status} = ${filter}`
            : sql`${platformAnnouncementRecipients.announcementId} = ${id}::uuid`,
        )
        .orderBy(desc(platformAnnouncementRecipients.createdAt))
        .limit(500),
    );
    return rows as AnnouncementRecipientRow[];
  } catch (error) {
    logError("getAnnouncementRecipients failed", error, { id });
    return [];
  }
}
