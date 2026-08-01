// ---------------------------------------------------------------------------
// The legal document catalog — which policies StoreMink publishes.
//
// Pure data, the shape of lib/notifications/events.ts and the settings
// registry: the DB holds versions and bodies, this holds the list of documents
// that exist and what each one is for.
//
// ══ WHAT THIS IS NOT ══════════════════════════════════════════════════════
// These are STOREMINK's policies — the contract between the platform and a
// merchant, and between the platform and a shopper using it. A merchant's OWN
// store policies (their returns policy, their privacy notice) are ordinary
// store_pages rows written by the guided editor, deliberately NOT a second CMS.
// ---------------------------------------------------------------------------

export const LEGAL_KINDS = ["terms", "privacy", "acceptable-use"] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

export interface LegalDocDef {
  kind: LegalKind;
  /** URL segment under /legal. */
  slug: string;
  title: string;
  /** One line, used on the index and in the consent sentence. */
  summary: string;
  /**
   * Must this be accepted before an account can be created?
   *
   * Consent is only meaningful if it's specific, so the signup checkbox names
   * exactly these documents rather than gesturing at "our policies".
   */
  requiredAtSignup: boolean;
}

export const LEGAL_DOCS: LegalDocDef[] = [
  {
    kind: "terms",
    slug: "terms",
    title: "Terms of Service",
    summary: "The agreement between you and StoreMink.",
    requiredAtSignup: true,
  },
  {
    kind: "privacy",
    slug: "privacy",
    title: "Privacy Policy",
    summary: "What data we hold, why, and what you can ask us to do with it.",
    requiredAtSignup: true,
  },
  {
    kind: "acceptable-use",
    slug: "acceptable-use",
    title: "Acceptable Use Policy",
    summary: "What may and may not be sold or done through StoreMink.",
    // Accepted DIRECTLY, not merely incorporated by reference in the Terms.
    // One tick box names every required document, so adding this costs the
    // merchant nothing — it's a third name in the sentence, not a third box —
    // while making the document you actually enforce against (suspending a
    // store that sells prohibited goods) something they were shown and agreed
    // to, rather than something a clause in another document pointed at.
    requiredAtSignup: true,
  },
];

const BY_KIND = new Map(LEGAL_DOCS.map((d) => [d.kind, d]));
const BY_SLUG = new Map(LEGAL_DOCS.map((d) => [d.slug, d]));

export function getLegalDoc(kind: string): LegalDocDef | undefined {
  return BY_KIND.get(kind as LegalKind);
}

export function getLegalDocBySlug(slug: string): LegalDocDef | undefined {
  return BY_SLUG.get(slug);
}

/** The documents a new account must agree to. */
export function signupRequiredDocs(): LegalDocDef[] {
  return LEGAL_DOCS.filter((d) => d.requiredAtSignup);
}

/**
 * Stable fingerprint of a document body.
 *
 * An acceptance says "this person agreed to version 3"; the checksum is what
 * lets you prove version 3 still says what it said. Web Crypto so the same
 * function runs on the server and in a script.
 */
export async function checksumBody(body: string): Promise<string> {
  const data = new TextEncoder().encode(body.trim());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
