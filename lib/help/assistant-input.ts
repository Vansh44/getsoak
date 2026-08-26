export const HELP_ASSISTANT_MAX_MESSAGE_LENGTH = 1_000;

const SHORT_TOPIC_WORDS = new Set([
  "account",
  "accounts",
  "admin",
  "admins",
  "analytics",
  "api",
  "barcode",
  "billing",
  "blog",
  "branding",
  "card",
  "cash",
  "checkout",
  "cod",
  "color",
  "colors",
  "coupon",
  "coupons",
  "currency",
  "customer",
  "customers",
  "dns",
  "domain",
  "domains",
  "delivery",
  "discount",
  "discounts",
  "email",
  "enquiries",
  "enquiry",
  "fees",
  "fulfilment",
  "gst",
  "help",
  "inventory",
  "invoice",
  "invoices",
  "link",
  "location",
  "locations",
  "login",
  "marketing",
  "media",
  "navigation",
  "notification",
  "notifications",
  "order",
  "orders",
  "page",
  "password",
  "pay",
  "payment",
  "payments",
  "permissions",
  "policy",
  "policies",
  "pickup",
  "plan",
  "pos",
  "product",
  "products",
  "refund",
  "refunds",
  "register",
  "report",
  "reports",
  "return",
  "returns",
  "role",
  "roles",
  "sale",
  "scan",
  "seo",
  "shipping",
  "shop",
  "signup",
  "site",
  "sku",
  "stock",
  "storefront",
  "settings",
  "tax",
  "team",
  "theme",
  "themes",
  "upi",
  "user",
  "users",
  "variant",
  "variants",
  "website",
]);

const SHORT_FOLLOW_UPS = new Set([
  "how",
  "more",
  "next",
  "no",
  "ok",
  "then",
  "what",
  "why",
  "yes",
]);

export function normalizeHelpAssistantQuestion(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim()
    : "";
}

/**
 * Reject low-signal input before it can inherit an unrelated earlier topic.
 * The narrow one-token check is deliberately ASCII-only so short questions in
 * scripts with combining marks are not mistaken for keyboard noise.
 */
export function helpAssistantQuestionError(
  value: unknown,
  options: { hasConversationContext?: boolean } = {},
): string | null {
  const question = normalizeHelpAssistantQuestion(value);
  if (question.length > HELP_ASSISTANT_MAX_MESSAGE_LENGTH) {
    return `Keep your question under ${HELP_ASSISTANT_MAX_MESSAGE_LENGTH.toLocaleString("en-IN")} characters.`;
  }

  const asciiTokens = question.match(/[a-z0-9]+/gi) ?? [];
  const oneAsciiToken =
    asciiTokens.length === 1 && /^[a-z0-9]+[?!.,]*$/i.test(question);
  if (oneAsciiToken) {
    const token = asciiTokens[0].toLowerCase();
    const accepted =
      SHORT_TOPIC_WORDS.has(token) ||
      (options.hasConversationContext === true && SHORT_FOLLOW_UPS.has(token));
    if (accepted) return null;
    return "Please enter a complete StoreMink question, such as “How do I process a POS sale?”";
  }

  const meaningfulCharacters = question.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (meaningfulCharacters < 3) {
    return "Please enter a complete StoreMink question, such as “How do I process a POS sale?”";
  }
  return null;
}
