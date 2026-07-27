// ---------------------------------------------------------------------------
// Template rendering — merchant-authored {{variable}} copy.
//
// Pure, and deliberately NOT a general template language. There are no
// conditionals, loops, filters, or expressions: a merchant is writing an email
// subject, not a program, and every feature added here becomes a way to break
// (or exploit) an email that goes out under the store's name.
//
// THREE SAFETY RULES:
//  1. VALUES ARE ESCAPED for the target format. Substituted values come from
//     the database (customer names, product names) and go into HTML.
//  2. UNKNOWN VARIABLES ARE REJECTED AT SAVE TIME, not silently blanked at
//     send time — a merchant finds out while they're editing, not from a
//     customer.
//  3. A MISSING VALUE AT SEND TIME renders as empty rather than the literal
//     "{{token}}", so a template can never leak its own plumbing into an inbox.
// ---------------------------------------------------------------------------

import { escapeHtml } from "@/lib/email/coupon-campaign";
import { variableNamesFor } from "./variables";

/** {{ token }} — whitespace tolerated, token limited to a safe charset. */
const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type TemplateFormat = "text" | "html";

/**
 * Substitute values into a template.
 *
 * `format: "html"` escapes each value (the default for message bodies).
 * `format: "text"` is for subject lines, which are not HTML — escaping there
 * would put `&amp;` in front of a shopper.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string | number | null | undefined>,
  format: TemplateFormat = "html",
): string {
  if (!template) return "";
  return template.replace(TOKEN, (_match, name: string) => {
    const value = values[name];
    if (value === null || value === undefined) return "";
    const text = String(value);
    return format === "html" ? escapeHtml(text) : text;
  });
}

/** Every distinct token used in a template, in order of first appearance. */
export function extractVariables(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(TOKEN)) {
    const name = match[1];
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

export interface TemplateValidation {
  valid: boolean;
  /** Tokens this event doesn't provide — the merchant is told at save time. */
  unknown: string[];
  error?: string;
}

/** Bounds: a subject that long is a mistake, and a body that long is an attack. */
const MAX_SUBJECT = 300;
const MAX_BODY = 50_000;

/**
 * Check a template against the variables its event actually provides.
 * Returns the unknown tokens rather than throwing, so the console can point at
 * each one.
 */
export function validateTemplate(
  template: string,
  eventKey: string,
  kind: "subject" | "body" = "body",
): TemplateValidation {
  const limit = kind === "subject" ? MAX_SUBJECT : MAX_BODY;
  if (template.length > limit) {
    return {
      valid: false,
      unknown: [],
      error: `That ${kind} is too long (max ${limit.toLocaleString()} characters).`,
    };
  }

  const allowed = variableNamesFor(eventKey);
  const unknown = extractVariables(template).filter((v) => !allowed.has(v));
  if (unknown.length > 0) {
    return {
      valid: false,
      unknown,
      error:
        unknown.length === 1
          ? `This notification doesn't provide {{${unknown[0]}}}.`
          : `This notification doesn't provide ${unknown
              .map((u) => `{{${u}}}`)
              .join(", ")}.`,
    };
  }
  return { valid: true, unknown: [] };
}

/**
 * Build the value map for a real send, from the event envelope + payload.
 * Only the variables declared for the event are exposed, so a payload key that
 * was never documented can't be reached from a template.
 */
export function templateValues(
  eventKey: string,
  envelope: {
    storeName?: string | null;
    actorLabel?: string | null;
    subjectLabel?: string | null;
    eventName?: string | null;
    date?: string | null;
    link?: string | null;
  },
  payload: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const allowed = variableNamesFor(eventKey);
  const values: Record<string, string> = {};

  const base: Record<string, string | null | undefined> = {
    store_name: envelope.storeName,
    actor_name: envelope.actorLabel,
    subject_label: envelope.subjectLabel,
    event_name: envelope.eventName,
    date: envelope.date,
    link: envelope.link,
  };
  for (const [name, value] of Object.entries(base)) {
    if (allowed.has(name) && value != null) values[name] = String(value);
  }

  // Payload keys are camelCase at the call sites but snake_case in templates
  // (daysLeft → {{days_left}}), which is the convention merchants see.
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (value === null || value === undefined) continue;
    const name = camelToSnake(key);
    if (!allowed.has(name)) continue;
    values[name] = String(value);
  }

  return values;
}

function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
