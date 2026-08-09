// ---------------------------------------------------------------------------
// The code a customer shows at the counter to collect an order (roadmap Step 3).
//
// ★ IT IS A LOOKUP KEY, NOT A BEARER TOKEN. Access control stays what it has
// always been — the order UUID plus the store scope (CODEBASE §14). This code
// only has to FIND the order at a counter where an operator is already
// authenticated and can see whose order it is. That is why it can be short
// enough to read aloud.
//
// ★ BUT IT IS STILL RANDOM. `order_ref` is sequential and guessable, so using
// it would let anyone standing at a counter name somebody else's collection and
// see who it belongs to. Random costs nothing here and removes that entirely.
//
// ★ CROCKFORD BASE32, because this gets read off a phone screen in a shop and
// typed by someone who cannot see it. The alphabet drops I, L, O and U — the
// characters people confuse with 1, 1, 0, and the one Crockford removes to
// avoid accidental obscenity — and `normalizeCollectionCode` folds the
// confusions back in on the way in, so a customer reading "0" as "O" still
// finds their order.
// ---------------------------------------------------------------------------

/** Crockford's base32 alphabet: no I, L, O or U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Long enough that guessing one is pointless, short enough to say out loud.
 *  32^8 ≈ 1.1e12 — and a guess still has to be a code at THIS shop, today. */
export const COLLECTION_CODE_LENGTH = 8;

/**
 * A fresh code. Takes its randomness as an injected function so the generator
 * is testable — the caller passes `crypto.getRandomValues`.
 *
 * ★ REJECTION SAMPLING, not `% 32`. A byte is 0–255, which is not a multiple of
 * 32... except it is (256 = 8 × 32), so modulo is uniform here. It is written
 * as an explicit mask anyway: the moment the alphabet changes length, `%` would
 * silently start biasing the first few characters, and nothing would fail.
 */
export function generateCollectionCode(
  randomBytes: (n: number) => Uint8Array,
  length: number = COLLECTION_CODE_LENGTH,
): string {
  const out: string[] = [];
  // Over-draw so a rejected byte doesn't need a second round trip.
  let pool = randomBytes(length * 2);
  let i = 0;
  while (out.length < length) {
    if (i >= pool.length) {
      pool = randomBytes(length * 2);
      i = 0;
    }
    const b = pool[i++] & 0b0001_1111; // 0–31
    if (b < ALPHABET.length) out.push(ALPHABET[b]);
  }
  return out.join("");
}

/**
 * Fold a typed or scanned code back to canonical form.
 *
 * ★ THIS IS WHY THE ALPHABET WAS CHOSEN. Someone reads "PK0M" off a phone and
 * types "PKOM"; a scanner picks up a lowercase URL fragment; somebody adds the
 * hyphen they think they saw. All three should find the order rather than
 * producing "not found" at a counter with a customer waiting.
 */
export function normalizeCollectionCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return (
    raw
      .trim()
      .toUpperCase()
      // Anything that isn't alphanumeric is presentation — spaces, hyphens, and
      // the "#" people prefix a reference with.
      .replace(/[^A-Z0-9]/g, "")
      .replace(/[ILil]/g, "1")
      .replace(/[Oo]/g, "0")
      // U is not in the alphabet at all; the only thing it can plausibly be is V.
      .replace(/[Uu]/g, "V")
  );
}

/** Does this look like one of our codes? Cheap pre-check before a DB lookup. */
export function isCollectionCode(raw: unknown): boolean {
  const code = normalizeCollectionCode(raw);
  if (code.length !== COLLECTION_CODE_LENGTH) return false;
  return [...code].every((c) => ALPHABET.includes(c));
}

/** "PK0M-3T9V" — grouped for reading aloud and copying off a screen. The stored
 *  value is never hyphenated; this is display only. */
export function formatCollectionCode(code: string): string {
  const c = normalizeCollectionCode(code);
  if (c.length !== COLLECTION_CODE_LENGTH) return c;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
