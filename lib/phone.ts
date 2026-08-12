/**
 * Convert the Indian mobile formats accepted by the storefront into the
 * ten-digit national number Shiprocket expects.  Returning null (instead of a
 * best-effort slice) keeps malformed and obvious placeholder numbers from
 * becoming carrier work that can never be booked.
 */
export function normalizeIndianMobile(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const digits = value.replace(/\D/g, "");
  const national =
    digits.length === 12 && digits.startsWith("91")
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith("0")
        ? digits.slice(1)
        : digits;

  if (!/^[6-9]\d{9}$/.test(national)) return null;
  // Shiprocket rejects obvious placeholders such as 8888888888. Catch them at
  // our boundary so the customer can correct the number during checkout.
  if (/^(\d)\1{9}$/.test(national)) return null;

  return national;
}

export function formatIndianMobile(value: unknown): string | null {
  const mobile = normalizeIndianMobile(value);
  return mobile ? `+91${mobile}` : null;
}
