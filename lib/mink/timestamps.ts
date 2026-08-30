/** Canonical form for user-facing coupon dates; not for version checkpoints. */
export function canonicalMinkTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid timestamp");
  return new Date(timestamp).toISOString();
}

export function canonicalOptionalMinkTimestamp(
  value: string | null,
): string | null {
  return value === null ? null : canonicalMinkTimestamp(value);
}
