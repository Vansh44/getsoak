import "server-only";

// ---------------------------------------------------------------------------
// "Does this domain actually point at us?"
//
// The certificate proves the merchant controls the domain's DNS. It does NOT
// prove they pointed the domain at our load balancer — those are different
// records, and a merchant can easily add the challenge CNAME and stop there.
// Marking such a domain verified would flip storeOrigin() onto an address that
// resolves somewhere else entirely, and every canonical URL, sitemap entry and
// og:url would then advertise a host we don't serve.
// ---------------------------------------------------------------------------

import { Resolver } from "node:dns/promises";
import { logError } from "@/lib/observability/logger";

/**
 * Public resolvers, queried instead of the container's own.
 *
 * Two reasons. The runtime resolver caches, so a merchant who fixed their DNS
 * a minute ago could keep failing verification for the length of a TTL they
 * cannot see. And what matters is what the INTERNET resolves, not what one
 * container does — these are the answers a visitor's browser would get.
 */
const PUBLIC_RESOLVERS = ["8.8.8.8", "1.1.1.1"];

export interface DnsCheck {
  /** The domain resolves to the expected load balancer address. */
  pointsToUs: boolean;
  /** What we actually saw, for a message the merchant can act on. */
  found: string[];
  error?: string;
}

/**
 * Check that `domain` resolves to `expectedIp` on the public internet.
 *
 * Answers from any one resolver are enough: disagreement between resolvers is
 * normal mid-propagation, and requiring unanimity would just make merchants
 * retry for no added safety — the certificate, not this, is the security
 * boundary. This check exists to stop us ADVERTISING a domain we don't serve.
 */
export async function checkDomainPointsTo(
  domain: string,
  expectedIp: string,
): Promise<DnsCheck> {
  const found = new Set<string>();
  let sawAnswer = false;

  for (const server of PUBLIC_RESOLVERS) {
    try {
      const resolver = new Resolver({ timeout: 5000, tries: 2 });
      resolver.setServers([server]);

      // A record first — what we tell merchants to create.
      const a = await resolver.resolve4(domain).catch(() => [] as string[]);
      a.forEach((ip) => found.add(ip));

      // A CNAME to something that lands on our IP is equally correct, and some
      // DNS providers flatten apex CNAMEs, so resolve the chain rather than
      // insisting on a literal A record the merchant may not have typed.
      if (a.length === 0) {
        const cname = await resolver
          .resolveCname(domain)
          .catch(() => [] as string[]);
        for (const target of cname) {
          const viaCname = await resolver
            .resolve4(target)
            .catch(() => [] as string[]);
          viaCname.forEach((ip) => found.add(ip));
        }
      }

      if (found.size > 0) {
        sawAnswer = true;
        break;
      }
    } catch (err) {
      // Try the next resolver before giving up.
      logError("checkDomainPointsTo", err, { domain, server });
    }
  }

  const list = [...found];
  if (!sawAnswer && list.length === 0) {
    return {
      pointsToUs: false,
      found: [],
      error:
        "We couldn't find a DNS record for this domain yet. New records can take a few minutes to appear.",
    };
  }

  if (!list.includes(expectedIp)) {
    return {
      pointsToUs: false,
      found: list,
      error: `This domain currently points to ${list.join(", ")}. Update its A record to ${expectedIp}.`,
    };
  }

  return { pointsToUs: true, found: list };
}
