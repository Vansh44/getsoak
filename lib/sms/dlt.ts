// ---------------------------------------------------------------------------
// India's DLT rules for commercial SMS — PURE, so the whole thing is testable
// without a provider account, a merchant registration, or a phone.
//
// ── ★★ WHY SMS IS NOT "JUST UNLOCK THE CHANNEL" ────────────────────────────
// TRAI's TCCCPR requires every business sending commercial SMS to Indian
// numbers to register on a DLT (Distributed Ledger Technology) portal run by
// the operators. THREE things are registered, and all three are per-BUSINESS:
//
//   1. the Principal Entity (a PE-ID),
//   2. the sender header — 6 characters, alphabetic for transactional mail,
//   3. every message TEMPLATE, with its variables marked.
//
// A message whose body does not match an approved template, or whose header is
// not registered to that entity, is **blocked at the carrier** — it does not
// bounce, it does not error usefully, it simply never arrives. Registration
// takes 7–21 business days.
//
// ── ★ SO SMS IS BYO PER STORE, LIKE RAZORPAY (§18), NOT PLATFORM-WIDE LIKE
// EMAIL (§24). StoreMink cannot send on a merchant's behalf from a generic
// header: the header IS the merchant's registered identity. This is a
// regulatory fact, not a design preference, and it is why there is no
// "turn on SMS" switch that could ever work on its own.
//
// ── ★★ AND IT BREAKS THE FREE-TEXT TEMPLATE MODEL ──────────────────────────
// §24's merchant templates are free text with `{{token}}` substitution, checked
// only for unknown tokens. DLT is the opposite: the body is FIXED at
// registration and only the marked variables may differ. So an SMS body cannot
// be authored in the notification console the way an email body is — it has to
// be authored on the DLT portal, approved, and then MIRRORED here with its
// template id. `renderDltBody` is what keeps the mirror honest.
//
// ⚠ WHAT IS DELIBERATELY NOT ENCODED HERE. Operators differ on the maximum
// number of variables per template (commonly cited as 2) and on whether a
// variable may open a message. Those are asserted inconsistently across
// operator documentation, and a rule invented here would reject templates the
// merchant's own portal approved — which is worse than not checking, because
// the merchant cannot tell whose rule they broke. What IS universal, and IS
// enforced below: the body must match the approved template apart from its
// variables, and a variable may not end the message.
// ---------------------------------------------------------------------------

/** DLT marks a substitution point as `{#var#}`. */
export const DLT_VARIABLE = "{#var#}";

const VARIABLE_RE = /\{#var#\}/g;

export interface DltTemplate {
  /** The id the DLT portal issued. Sent to the provider on every message. */
  templateId: string;
  /** The approved body, with `{#var#}` at each substitution point. */
  body: string;
}

export type DltTemplateCheck =
  | { ok: true; variables: number }
  | { ok: false; error: string };

/**
 * Is this a template the carrier will accept messages against?
 *
 * ★ IT VALIDATES THE MIRROR, NOT THE REGISTRATION. The merchant's DLT portal is
 * the authority on what was approved; this only catches the ways a mirrored
 * copy goes wrong — an empty body, a missing id, or a trailing variable, which
 * operators reject because it makes a message's end forgeable.
 */
export function checkDltTemplate(template: DltTemplate): DltTemplateCheck {
  const id = template.templateId?.trim() ?? "";
  const body = template.body ?? "";

  if (!id) return { ok: false, error: "The DLT template ID is required." };
  if (!body.trim()) return { ok: false, error: "The template body is empty." };

  const variables = (body.match(VARIABLE_RE) ?? []).length;

  // A variable at the very end is rejected by operators: it leaves the message
  // with no fixed tail, so what a recipient reads last is entirely sender-
  // controlled. Trailing whitespace does not rescue it.
  if (body.trimEnd().endsWith(DLT_VARIABLE)) {
    return {
      ok: false,
      error: `A template cannot end with ${DLT_VARIABLE}. Put fixed text after it — the store name usually works.`,
    };
  }

  return { ok: true, variables };
}

export type DltRender =
  | { ok: true; body: string }
  | { ok: false; error: string };

/**
 * Fill an approved template's variables, in order.
 *
 * ★★ POSITIONAL, NOT NAMED, BECAUSE DLT IS. `{#var#}` carries no name — the
 * portal approves a shape, and the Nth variable is whatever the merchant said
 * the Nth variable was. Mapping our named event values onto it is the caller's
 * job (see the per-event variable order stored alongside the template), and it
 * is exactly where a mirror drifts from a registration.
 *
 * ★ THE COUNT MUST MATCH EXACTLY. Too few leaves a literal `{#var#}` in the
 * message a customer reads; too many silently drops information the merchant
 * meant to send. Both are refused rather than patched over, because a message
 * that goes out wrong cannot be recalled.
 */
export function renderDltBody(
  template: DltTemplate,
  values: readonly string[],
): DltRender {
  const check = checkDltTemplate(template);
  if (!check.ok) return { ok: false, error: check.error };

  if (values.length !== check.variables) {
    return {
      ok: false,
      error: `This template takes ${check.variables} value${
        check.variables === 1 ? "" : "s"
      }, but ${values.length} ${values.length === 1 ? "was" : "were"} supplied.`,
    };
  }

  let index = 0;
  const body = template.body.replace(VARIABLE_RE, () => {
    // Newlines would let a value forge what looks like a second message, and
    // the carrier counts every character against the segment budget.
    return String(values[index++] ?? "")
      .replace(/[\r\n]+/g, " ")
      .trim();
  });

  return { ok: true, body };
}

/**
 * Does a rendered body still match the template it claims to come from?
 *
 * The carrier asks this, so we ask it first: a body that drifted from its
 * approved template is blocked silently, and "the customer never got the
 * message" is not a diagnosis anyone can act on. Returns true when every fixed
 * segment of the template appears, in order.
 */
export function bodyMatchesTemplate(
  template: DltTemplate,
  body: string,
): boolean {
  const fixed = template.body.split(VARIABLE_RE);
  let cursor = 0;
  for (const segment of fixed) {
    if (!segment) continue;
    const at = body.indexOf(segment, cursor);
    if (at === -1) return false;
    cursor = at + segment.length;
  }
  return true;
}

/**
 * A transactional sender header, or null.
 *
 * SIX characters, alphabetic — that is the transactional/service form. Numeric
 * headers are the promotional ones, which a shop's order updates are not.
 * Upper-cased because the portals issue and match them that way.
 */
export function normalizeSenderHeader(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  return /^[A-Z]{6}$/.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Segments — what a message COSTS.
// ---------------------------------------------------------------------------

/**
 * How many SMS segments a body will be billed as.
 *
 * ★ ONE NON-GSM CHARACTER RE-PRICES THE WHOLE MESSAGE. GSM-7 fits 160
 * characters per segment; a single character outside that set (an emoji, a
 * rupee sign, curly quotes pasted from a word processor) forces the entire
 * message to UCS-2 at **70**. So a 150-character template costs one segment
 * until someone types ₹, and then it costs three. Merchants are billed per
 * segment, which makes this the difference between a working budget and a
 * surprise.
 */
export function smsSegments(body: string): number {
  if (!body) return 0;
  const unicode = !isGsm7(body);
  const perSegment = unicode ? 70 : 160;
  // Concatenated messages spend 6-7 characters per part on the UDH header.
  const perConcat = unicode ? 67 : 153;
  const length = unicode ? body.length : gsm7Length(body);
  if (length <= perSegment) return 1;
  return Math.ceil(length / perConcat);
}

/** These occupy TWO characters each in a GSM-7 payload (escape + character). */
const GSM7_EXTENDED = "^{}\\[~]|€";
const GSM7_BASE =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

function isGsm7(body: string): boolean {
  for (const ch of body) {
    if (!GSM7_BASE.includes(ch) && !GSM7_EXTENDED.includes(ch)) return false;
  }
  return true;
}

function gsm7Length(body: string): number {
  let n = 0;
  for (const ch of body) n += GSM7_EXTENDED.includes(ch) ? 2 : 1;
  return n;
}
