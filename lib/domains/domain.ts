// ---------------------------------------------------------------------------
// Custom domain rules — pure, so every rejection is testable without DNS, a
// gateway, or a database.
//
// This is the front door of the connect flow. Everything downstream (the DNS
// challenge, the certificate, the serving gate) assumes the domain string is
// already normalised and sane, so normalisation happens exactly once, here.
// ---------------------------------------------------------------------------

import { ROOT_DOMAIN } from "@/lib/store/host";

/** Longest legal hostname, and longest legal label, per RFC 1035. */
const MAX_HOSTNAME = 253;
const MAX_LABEL = 63;

/**
 * Reduce whatever the merchant pasted to a bare, comparable hostname.
 *
 * People paste "https://shop.acme.com/", "WWW.Acme.com", "shop.acme.com."
 * and "shop.acme.com:443". All five are the same domain, and storing them
 * differently would break the UNIQUE index that stops two stores claiming one
 * domain — the check is a string comparison, so it is only as good as this.
 *
 * Returns null when nothing usable is left.
 */
export function normalizeDomain(
  input: string | null | undefined,
): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;

  // Strip a scheme and anything from the first path/query/fragment onward.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0] ?? "";
  // Strip credentials and a port.
  s = s.split("@").pop() ?? "";
  s = s.split(":")[0] ?? "";
  // A trailing dot is a legal FQDN but not how we store or compare.
  s = s.replace(/\.+$/, "");
  if (!s) return null;

  // IDN → punycode. Certificates and the Host header are ASCII, so a merchant
  // typing "café.fr" must be stored as the xn-- form the browser will send.
  try {
    const url = new URL(`http://${s}`);
    s = url.hostname;
  } catch {
    return null;
  }

  return s || null;
}

export type DomainRejection =
  | "invalid"
  | "not_a_domain"
  | "too_long"
  | "ip_address"
  | "wildcard"
  | "platform_domain"
  | "reserved";

export interface DomainCheck {
  ok: boolean;
  domain?: string;
  reason?: DomainRejection;
  /** Merchant-facing explanation. */
  message?: string;
}

const MESSAGES: Record<DomainRejection, string> = {
  invalid: "That doesn't look like a valid domain name.",
  not_a_domain:
    "Enter a full domain, like shop.example.com or example.com — not just a name.",
  too_long: "That domain name is too long.",
  ip_address: "Enter a domain name, not an IP address.",
  wildcard:
    "Wildcard domains aren't supported. Connect each domain you want to use.",
  platform_domain: `You already have a free ${ROOT_DOMAIN} address — connect a domain you own instead.`,
  reserved: "That domain can't be used.",
};

// Hostnames that resolve to the machine itself or to nothing. Connecting one
// can't work, and "localhost" in particular would be a confusing way to point a
// storefront at every visitor's own computer.
const RESERVED = new Set(["localhost", "local", "test", "invalid", "example"]);

/**
 * Validate a normalised domain for use as a storefront address.
 *
 * Note what is NOT checked here: whether the merchant owns it, whether DNS
 * points at us, and whether anyone else has claimed it. Those need the network
 * and the database — this is only the cheap, deterministic half.
 */
export function validateDomain(input: string | null | undefined): DomainCheck {
  const domain = normalizeDomain(input);
  const reject = (reason: DomainRejection): DomainCheck => ({
    ok: false,
    reason,
    message: MESSAGES[reason],
  });

  if (!domain) return reject("invalid");
  if (domain.length > MAX_HOSTNAME) return reject("too_long");
  if (domain.includes("*")) return reject("wildcard");

  // `new URL` renders an IPv6 host in brackets, and an IPv4 host survives as
  // digits. Neither can be issued a certificate here.
  if (domain.startsWith("[") || /^\d+(\.\d+)*$/.test(domain)) {
    return reject("ip_address");
  }

  const labels = domain.split(".");
  if (labels.length < 2) {
    return RESERVED.has(domain) ? reject("reserved") : reject("not_a_domain");
  }
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL) return reject("invalid");
    // Letters, digits and inner hyphens only — punycode's "xn--" prefix is
    // covered by allowing hyphens away from the edges.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
      return reject("invalid");
  }

  // A TLD that is all digits means this was an IP-like string that slipped past
  // the numeric test (e.g. "1.2.3.four" is fine, "1.2.3.4" is not a domain).
  const tld = labels[labels.length - 1]!;
  if (/^\d+$/.test(tld)) return reject("ip_address");
  if (RESERVED.has(tld)) return reject("reserved");

  // Our own namespace. Every store already has {slug}.storemink.com, that host
  // is served by the wildcard certificate, and letting a merchant "connect" one
  // would collide with subdomain routing in proxy.ts — the store-subdomain
  // branch matches first, so the connection could never take effect anyway.
  const root = ROOT_DOMAIN.toLowerCase();
  if (domain === root || domain.endsWith(`.${root}`)) {
    return reject("platform_domain");
  }

  return { ok: true, domain };
}

/**
 * The DNS records a merchant must create, given the load balancer's address.
 *
 * An A record for every domain, apex or subdomain alike. A CNAME would be the
 * conventional choice for a subdomain, but telling apex and subdomain apart
 * needs the Public Suffix List — "acme.co.uk" is an apex with three labels,
 * "shop.acme.com" is a subdomain with three labels, and nothing about the
 * string distinguishes them. Since the load balancer sits on a reserved
 * anycast IP that does not change, an A record is correct in both cases and
 * removes the whole class of error.
 */
export interface DnsRecord {
  type: "A" | "CNAME" | "TXT";
  /** Host portion as most DNS UIs want it (@ for the domain itself). */
  name: string;
  value: string;
  purpose: "routing" | "certificate";
}

export function routingRecords(domain: string, lbIp: string): DnsRecord[] {
  const labels = domain.split(".");
  // Best-effort host portion for the merchant's DNS UI. Two labels is always
  // the domain itself; more MAY be a subdomain, and showing the leading label
  // is right far more often than showing "@".
  const name = labels.length <= 2 ? "@" : labels.slice(0, -2).join(".");
  return [{ type: "A", name, value: lbIp, purpose: "routing" }];
}
