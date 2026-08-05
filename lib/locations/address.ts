// How a LOCATION's address is shaped, in one place.
//
// ★ There are two address shapes in this codebase and they are not the same.
// A customer address (`customer_addresses`, `orders.shipping_address`) uses
// `addressLine1` / `addressLine2` / `country` / `phone`; a shop's address
// (`store_locations.address`) uses the five fields its editor writes —
// `line1`, `line2`, `city`, `state`, `postalCode` — and nothing else.
//
// Reading one with the other's keys fails SILENTLY: every field comes back
// undefined and simply doesn't render, so the "Collect from" card dropped the
// street line of every shop and nobody saw an error. Pure and tested, so both
// the card and the email derive from the same list.

/** The fields a location address actually stores (the editor's own set). */
export const LOCATION_ADDRESS_KEYS = [
  "line1",
  "line2",
  "city",
  "state",
  "postalCode",
] as const;

function field(a: Record<string, unknown>, key: string): string {
  const v = a[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * The shop's address as separate lines, for a card:
 * `["12 Radial Road", "Unit 4", "New Delhi, Delhi, 110001"]`.
 * Empty entries are dropped, so a shop with only a city renders one line.
 */
export function locationAddressLines(
  address: Record<string, unknown> | null | undefined,
): string[] {
  if (!address) return [];
  const town = [
    field(address, "city"),
    field(address, "state"),
    field(address, "postalCode"),
  ]
    .filter(Boolean)
    .join(", ");
  return [field(address, "line1"), field(address, "line2"), town].filter(
    Boolean,
  );
}

/**
 * The same address as ONE line, for an email row or an event payload — where
 * there is no room for a block and no markup to break it up.
 */
export function formatAddressLine(
  address: Record<string, unknown> | null | undefined,
): string {
  if (!address) return "";
  return LOCATION_ADDRESS_KEYS.map((k) => field(address, k))
    .filter(Boolean)
    .join(", ");
}
