import { createHash } from "node:crypto";

/**
 * Hash an action payload independently of JavaScript/PostgreSQL JSON object-key
 * ordering. Arrays remain ordered because their position is business data.
 */
export function hashMinkActionPayload(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) {
    throw new TypeError("Mink action payload cannot be serialized.");
  }
  return createHash("sha256").update(encoded).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}
