import { Resend } from "resend";
import { wrapBrandedEmail } from "./layout";
import { EMAIL_THEME } from "./shell";
import type { StoreBrand } from "@/lib/store/brand";

/** Escape user-supplied values before interpolating into email HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getResend(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  // Mirror blog-notifications.ts: skip sending when the key is missing or a
  // placeholder so local/dev environments don't error out.
  if (!apiKey || apiKey.includes("placeholder")) return null;
  return new Resend(apiKey);
}

/** Wraps body content in the shared branded layout + sign-off. */
function emailShell(bodyHtml: string, brand: StoreBrand): string {
  return wrapBrandedEmail(
    `${bodyHtml}
    <p style="margin-top:32px;">
      Warm regards,<br />
      <strong>Team ${escapeHtml(brand.name)}</strong>
    </p>`,
    brand,
  );
}

/**
 * Acknowledgement sent to a customer right after they submit an enquiry on the
 * storefront, echoing back what they sent. Best-effort: never throws, so a mail
 * failure can't fail the submission itself.
 */
export async function sendEnquiryAcknowledgementEmail(opts: {
  to: string;
  name: string;
  subject: string | null;
  message: string;
  brand: StoreBrand;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log(
      `📨 [enquiry ack] email skipped (Resend not configured) — to: ${opts.to}`,
    );
    return;
  }

  const trimmedSubject = opts.subject?.trim() || "";
  const subjectLine = trimmedSubject
    ? `We received your enquiry: "${trimmedSubject}"`
    : "We received your enquiry";

  try {
    const fromAddress = `${opts.brand.name} <admin@${opts.brand.domain}>`;
    const { data, error } = await resend.emails.send({
      from: fromAddress,
      to: opts.to,
      subject: subjectLine,
      html: emailShell(
        `
        <h2 style="margin-top: 0;">Thanks for reaching out!</h2>
        <p>Hi ${escapeHtml(opts.name)},</p>
        <p>
          We've received your enquiry and a member of the ${escapeHtml(opts.brand.name)} team will get
          back to you as soon as possible, usually within 1–2 business days.
        </p>
        <p style="margin: 24px 0 6px;">
          <strong>Here's a copy of what you sent us:</strong>
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_THEME.panel}; border:1px solid ${EMAIL_THEME.border}; border-radius:8px; margin:8px 0 4px;">
          <tr>
            <td style="padding:16px 18px; font-size:14px; color:${EMAIL_THEME.inkSoft}; line-height:1.6;">
              ${
                trimmedSubject
                  ? `<p style="margin:0 0 10px;"><strong>Subject:</strong> ${escapeHtml(trimmedSubject)}</p>`
                  : ""
              }
              <p style="margin:0; white-space:pre-wrap;">${escapeHtml(opts.message)}</p>
            </td>
          </tr>
        </table>
      `,
        opts.brand,
      ),
    });
    // Resend returns errors in the response body rather than throwing.
    if (error) {
      console.error("Resend rejected enquiry-ack email:", error);
    } else {
      console.log(
        `📨 [enquiry ack] email sent (id: ${data?.id}) — to: ${opts.to}`,
      );
    }
  } catch (e) {
    console.error("Failed to send enquiry-ack email via Resend:", e);
  }
}
