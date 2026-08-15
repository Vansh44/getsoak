import { describe, it, expect } from "vitest";
import {
  DLT_VARIABLE,
  bodyMatchesTemplate,
  checkDltTemplate,
  normalizeSenderHeader,
  renderDltBody,
  smsSegments,
} from "./dlt";

const ORDER_TEMPLATE = {
  templateId: "1707161234567890123",
  body: `Thanks! Order ${DLT_VARIABLE} for ${DLT_VARIABLE} is confirmed. - Corner Store`,
};

describe("checkDltTemplate", () => {
  it("accepts an approved-looking template and counts its variables", () => {
    expect(checkDltTemplate(ORDER_TEMPLATE)).toEqual({
      ok: true,
      variables: 2,
    });
  });

  it("accepts a template with no variables at all", () => {
    expect(
      checkDltTemplate({ templateId: "1", body: "Your order is ready." }),
    ).toEqual({ ok: true, variables: 0 });
  });

  it("requires the template id the portal issued", () => {
    const r = checkDltTemplate({ templateId: "  ", body: "Hi." });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/template ID/i);
  });

  it("requires a body", () => {
    expect(checkDltTemplate({ templateId: "1", body: "   " }).ok).toBe(false);
  });

  // Operators reject it: the message then has no fixed tail, so what a
  // recipient reads last is entirely sender-controlled.
  it("refuses a template that ENDS with a variable", () => {
    const r = checkDltTemplate({
      templateId: "1",
      body: `Your order is ${DLT_VARIABLE}`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot end with/i);
  });

  it("is not fooled by trailing whitespace after the variable", () => {
    expect(
      checkDltTemplate({
        templateId: "1",
        body: `Your order is ${DLT_VARIABLE}   \n`,
      }).ok,
    ).toBe(false);
  });
});

describe("renderDltBody", () => {
  it("fills the variables in order", () => {
    const r = renderDltBody(ORDER_TEMPLATE, ["ORD10011027", "Asha"]);
    expect(r).toEqual({
      ok: true,
      body: "Thanks! Order ORD10011027 for Asha is confirmed. - Corner Store",
    });
  });

  // ★ Too few leaves a literal {#var#} in a message a customer reads; too many
  // silently drops information. A sent message cannot be recalled, so both are
  // refused rather than patched over.
  it("refuses too few values", () => {
    const r = renderDltBody(ORDER_TEMPLATE, ["ORD1"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/takes 2 values, but 1 was supplied/);
  });

  it("refuses too many values", () => {
    expect(renderDltBody(ORDER_TEMPLATE, ["a", "b", "c"]).ok).toBe(false);
  });

  it("refuses to render an invalid template at all", () => {
    expect(
      renderDltBody({ templateId: "", body: `Hi ${DLT_VARIABLE}.` }, ["x"]).ok,
    ).toBe(false);
  });

  // A newline in a value would let it forge what looks like a second message,
  // and every character is billed against the segment budget.
  it("flattens newlines inside a value", () => {
    const r = renderDltBody(ORDER_TEMPLATE, ["ORD1\n\nFREE MONEY", "Asha"]);
    expect(r.ok && r.body).toBe(
      "Thanks! Order ORD1 FREE MONEY for Asha is confirmed. - Corner Store",
    );
  });

  it("trims a value rather than padding the message with it", () => {
    const r = renderDltBody(ORDER_TEMPLATE, ["  ORD1  ", "Asha"]);
    expect(r.ok && r.body).toContain("Order ORD1 for");
  });
});

describe("bodyMatchesTemplate", () => {
  it("matches a body it rendered itself", () => {
    const r = renderDltBody(ORDER_TEMPLATE, ["ORD10011027", "Asha"]);
    expect(r.ok && bodyMatchesTemplate(ORDER_TEMPLATE, r.body)).toBe(true);
  });

  // The carrier asks this, so we ask it first — a drifted body is blocked
  // SILENTLY, and "the customer never got it" is not a diagnosis.
  it("rejects a body whose fixed text was edited", () => {
    expect(
      bodyMatchesTemplate(
        ORDER_TEMPLATE,
        "Thanks! Order ORD1 for Asha is CANCELLED. - Corner Store",
      ),
    ).toBe(false);
  });

  it("rejects a body missing the fixed tail", () => {
    expect(
      bodyMatchesTemplate(ORDER_TEMPLATE, "Thanks! Order ORD1 for Asha is"),
    ).toBe(false);
  });

  it("requires the fixed segments IN ORDER", () => {
    expect(
      bodyMatchesTemplate(
        ORDER_TEMPLATE,
        "- Corner Store is confirmed. Thanks! Order",
      ),
    ).toBe(false);
  });
});

describe("normalizeSenderHeader", () => {
  it("accepts six letters and upper-cases them", () => {
    expect(normalizeSenderHeader(" cornrs ")).toBe("CORNRS");
  });

  it.each([
    ["CORNR", "five letters"],
    ["CORNERS", "seven letters"],
    ["CORN12", "digits — that is a promotional header"],
    ["CORN-S", "punctuation"],
    ["", "empty"],
  ])("rejects %s (%s)", (input) => {
    expect(normalizeSenderHeader(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeSenderHeader(null)).toBeNull();
    expect(normalizeSenderHeader(123456)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ★ ONE NON-GSM CHARACTER RE-PRICES THE WHOLE MESSAGE. Merchants are billed per
// segment, so this is the difference between a working budget and a surprise.
// ---------------------------------------------------------------------------
describe("smsSegments", () => {
  it("counts an empty body as nothing", () => {
    expect(smsSegments("")).toBe(0);
  });

  it("fits 160 GSM-7 characters in one segment", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
  });

  // The rupee sign is the one that catches an Indian store out.
  it("drops to 70 characters the moment a rupee sign appears", () => {
    expect(smsSegments("a".repeat(100))).toBe(1);
    expect(smsSegments("₹" + "a".repeat(99))).toBe(2);
  });

  it("prices a 150-character template at 1, and at 3 once ₹ is added", () => {
    expect(smsSegments("a".repeat(150))).toBe(1);
    expect(smsSegments("₹" + "a".repeat(150))).toBe(3);
  });

  it("charges two characters for a GSM-7 extended character", () => {
    // 80 braces = 160 GSM-7 characters, which still fits one segment.
    expect(smsSegments("{".repeat(80))).toBe(1);
    expect(smsSegments("{".repeat(81))).toBe(2);
  });

  it("uses the shorter per-part budget once a message is concatenated", () => {
    // 153, not 160, per part once there is a UDH header on each.
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("a".repeat(307))).toBe(3);
  });

  it("treats an emoji as unicode", () => {
    expect(smsSegments("🎉" + "a".repeat(80))).toBe(2);
  });
});
