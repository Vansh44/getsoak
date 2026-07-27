import type { StoreBrand } from "@/lib/store/brand";
import { emailFooter, emailShell, inlineEmailStyles } from "./shell";

/**
 * Wrap an email body in the shared branded layout.
 *
 * A thin adapter over `emailShell` (lib/email/shell.ts), which is the ONE email
 * design — white card on light grey, near-black text, the store's logo or name
 * at the top. Every email type goes through the same shell now: coupon
 * campaigns, blog and enquiry notifications, billing, operator OTP, and the
 * notification spine.
 *
 * This used to render the store name in `brand.primaryColor`. It no longer
 * does: a storefront accent pushed into an email has to survive colour-managed
 * clients, forced dark mode, and a button that must stay legible at any hue a
 * merchant picks — and when it fails, a customer receives something that looks
 * broken. Identity comes from the logo instead. See the header of shell.ts.
 *
 * Kept as a named function with the original signature, so the five existing
 * callers inherit the new design without being touched.
 *
 * `bodyHtml` is dropped into the white content cell — include your own sign-off.
 */
export function wrapBrandedEmail(bodyHtml: string, brand: StoreBrand): string {
  return emailShell({
    brand,
    // These bodies are hand-written HTML that mostly carry their own inline
    // styles; inlineEmailStyles only fills in bare tags (a plain <p>, a list)
    // and leaves anything already styled alone.
    bodyHtml: inlineEmailStyles(bodyHtml),
    footerHtml: emailFooter(brand),
  });
}
