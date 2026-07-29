// Which postcodes a location will hand goods over to (roadmap Phase F.1).
//
// Pure: no DB, no request, no store. The rules are merchant-typed text, so
// everything here is about turning something a person wrote into something a
// checkout can answer in microseconds.
//
// ── Three forms, because one is unusable ────────────────────────────────────
// Mumbai is roughly a hundred postcodes. A merchant who can only type exact
// codes will type five, get it wrong, and blame the feature. So:
//
//   400001            exact
//   400*              prefix   — the one that makes this usable
//   400001-400104     range    — natural for contiguous numeric codes
//
// ── The two rules that keep it from losing sales ────────────────────────────
//   1. NO RULES = EVERYWHERE. An empty list is not "serves nobody", it is
//      "unconfigured", which must behave exactly as it did before this feature
//      existed. A migration may not change what a live store does.
//   2. AN UNKNOWN POSTCODE MATCHES. A first-time shopper hasn't typed their
//      address yet. Hiding collection from someone because we don't know where
//      they are is the failure mode this whole file exists to avoid.
//
// Both mean this function fails OPEN. It decides what is OFFERED, never what is
// permitted — `placeOrder` validates capability, store and stock, and
// deliberately does NOT refuse on a postcode. A merchant forgetting a suburb
// should cost them a listing, not a sale.

/** How many rules one location may store. A paste of a whole postcode
 *  directory is a mistake, not a configuration. */
export const MAX_PINCODE_RULES = 500;

const EXACT = /^[A-Z0-9]{3,10}$/;
const PREFIX = /^[A-Z0-9]{2,9}\*$/;
const RANGE = /^(\d{3,10})-(\d{3,10})$/;

/** Strip everything that isn't part of the code: spaces, hyphens in
 *  "SW1A 1AA", stray punctuation from a spreadsheet paste. */
export function normalizePincode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface ParsedPincodeRules {
  rules: string[];
  /** Tokens that aren't a code, a prefix or a range — shown back to the
   *  merchant rather than silently dropped, because a rule that vanished is a
   *  rule they think is protecting them. */
  invalid: string[];
}

/**
 * Turn a merchant's free text into canonical rules.
 *
 * Accepts anything a person plausibly types: commas, newlines, spaces, or a
 * column pasted out of a spreadsheet.
 */
export function parsePincodeRules(text: string): ParsedPincodeRules {
  const rules: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  // Close up the spaces around a hyphen BEFORE tokenising, so "400001 - 400104"
  // and "400001-400104" are the same rule rather than two bogus codes.
  const source = String(text ?? "").replace(/\s*-\s*/g, "-");

  for (const token of source.split(/[\s,;\n]+/)) {
    const raw = token.trim();
    if (!raw) continue;

    // Validate what they TYPED — don't strip first. Stripping punctuation and
    // then checking turns "oops!!" into the perfectly valid-looking code
    // "OOPS", so junk would be stored as a rule that silently matches nothing.
    const t = raw.toUpperCase();
    if (/[^A-Z0-9*-]/.test(t)) {
      invalid.push(raw);
      continue;
    }

    const range = RANGE.exec(t);
    if (range) {
      const [, from, to] = range;
      // Different lengths can't describe a contiguous band of codes, and
      // comparing them numerically would quietly include the wrong ones.
      if (from.length !== to.length || Number(from) > Number(to)) {
        invalid.push(raw);
        continue;
      }
    } else if (!EXACT.test(t) && !PREFIX.test(t)) {
      invalid.push(raw);
      continue;
    }

    if (!seen.has(t) && rules.length < MAX_PINCODE_RULES) {
      seen.add(t);
      rules.push(t);
    }
  }

  return { rules, invalid };
}

/** Canonical rules back into something a merchant can read and edit. */
export function formatPincodeRules(rules: string[] | null | undefined): string {
  return (rules ?? []).join(", ");
}

/**
 * Does this location hand goods over to this postcode?
 *
 * Fails OPEN in both directions — see the header. Never throws: it sits on the
 * checkout render path.
 */
export function matchesPincode(
  rules: string[] | null | undefined,
  pincode: string | null | undefined,
): boolean {
  if (!rules || rules.length === 0) return true; // unconfigured = everywhere
  const code = normalizePincode(pincode);
  if (!code) return true; // we don't know where they are yet

  for (const rule of rules) {
    if (rule.endsWith("*")) {
      if (code.startsWith(rule.slice(0, -1))) return true;
      continue;
    }
    const range = RANGE.exec(rule);
    if (range) {
      const [, from, to] = range;
      if (
        code.length === from.length &&
        /^\d+$/.test(code) &&
        Number(code) >= Number(from) &&
        Number(code) <= Number(to)
      ) {
        return true;
      }
      continue;
    }
    if (code === rule) return true;
  }
  return false;
}
