// ---------------------------------------------------------------------------
// Presentation for template values.
//
// WHY THIS EXISTS: every value used to reach the email as String(value), so a
// customer's order confirmation read
//
//     Total          281.4
//     Currency       INR
//     Payment method cod
//     When           28/7/2026, 12:20:46 am
//
// Four separate tells that nobody looked at it. The variable CATALOG already
// promised better — it advertises `sample: "₹1,240.00"` for total — so the
// console previewed something the send could never produce.
//
// The values are DB-shaped: a numeric column, an enum, an ISO timestamp. Those
// are the right things to store and the wrong things to show, and the gap
// between them is this module.
//
// Pure: no DB, no server imports, so the console preview and the real send are
// formatted by the same code and can't drift.
// ---------------------------------------------------------------------------

/**
 * Variables that hold money. Named rather than sniffed from the value: `items`
 * and `total` are both numbers, and only one of them is a price.
 */
const MONEY = new Set([
  "total",
  "subtotal",
  "amount",
  "discount",
  "tax",
  "shipping",
  "refund_amount",
  "refund_due",
  "fees",
  "price",
  "balance",
]);

/** Values that are a database enum but read as jargon. */
// ★★ A METHOD LABEL MUST NOT ASSERT A STATE.
//
// `razorpay` read "Paid online" and `pos` read "Paid in store" — but this maps
// `payment_method`, which says HOW an order is to be settled, not whether it
// has been. A shopper who reached the Razorpay modal and paid nothing got a
// confirmation whose payment line said "Paid online", because the method was
// razorpay from the moment the order row was written.
//
// Whether money arrived is `payment_status`, which has its own map below and
// its own words. Keep the two vocabularies apart: "Cash on delivery" is safe
// because it describes an arrangement, and "Paid online" was not because it
// describes an event.
const PAYMENT_METHODS: Record<string, string> = {
  cod: "Cash on delivery",
  cash_on_delivery: "Cash on delivery",
  pay_at_store: "Pay at store",
  razorpay: "Online payment",
  pos: "In store",
  cash: "Cash",
  card: "Card",
  upi: "UPI",
  split: "Split payment",
};

const ORDER_STATUSES: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  completed: "Completed",
  cancelled: "Cancelled",
  paid: "Paid",
  failed: "Failed",
};

/**
 * Money, in the customer's own currency, with the symbol attached.
 *
 * Intl gives correct grouping per locale (₹1,24,000 in en-IN, not ₹124,000) —
 * getting that wrong is exactly the kind of detail that reads as sloppy to the
 * person it's wrong for. Falls back to a plain 2dp string if the runtime has no
 * ICU data for the currency.
 */
export function formatMoney(value: number, currency = "INR"): string {
  if (!Number.isFinite(value)) return "";
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/**
 * A timestamp a person would say out loud. The seconds and the am/pm noise in
 * "28/7/2026, 12:20:46 am" are machine detail nobody reading an order
 * confirmation needs.
 *
 * Takes an ISO string, because that is the only unambiguous one: a LOCALE
 * string round-trips wrong (V8 reads "5/8/2026" as 8 May, not 5 August), which
 * is what put the wrong date on every order confirmation.
 *
 * ★ The timezone is PINNED. Without it this renders in the system zone, which
 * is UTC on Cloud Run — so an order placed at 3:12 pm was confirmed as
 * "9:42 am", with no marker to say it wasn't local. Asia/Kolkata is the
 * India-first default the dashboard tables already use, until per-store
 * timezones exist.
 */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Turn a snake_case enum into a readable label as a last resort. */
function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

/**
 * Present one template value for display.
 *
 * `currency` comes from the same payload, which is why the `currency` variable
 * itself is folded away rather than printed as its own row — "Total ₹281.40"
 * says everything "Total 281.4 / Currency INR" was trying to.
 */
export function formatVariable(
  name: string,
  raw: unknown,
  currency = "INR",
): string {
  if (raw === null || raw === undefined) return "";
  const value = String(raw);
  if (!value) return "";

  if (MONEY.has(name)) {
    const amount = Number(raw);
    return Number.isFinite(amount) ? formatMoney(amount, currency) : value;
  }
  if (name === "payment_method") {
    return PAYMENT_METHODS[value.toLowerCase()] ?? humanize(value);
  }
  // "pickup" on its own reads like a typo in a sentence; the shopper is being
  // told how they get their order.
  if (name === "fulfilment") {
    return value.toLowerCase() === "pickup" ? "Pick up in store" : "Delivery";
  }
  if (name === "status" || name === "payment_status") {
    return ORDER_STATUSES[value.toLowerCase()] ?? humanize(value);
  }
  if (name === "date" || name.endsWith("_at") || name === "expires_on") {
    return formatDate(value);
  }
  if (name === "hours_left") {
    const hours = Number(raw);
    return Number.isFinite(hours)
      ? `${hours} hour${hours === 1 ? "" : "s"}`
      : value;
  }
  if (name === "days_left") {
    const days = Number(raw);
    return Number.isFinite(days)
      ? `${days} day${days === 1 ? "" : "s"}`
      : value;
  }
  // Counts, names, references and anything else: shown as stored.
  return value;
}

/**
 * Variables that must never get their own row in a summary.
 *
 * `currency` is merged into every money value above, so printing it too is
 * repetition that makes the email read like a form dump rather than a receipt.
 */
export const HIDDEN_VARIABLES = new Set(["currency"]);

/**
 * "2 items · Amul Taaza Milk, Tata Salt" — what was actually bought.
 *
 * A bare count ("Items: 2") is the difference between a receipt and a log
 * line: the shopper already knows they ordered something, they want to see
 * WHAT. Amazon leads with the product for exactly this reason.
 *
 * Capped, because an order of forty things must not turn the summary row into
 * a wall — the order page has the full list, and that's what the button is for.
 */
export function summariseItems(
  items: { name: string; variantName?: string | null; quantity: number }[],
  maxNamed = 3,
): string {
  if (items.length === 0) return "";
  const units = items.reduce((n, i) => n + (Number(i.quantity) || 0), 0);
  const count = `${units} item${units === 1 ? "" : "s"}`;

  const named = items
    .slice(0, maxNamed)
    .map((i) => {
      const name = i.variantName ? `${i.name} (${i.variantName})` : i.name;
      return Number(i.quantity) > 1 ? `${name} × ${i.quantity}` : name;
    })
    .join(", ");

  const rest = items.length - maxNamed;
  return rest > 0 ? `${count} · ${named} +${rest} more` : `${count} · ${named}`;
}
