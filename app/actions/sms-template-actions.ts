"use server";

// ---------------------------------------------------------------------------
// Mirroring a store's DLT-approved SMS templates (§37).
//
// ── ★★ THIS IS NOT AN EMAIL TEMPLATE EDITOR ────────────────────────────────
// §24's merchant email templates are free text with `{{token}}` substitution,
// validated only for unknown tokens. A DLT body is FIXED at registration on the
// operator's portal and only its marked `{#var#}` points may vary — so what a
// merchant does here is MIRROR an approval that lives somewhere else, not
// author one.
//
// That distinction is the whole reason this is a separate action file rather
// than another field on `saveNotificationSettings`: saving here cannot change
// what a carrier will accept, only what we will send, and the two disagreeing
// is precisely how a message gets dropped with no error anywhere.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withService } from "@/lib/db/client";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { storeSmsTemplates } from "@/drizzle/schema";
import { checkDltTemplate, smsSegments } from "@/lib/sms/dlt";
import { getEventDef } from "@/lib/notifications/events";
// The SAME membership set the email template validator uses, so a token that
// works in an email body is not mysteriously rejected here.
import { variableNamesFor } from "@/lib/notifications/variables";
import { logError } from "@/lib/observability/logger";

export type SmsAudience = "team" | "customer";

export interface SmsTemplate {
  eventKey: string;
  audience: SmsAudience;
  dltTemplateId: string;
  body: string;
  /** Which named event value fills each `{#var#}`, in order. */
  variables: string[];
  enabled: boolean;
  /** Derived, never stored — what this template will cost per message. */
  segments: number;
}

export interface SmsTemplateResult {
  success?: boolean;
  error?: string;
}

export async function getSmsTemplates(
  eventKey: string,
): Promise<{ templates: SmsTemplate[]; error?: string }> {
  const userId = await getManagerUserId("notifications");
  if (!userId) return { templates: [], error: "You don't have permission." };

  const storeId = await getActingStoreId();
  try {
    const rows = await withService((db) =>
      db
        .select()
        .from(storeSmsTemplates)
        .where(
          and(
            eq(storeSmsTemplates.storeId, storeId),
            eq(storeSmsTemplates.eventKey, eventKey),
          ),
        ),
    );
    return {
      templates: rows.map((r) => ({
        eventKey: r.eventKey,
        audience: r.audience as SmsAudience,
        dltTemplateId: r.dltTemplateId,
        body: r.body,
        variables: Array.isArray(r.variables) ? (r.variables as string[]) : [],
        enabled: r.enabled,
        segments: smsSegments(r.body),
      })),
    };
  } catch (err) {
    logError("sms templates read failed", err, { storeId });
    return { templates: [], error: "Couldn't load the SMS templates." };
  }
}

/**
 * Save (or replace) one event's SMS template for one audience.
 *
 * ★ VALIDATED AGAINST THE DLT RULES ON SAVE, so a template that cannot work is
 * refused in front of the person pasting it rather than discovered as messages
 * that silently never arrive.
 */
export async function saveSmsTemplate(input: {
  eventKey: string;
  audience: SmsAudience;
  dltTemplateId: string;
  body: string;
  variables: string[];
}): Promise<SmsTemplateResult> {
  const userId = await getManagerUserId("notifications");
  if (!userId) return { error: "You don't have permission to do this." };

  const eventKey = (input.eventKey ?? "").trim();
  if (!getEventDef(eventKey)) {
    return { error: "That isn't a notification this store sends." };
  }
  if (input.audience !== "team" && input.audience !== "customer") {
    return { error: "Pick who this message is for." };
  }

  const dltTemplateId = (input.dltTemplateId ?? "").trim().slice(0, 64);
  const body = (input.body ?? "").slice(0, 1600);

  const shape = checkDltTemplate({ templateId: dltTemplateId, body });
  if (!shape.ok) return { error: shape.error };

  // ★ THE VARIABLE MAPPING MUST MATCH THE TEMPLATE'S SHAPE EXACTLY. DLT
  // variables are POSITIONAL and unnamed, so a mapping with the wrong length
  // renders either a literal `{#var#}` in a customer's message or drops a value
  // the merchant meant to send — and neither can be recalled.
  const variables = (input.variables ?? [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  if (variables.length !== shape.variables) {
    return {
      error: `This template has ${shape.variables} variable${
        shape.variables === 1 ? "" : "s"
      }, so pick ${shape.variables} value${shape.variables === 1 ? "" : "s"} to fill ${
        shape.variables === 1 ? "it" : "them"
      }.`,
    };
  }

  // Every mapped name must be something this event actually carries, or the
  // send resolves it to nothing and the message goes out with a gap in it.
  const known = variableNamesFor(eventKey);
  const unknown = variables.filter((v) => !known.has(v));
  if (unknown.length) {
    return {
      error: `${unknown.join(", ")} ${
        unknown.length === 1 ? "isn't a value" : "aren't values"
      } this notification carries.`,
    };
  }

  const storeId = await getActingStoreId();
  const fields = {
    dltTemplateId,
    body,
    variables,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };

  try {
    await withService((db) =>
      db
        .insert(storeSmsTemplates)
        .values({
          storeId,
          eventKey,
          audience: input.audience,
          ...fields,
        } as typeof storeSmsTemplates.$inferInsert)
        .onConflictDoUpdate({
          target: [
            storeSmsTemplates.storeId,
            storeSmsTemplates.eventKey,
            storeSmsTemplates.audience,
          ],
          set: fields,
        }),
    );
  } catch (err) {
    logError("sms template save failed", err, { storeId, eventKey });
    return { error: "Couldn't save that template. Try again." };
  }

  revalidatePath(`/dashboard/settings/notifications/${eventKey}`);
  return { success: true };
}

/**
 * Remove a mirror.
 *
 * ⚠ It does NOT touch the merchant's DLT registration — that lives on the
 * operator's portal and only they can withdraw it. All this does is stop us
 * sending this notification by SMS.
 */
export async function deleteSmsTemplate(input: {
  eventKey: string;
  audience: SmsAudience;
}): Promise<SmsTemplateResult> {
  const userId = await getManagerUserId("notifications");
  if (!userId) return { error: "You don't have permission to do this." };

  const storeId = await getActingStoreId();
  try {
    await withService((db) =>
      db
        .delete(storeSmsTemplates)
        .where(
          and(
            eq(storeSmsTemplates.storeId, storeId),
            eq(storeSmsTemplates.eventKey, input.eventKey),
            eq(storeSmsTemplates.audience, input.audience),
          ),
        ),
    );
  } catch {
    return { error: "Couldn't remove that template. Try again." };
  }
  revalidatePath(`/dashboard/settings/notifications/${input.eventKey}`);
  return { success: true };
}
