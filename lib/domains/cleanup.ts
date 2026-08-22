import "server-only";

import { Resend } from "resend";
import { removeAuthorizedDomain } from "@/lib/auth/authorized-domains";
import { logError } from "@/lib/observability/logger";
import { removeGoogleCustomDomain } from "@/lib/seo/search-engines";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { deprovision, getCertConfig } from "./certificates";

export interface DomainCleanupResult {
  failures: string[];
}

/**
 * Remove every StoreMink-managed external resource for a detached custom
 * domain. The operation is idempotent, so callers may safely retry it after a
 * partial control-plane failure.
 */
export async function cleanupDetachedDomain(
  domain: string | null,
  operation: string,
  legacyResendDomainId?: string | null,
): Promise<DomainCleanupResult> {
  const failures: string[] = [];

  if (domain) {
    if (!getCertConfig()) {
      failures.push("TLS certificate resources");
      logError(`${operation} (deprovision)`, undefined, {
        domain,
        reason: "custom-domain infrastructure is not configured",
      });
    } else {
      const gone = await deprovision(domain);
      if (gone.error) {
        failures.push("TLS certificate resources");
        logError(`${operation} (deprovision)`, gone.error, { domain });
      }
    }

    // Stop trusting a hostname we no longer serve for Google sign-in.
    const deauth = await removeAuthorizedDomain(domain, ROOT_DOMAIN);
    if (deauth.error) {
      failures.push("Identity Platform authorized domain");
      logError(`${operation} (deauthorize)`, deauth.error, { domain });
    }

    // The database write removes the public META token first. Google can then
    // release both the URL-prefix property and our ownership record.
    const google = await removeGoogleCustomDomain(domain);
    if (!google.searchConsole.ok && !google.searchConsole.skipped) {
      failures.push("Google Search Console property");
      logError(
        `${operation} (remove Search Console property)`,
        google.searchConsole.error,
        { domain, status: google.searchConsole.status },
      );
    }
    if (!google.siteVerification.ok && !google.siteVerification.skipped) {
      failures.push("Google Site Verification ownership");
      logError(
        `${operation} (remove Site Verification ownership)`,
        google.siteVerification.error,
        { domain, status: google.siteVerification.status },
      );
    }
  }

  // Storefront domains are no longer registered with Resend, but older stores
  // can still carry the provider id from that retired integration. Remove that
  // external resource too instead of dropping the only reference to it.
  if (legacyResendDomainId) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey || apiKey.includes("placeholder")) {
      failures.push("legacy Resend domain");
      logError(`${operation} (remove legacy Resend domain)`, undefined, {
        domain,
        resendDomainId: legacyResendDomainId,
        reason: "RESEND_API_KEY is not configured",
      });
    } else {
      try {
        const removed = await new Resend(apiKey).domains.remove(
          legacyResendDomainId,
        );
        if (removed.error && removed.error.statusCode !== 404) {
          failures.push("legacy Resend domain");
          logError(
            `${operation} (remove legacy Resend domain)`,
            removed.error,
            { domain, resendDomainId: legacyResendDomainId },
          );
        }
      } catch (err) {
        failures.push("legacy Resend domain");
        logError(`${operation} (remove legacy Resend domain)`, err, {
          domain,
          resendDomainId: legacyResendDomainId,
        });
      }
    }
  }

  return { failures };
}
