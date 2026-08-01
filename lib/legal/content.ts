// ---------------------------------------------------------------------------
// Version 1 of StoreMink's own policies.
//
// ⚠ NOT LEGAL ADVICE. This was written by an engineer, not a lawyer. It covers
// the risks this product structurally has — platform-not-seller, funds settling
// directly to merchants, merchant-as-data-controller, liability capped at fees
// — and it is a serious starting point, not a substitute for review by counsel
// qualified in the jurisdictions you operate in. Have it reviewed before you
// take real money. The `⚠ REVIEW` markers below flag the clauses where the
// wording most affects your exposure.
//
// WHY THE CONTENT LIVES IN CODE: it is reviewable in a diff, version-controlled
// alongside the product it describes, and seeded into legal_documents by an
// idempotent publish (lib/legal/seed.ts) the same way ensureHomepage() seeds a
// store_pages row. Once published, the DB row is the source of truth and is
// immutable — editing this file does not change what anyone already accepted.
// ---------------------------------------------------------------------------

export interface LegalContent {
  kind: string;
  title: string;
  version: number;
  body: string;
}

const COMPANY = "StoreMink";

/** House style: a section with a heading and paragraphs. */
function section(heading: string, ...paras: string[]): string {
  return `<h2>${heading}</h2>\n${paras.map((p) => `<p>${p}</p>`).join("\n")}`;
}

// ── Terms of Service ────────────────────────────────────────────────────────
const TERMS_BODY = [
  `<p><em>Last updated: 28 July 2026 · Version 1</em></p>`,

  section(
    "1. Who we are, and what this covers",
    `${COMPANY} provides software that lets you create and run an online store. These Terms are the agreement between you (the merchant) and ${COMPANY}. By creating an account you agree to them.`,
    `If you are agreeing on behalf of a company, you confirm you are authorised to bind that company, and "you" means that company.`,
  ),

  // ⚠ REVIEW — this is the single most important clause for your exposure.
  section(
    "2. We are a platform, not the seller",
    `${COMPANY} provides tools. <strong>You are the seller of every product listed in your store.</strong> You alone are responsible for your products, their description, pricing, legality, safety, quality, packaging, delivery, warranties, returns and after-sales support.`,
    `${COMPANY} is not a party to any contract between you and your customers. Any dispute about goods, delivery or refunds is between you and your customer. We may, but are not obliged to, provide information to help resolve such a dispute.`,
    `You are responsible for identifying yourself accurately to your customers, including your legal name, business address and contact details, and for issuing correct invoices and tax documents.`,
  ),

  // ⚠ REVIEW — this reflects the BYO-gateway model (CODEBASE §18).
  section(
    "3. Payments settle to you, not to us",
    `Where you connect your own payment gateway, your customers' payments settle <strong>directly to your account with that provider</strong>. ${COMPANY} does not receive, hold, or control those funds at any point, and does not act as a payment processor, escrow agent or money transmitter.`,
    `Your relationship with your payment provider is governed by your agreement with them. Chargebacks, settlement timing, holds and payout failures are matters between you and that provider.`,
    `Separately, you pay ${COMPANY} subscription fees for the software itself. Those fees are described on our pricing page and are exclusive of taxes unless stated.`,
  ),

  section(
    "4. Your responsibilities",
    `You must comply with all laws that apply to your business, including consumer protection, product safety, labelling, tax, and data protection law. You must obtain any licence or registration your trade requires.`,
    `You are responsible for everything posted through your account, for keeping your credentials secure, and for the actions of anyone you invite to your dashboard.`,
    `You must comply with our Acceptable Use Policy, which forms part of these Terms.`,
  ),

  section(
    "5. Your data and your customers' data",
    `You keep ownership of your content and your customer data. You grant us the limited licence needed to host, process, back up and display it in order to run the service for you.`,
    `In relation to your customers' personal data, <strong>you are the controller and ${COMPANY} is a processor</strong> acting on your instructions. You are responsible for having a lawful basis to collect that data and for publishing your own store policies to your customers.`,
    `Our Privacy Policy explains what we do with the data we hold.`,
  ),

  section(
    "6. Availability, and changes to the service",
    `We work to keep the service available, but we do not guarantee uninterrupted or error-free operation. We may change, add or remove features. Where a change materially reduces core functionality on a paid plan, we will give reasonable notice.`,
    `Some functionality depends on third parties — payment gateways, email delivery, hosting, maps, SMS. Their outages are not within our control.`,
  ),

  section(
    "7. Suspension and termination",
    `You may stop using the service at any time. Fees already paid are non-refundable except where required by law.`,
    `We may suspend or terminate an account that breaches these Terms or the Acceptable Use Policy, that exposes us or our other users to legal risk or harm, or where required by law. Where practical and lawful, we will tell you why and give you an opportunity to put it right.`,
    `On termination you may export your data for a reasonable period, after which we may delete it.`,
  ),

  // ⚠ REVIEW — an "as is" disclaimer's enforceability varies by jurisdiction
  // and is often limited against consumers.
  section(
    "8. No warranties",
    `The service is provided <strong>"as is" and "as available"</strong>. To the fullest extent permitted by law, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.`,
    `We do not warrant that the service will meet your requirements, that it will be secure against every attack, or that any defect will be corrected.`,
  ),

  // ⚠ REVIEW — the cap and the carve-outs are the clauses counsel will focus on.
  section(
    "9. Limitation of liability",
    `To the fullest extent permitted by law, ${COMPANY} is not liable for indirect, incidental, special, consequential or punitive damages, nor for lost profits, lost revenue, lost sales, lost goodwill or lost or corrupted data, however caused.`,
    `Our total aggregate liability arising out of or relating to the service is limited to the <strong>subscription fees you actually paid to ${COMPANY} in the twelve months before the event giving rise to the claim</strong>.`,
    `Nothing in these Terms excludes liability that cannot lawfully be excluded, including liability for death or personal injury caused by negligence, or for fraud.`,
  ),

  section(
    "10. You indemnify us",
    `You will defend and indemnify ${COMPANY}, its officers and employees against any claim, loss, liability or cost (including reasonable legal fees) arising from your products, your content, your use of the service, your breach of these Terms or the Acceptable Use Policy, or your breach of any law or third-party right — including any claim brought by one of your customers.`,
  ),

  section(
    "11. Changes to these Terms",
    `We may update these Terms. Every version is published with a version number and an effective date, and previous versions are retained. Where a change is material we will ask you to accept the new version before continuing to use the service.`,
  ),

  // ⚠ REVIEW — set this to the jurisdiction you actually operate from.
  section(
    "12. Governing law",
    `These Terms are governed by the laws of India, and the courts at your registered place of business in India have exclusive jurisdiction, unless mandatory local law provides otherwise.`,
  ),

  section(
    "13. Contact",
    `Questions about these Terms: <a href="mailto:support@storemink.com">support@storemink.com</a>.`,
  ),
].join("\n");

// ── Privacy Policy ──────────────────────────────────────────────────────────
const PRIVACY_BODY = [
  `<p><em>Last updated: 28 July 2026 · Version 1</em></p>`,

  section(
    "1. Two different roles",
    `This policy covers data ${COMPANY} holds as a <strong>controller</strong> — your merchant account, your billing, your use of our dashboard.`,
    `For the personal data your <strong>customers</strong> give to <strong>your</strong> store — names, addresses, order history — the merchant is the controller and ${COMPANY} is a <strong>processor</strong> acting on their instructions. If you shopped at a store built on ${COMPANY} and want your data changed or removed, contact that store first; we will assist them.`,
  ),

  section(
    "2. What we collect",
    `<strong>Account data</strong>: name, email address, phone number, password (hashed — we never see it in the clear), and the business location you give at signup.`,
    `<strong>Store data</strong>: what you create in the product — products, pages, orders, customers, and settings.`,
    `<strong>Usage and technical data</strong>: IP address, browser and device information, and logs of requests, errors and emails sent. Some of this is security evidence rather than analytics — for example, we record the IP and browser used when someone accepts our Terms.`,
    `<strong>Payment data</strong>: we do <strong>not</strong> store card numbers. Payments are handled by payment providers; we store only identifiers and status returned by them.`,
  ),

  section(
    "3. Why we use it",
    `To provide and secure the service; to bill you; to send transactional messages you need (order alerts, security notices, billing); to support you when you ask; to detect abuse and fraud; and to meet legal obligations.`,
    `We do not sell personal data.`,
  ),

  section(
    "4. Who we share it with",
    `Service providers who process data on our behalf under contract, currently including: <strong>Google Cloud</strong> (hosting, database, file storage), <strong>Google Identity Platform</strong> (authentication), <strong>Resend</strong> (email delivery), <strong>Razorpay</strong> (payments), and <strong>Google Maps</strong> (address lookup, when used).`,
    `We may disclose data where required by law, or to protect the rights and safety of our users or the public.`,
  ),

  section(
    "5. Where it is held, and for how long",
    `Data is hosted on Google Cloud infrastructure. Some providers may process data outside your country; where they do, we rely on the safeguards those providers offer.`,
    `We keep data for as long as your account is active, then for a period afterwards where we need it for legal, tax or dispute-resolution reasons. Operational logs are pruned on a rolling basis — activity records after one year, notification and email records after ninety days.`,
  ),

  section(
    "6. Your rights",
    `Depending on where you live, you may ask us to give you a copy of your data, correct it, delete it, restrict how we use it, or object to a use. Write to <a href="mailto:support@storemink.com">support@storemink.com</a> and we will respond within the period the applicable law allows.`,
    `Some data cannot be deleted on request — a record that you accepted our Terms, or an invoice we must keep for tax, are examples.`,
  ),

  section(
    "7. Security",
    `We use encryption in transit, tenant isolation enforced in the database, hashed credentials, and least-privilege access. No system is perfectly secure; if a breach affects your data we will notify you as the law requires.`,
  ),

  section(
    "8. Children",
    `The service is not intended for anyone under 18, and we do not knowingly collect their data.`,
  ),

  section(
    "9. Changes and contact",
    `We publish each version of this policy with a version number and effective date. Questions or requests: <a href="mailto:support@storemink.com">support@storemink.com</a>.`,
  ),
].join("\n");

// ── Acceptable Use ──────────────────────────────────────────────────────────
const AUP_BODY = [
  `<p><em>Last updated: 28 July 2026 · Version 1</em></p>`,
  `<p>This policy forms part of the Terms of Service. It exists so that one merchant's conduct cannot put every other merchant on the platform at risk.</p>`,

  section(
    "1. What you may not sell",
    `Anything illegal where you or your customer are located. Weapons, ammunition and explosives. Illegal drugs, controlled substances and drug paraphernalia. Prescription medicines without the licence to sell them. Counterfeit or infringing goods. Stolen property. Human remains or protected wildlife. Sexually explicit material. Tobacco, vaping and alcohol products where you lack the required licence. Financial instruments, and anything that functions as a deposit-taking or lending product.`,
  ),

  section(
    "2. What you may not do",
    `Mislead customers about who you are, what you are selling, what it costs, or when it will arrive. Take payment for goods you cannot supply. Run a scheme whose returns depend on recruitment rather than sales.`,
    `Send unsolicited bulk email, or mail addresses you did not collect lawfully and with consent. Our sending domain is shared with every other merchant; spam sent from your store damages deliverability for all of them, and we enforce this strictly.`,
    `Attempt to access another store's data, probe or attack the platform, bypass usage limits, scrape at a scale that degrades service, or reverse-engineer the software.`,
    `Upload malware, or use a store to phish or impersonate someone else.`,
  ),

  section(
    "3. How we enforce it",
    `We may investigate suspected breaches and may suspend a store, disable a feature, or terminate an account. Serious cases — fraud, harm to others, or anything we are legally required to report — may be referred to the authorities.`,
    `Where practical and lawful, we will tell you what the problem is and give you a chance to fix it first.`,
  ),

  section(
    "4. Reporting",
    `To report a store or content that breaches this policy, write to <a href="mailto:support@storemink.com">support@storemink.com</a> with the store address and what you have seen.`,
  ),
].join("\n");

/**
 * The CURRENT source text of each policy — not "version 1".
 *
 * To change a published policy: edit the body below AND bump its `version`,
 * then run `scripts/publish-legal.ts --publish`. Bumping the number is what
 * tells the publisher this is a new version rather than a re-run; editing the
 * body without it does nothing, because the DB row is immutable once published
 * and the publisher refuses to go backwards or sideways.
 *
 * The old version stays in the table forever — people accepted it.
 */
export const LEGAL_CONTENT: LegalContent[] = [
  { kind: "terms", title: "Terms of Service", version: 1, body: TERMS_BODY },
  { kind: "privacy", title: "Privacy Policy", version: 1, body: PRIVACY_BODY },
  {
    kind: "acceptable-use",
    title: "Acceptable Use Policy",
    version: 1,
    body: AUP_BODY,
  },
];
