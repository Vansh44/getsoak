// Showing a person's name when what got stored might not be one.
//
// `orders.cashier_name` is a SNAPSHOT taken at sale time — it has to be, so an
// old receipt still says who served, even after that person leaves. The cost of
// a snapshot is that a bad value is permanent: sales rung before
// `ownerDisplayName` existed stored the owner's login EMAIL, and that prints on
// the customer's receipt.
//
// So the guard belongs at RENDER, not only in the write path. Fixing the writer
// stops new bad rows; it does nothing for the ones already on file, and those
// are exactly the ones a reprint hands to a customer.

/**
 * A name safe to print. An email address is reduced to its local part —
 * a customer's receipt should never carry someone's full address, and
 * "vansh.gupta" is at least recognisable as a person.
 *
 * Anything that isn't an email is returned untouched: this corrects a known
 * bad shape, it does not try to prettify real names.
 */
export function personLabel(name: string | null | undefined): string | null {
  const v = (name ?? "").trim();
  if (!v) return null;
  const at = v.indexOf("@");
  // A dotted domain after the "@" is what distinguishes an address from a name
  // that happens to contain the character ("DJ @ Night").
  if (at >= 0 && v.slice(at + 1).includes(".")) {
    // An empty local part ("@example.com") leaves nothing worth printing —
    // better a blank than a bare domain on someone's receipt.
    return v.slice(0, at).replace(/[._]+/g, " ").trim() || null;
  }
  return v;
}
