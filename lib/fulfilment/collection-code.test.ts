import { describe, expect, it } from "vitest";
import {
  COLLECTION_CODE_LENGTH,
  formatCollectionCode,
  generateCollectionCode,
  isCollectionCode,
  normalizeCollectionCode,
} from "./collection-code";

/** Deterministic bytes, so the generator is testable. */
const bytesFrom = (values: number[]) => {
  let i = 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = values[i++ % values.length];
    return out;
  };
};

const realRandom = (n: number) => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
};

describe("generateCollectionCode", () => {
  it("produces a code of the stated length", () => {
    const code = generateCollectionCode(realRandom);
    expect(code).toHaveLength(COLLECTION_CODE_LENGTH);
  });

  // ★ THE ALPHABET IS THE WHOLE POINT. I, L, O and U are the characters people
  // misread off a phone screen in a shop; if any leak in, the normaliser starts
  // corrupting real codes instead of rescuing mistyped ones.
  it("★ never emits I, L, O or U", () => {
    for (let i = 0; i < 300; i++) {
      expect(generateCollectionCode(realRandom)).not.toMatch(/[ILOU]/);
    }
  });

  it("maps bytes into the alphabet deterministically", () => {
    // 0 → "0", 1 → "1", 31 → "Z"
    expect(generateCollectionCode(bytesFrom([0]), 3)).toBe("000");
    expect(generateCollectionCode(bytesFrom([31]), 2)).toBe("ZZ");
  });

  it("uses the low five bits, so every byte value is usable", () => {
    // 32 and 0 are the same code point; 255 masks to 31.
    expect(generateCollectionCode(bytesFrom([32]), 1)).toBe("0");
    expect(generateCollectionCode(bytesFrom([255]), 1)).toBe("Z");
  });

  it("is not obviously biased", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateCollectionCode(realRandom));
    // 500 draws from ~1e12 should essentially never collide.
    expect(seen.size).toBe(500);
  });
});

describe("normalizeCollectionCode", () => {
  // ★ THE RESCUE PATH. Someone reads "PK0M" and types "PKOM"; all of these
  // should find the order rather than saying "not found" with a customer
  // standing there.
  it("★ folds the confusable characters", () => {
    expect(normalizeCollectionCode("PKOM3T9V")).toBe("PK0M3T9V");
    expect(normalizeCollectionCode("1LI23456")).toBe("11123456");
    expect(normalizeCollectionCode("UVWXYZ01")).toBe("VVWXYZ01");
  });

  it("accepts lowercase, spacing and punctuation", () => {
    expect(normalizeCollectionCode("pk0m-3t9v")).toBe("PK0M3T9V");
    expect(normalizeCollectionCode("  PK0M 3T9V  ")).toBe("PK0M3T9V");
    expect(normalizeCollectionCode("#PK0M3T9V")).toBe("PK0M3T9V");
  });

  it("returns empty for anything that isn't a string", () => {
    for (const v of [undefined, null, 42, {}, []]) {
      expect(normalizeCollectionCode(v)).toBe("");
    }
  });
});

describe("isCollectionCode", () => {
  it("accepts a real code, in any of its readable forms", () => {
    const code = generateCollectionCode(realRandom);
    expect(isCollectionCode(code)).toBe(true);
    expect(isCollectionCode(code.toLowerCase())).toBe(true);
    expect(isCollectionCode(formatCollectionCode(code))).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isCollectionCode("PK0M3T9")).toBe(false);
    expect(isCollectionCode("PK0M3T9VX")).toBe(false);
    expect(isCollectionCode("")).toBe(false);
  });

  // A cheap pre-check exists so a scanner pointed at a milk carton doesn't
  // become a database lookup.
  it("rejects a product barcode", () => {
    expect(isCollectionCode("8901234567890")).toBe(false);
  });
});

describe("formatCollectionCode", () => {
  it("groups for reading aloud, without changing the value", () => {
    expect(formatCollectionCode("PK0M3T9V")).toBe("PK0M-3T9V");
    // Round-trips: the hyphen is presentation only.
    expect(normalizeCollectionCode(formatCollectionCode("PK0M3T9V"))).toBe(
      "PK0M3T9V",
    );
  });

  // Normalisation still runs (so "O" → "0"), but nothing of the wrong length
  // gets a hyphen inserted into it — grouping something that is not a code
  // would make it look like one.
  it("does not group anything that isn't a code", () => {
    expect(formatCollectionCode("SHORT")).toBe("SH0RT");
    expect(formatCollectionCode("")).toBe("");
  });
});
