export const MAX_MINK_BULK_PRICE_LINES = 20;
export const MAX_MINK_PRICE_PAISE = 9_999_999_999;

export interface MinkBulkPriceDraftLine {
  sku: string;
  base_price: string;
  selling_price: string;
  special_price: string;
}

export interface MinkPriceSet {
  basePrice: string;
  sellingPrice: string;
  specialPrice: string | null;
  effectivePrice: string;
}

export function parseMinkBulkPriceDraftLines(
  value: string,
): MinkBulkPriceDraftLine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Bulk price lines must be valid JSON.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > MAX_MINK_BULK_PRICE_LINES
  ) {
    throw new Error(
      `Bulk pricing requires 1-${MAX_MINK_BULK_PRICE_LINES} lines.`,
    );
  }
  const seen = new Set<string>();
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Bulk price line ${index + 1} must be an object.`);
    }
    const row = item as Record<string, unknown>;
    const allowed = new Set([
      "sku",
      "base_price",
      "selling_price",
      "special_price",
    ]);
    if (
      Object.keys(row).length !== allowed.size ||
      Object.keys(row).some((key) => !allowed.has(key))
    ) {
      throw new Error(`Bulk price line ${index + 1} has unsupported fields.`);
    }
    const sku = normalizeSku(row.sku, index);
    if (seen.has(sku)) {
      throw new Error(
        `Bulk price line ${index + 1} duplicates SKU ${sku}. Keep one final price per SKU.`,
      );
    }
    seen.add(sku);
    const prices = normalizeMinkPriceSet(
      row.base_price,
      row.selling_price,
      row.special_price,
      `Bulk price line ${index + 1}`,
    );
    return {
      sku,
      base_price: prices.basePrice,
      selling_price: prices.sellingPrice,
      special_price: prices.specialPrice ?? "",
    };
  });
}

export function normalizeMinkPriceSet(
  baseValue: unknown,
  sellingValue: unknown,
  specialValue: unknown,
  label = "Price",
): MinkPriceSet {
  const basePaise = parsePositiveMoneyPaise(baseValue, `${label} MRP`);
  const sellingPaise = parsePositiveMoneyPaise(
    sellingValue,
    `${label} selling price`,
  );
  const specialPaise = parseOptionalMoneyPaise(
    specialValue,
    `${label} special price`,
  );
  if (sellingPaise > basePaise) {
    throw new Error(`${label} selling price cannot exceed its MRP.`);
  }
  if (specialPaise !== null && specialPaise > sellingPaise) {
    throw new Error(
      `${label} special price cannot exceed its selling price. Clear it or choose a lower value.`,
    );
  }
  return {
    basePrice: formatMoneyPaise(basePaise),
    sellingPrice: formatMoneyPaise(sellingPaise),
    specialPrice: specialPaise === null ? null : formatMoneyPaise(specialPaise),
    effectivePrice: formatMoneyPaise(specialPaise ?? sellingPaise),
  };
}

export function moneyNumberToCanonical(value: unknown, label: string) {
  return formatMoneyPaise(parsePositiveMoneyPaise(value, label));
}

export function optionalMoneyNumberToCanonical(value: unknown, label: string) {
  const paise = parseOptionalMoneyPaise(value, label);
  return paise === null ? null : formatMoneyPaise(paise);
}

export function moneyToPaise(value: string) {
  return parsePositiveMoneyPaise(value, "Price");
}

export function assertMinkSpecialPriceSupported(
  specialPrice: string | null,
  supported: boolean,
  label = "Price",
) {
  if (!supported && specialPrice !== null) {
    throw new Error(
      `${label} cannot set a special price because this SKU has no variant. Keep it cleared.`,
    );
  }
}

export function formatMoneyPaise(paise: number) {
  return (paise / 100).toFixed(2);
}

function normalizeSku(value: unknown, index: number) {
  if (typeof value !== "string") {
    throw new Error(`Bulk price line ${index + 1} SKU must be text.`);
  }
  const sku = value.normalize("NFKC").trim();
  if (!sku || sku.length > 100) {
    throw new Error(
      `Bulk price line ${index + 1} SKU must be between 1 and 100 characters.`,
    );
  }
  return sku;
}

function parseOptionalMoneyPaise(value: unknown, label: string) {
  if (value === null || value === undefined || value === "") return null;
  return parsePositiveMoneyPaise(value, label);
}

function parsePositiveMoneyPaise(value: unknown, label: string) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${label} must be a monetary amount.`);
  }
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error(
      `${label} must be greater than zero, use at most two decimal places, and stay within the supported range.`,
    );
  }
  const [whole, fraction = ""] = raw.split(".");
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (
    !Number.isSafeInteger(paise) ||
    paise <= 0 ||
    paise > MAX_MINK_PRICE_PAISE
  ) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return paise;
}
