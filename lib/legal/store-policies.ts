// ---------------------------------------------------------------------------
// A STORE's own policies — the merchant's contract with their shoppers.
//
// Deliberately NOT the machinery in documents.ts/store.ts. Those are
// StoreMink's platform policies: versioned, checksummed, immutable once
// published, because you must be able to prove exactly what a merchant agreed
// to years later. A shop's refund policy is a different animal — the owner
// should be able to reword it on a Tuesday afternoon without a release
// process. So these are ordinary `store_pages` rows: edited here, rendered by
// the storefront at their own URL, versioned by nothing.
//
// They live at the SAME slugs the footer already links to, so writing one
// fixes the link rather than adding a second address for the same document.
// ---------------------------------------------------------------------------

export interface StorePolicyDef {
  kind: string;
  /** Page slug — also the public URL, /{slug}. */
  slug: string;
  title: string;
  /** One line under the heading in the editor. */
  description: string;
  /**
   * Shown at checkout when this policy is part of the consent sentence.
   * Short enough to read in a line of small print.
   */
  shortLabel: string;
  /**
   * Does the checkout consent box cover this one? Payment and refund terms
   * bind at the moment money moves; an "about us" style page does not.
   */
  atCheckout: boolean;
  /** Prompts, not prose. Nobody can fill in a blank box. */
  prompts: string[];
}

export const STORE_POLICIES: StorePolicyDef[] = [
  {
    kind: "terms",
    slug: "terms",
    title: "Terms & Conditions",
    description:
      "The agreement between your store and your customers — ordering, pricing, and what you promise.",
    shortLabel: "Terms & Conditions",
    atCheckout: true,
    prompts: [
      "Who you are: legal or trading name, and where you operate from.",
      "When an order becomes binding — on payment, or when you accept it.",
      "How you handle pricing errors and out-of-stock items.",
      "What a customer may not do with your site or content.",
    ],
  },
  {
    kind: "refund-policy",
    slug: "refund-policy",
    title: "Refund & Cancellation Policy",
    description:
      "When a customer can cancel or return, and how they get their money back.",
    shortLabel: "Refund Policy",
    atCheckout: true,
    prompts: [
      "How many days a customer has to request a return.",
      "Which items can't be returned (perishables, personal care, sale items).",
      "Who pays return shipping.",
      "How long a refund takes once you receive the item, and where it goes.",
      "Whether an order can be cancelled after it ships.",
    ],
  },
  {
    kind: "shipping-policy",
    slug: "shipping-policy",
    title: "Shipping Policy",
    description: "Where you deliver, how long it takes, and what it costs.",
    shortLabel: "Shipping Policy",
    atCheckout: false,
    prompts: [
      "Which areas you deliver to.",
      "How long dispatch and delivery usually take.",
      "Delivery charges, and any free-delivery threshold.",
      "How a customer tracks an order.",
    ],
  },
  {
    kind: "privacy-policy",
    slug: "privacy-policy",
    title: "Privacy Policy",
    description:
      "What customer data you collect, why, and what you do with it.",
    shortLabel: "Privacy Policy",
    atCheckout: false,
    prompts: [
      "What you collect: name, address, phone, email, order history.",
      "Why you collect it — fulfilling orders, support, marketing.",
      "Who you share it with (delivery partners, payment gateway).",
      "How a customer can ask to see or delete their data.",
    ],
  },
];

const BY_KIND = new Map(STORE_POLICIES.map((p) => [p.kind, p]));

export function getStorePolicyDef(kind: string): StorePolicyDef | undefined {
  return BY_KIND.get(kind);
}

/** The policies the checkout consent box names. */
export function checkoutPolicies(): StorePolicyDef[] {
  return STORE_POLICIES.filter((p) => p.atCheckout);
}

export const STORE_POLICY_SLUGS: ReadonlySet<string> = new Set(
  STORE_POLICIES.map((p) => p.slug),
);
