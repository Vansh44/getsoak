import { describe, it, expect } from "vitest";
import {
  extractVariables,
  renderTemplate,
  templateValues,
  validateTemplate,
} from "./template";
import {
  BASE_VARIABLES,
  sampleValuesFor,
  variableNamesFor,
  variablesFor,
} from "./variables";
import { EVENTS } from "./events";
import { defaultEmailTemplate, splitBody } from "./default-templates";

describe("renderTemplate", () => {
  it("substitutes values", () => {
    expect(
      renderTemplate("New order {{subject_label}}", {
        subject_label: "ORD10010004",
      }),
    ).toBe("New order ORD10010004");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(
      renderTemplate("{{  subject_label  }}", { subject_label: "X" }),
    ).toBe("X");
  });

  it("substitutes the same variable everywhere it appears", () => {
    expect(
      renderTemplate("{{store_name}} — {{store_name}}", {
        store_name: "Acme",
      }),
    ).toBe("Acme — Acme");
  });

  // A template must never leak its own plumbing into a customer's inbox.
  it("renders a missing value as empty, not as the token", () => {
    expect(renderTemplate("Hi {{actor_name}}!", {})).toBe("Hi !");
    expect(renderTemplate("Hi {{actor_name}}!", { actor_name: null })).toBe(
      "Hi !",
    );
  });

  it("leaves non-variable braces alone", () => {
    expect(renderTemplate("{ not a var } {{}}", {})).toBe("{ not a var } {{}}");
  });

  // Values come from the database — customer names, product names.
  it("escapes substituted values in HTML mode", () => {
    const out = renderTemplate(
      "<p>{{actor_name}}</p>",
      { actor_name: "<script>alert(1)</script>" },
      "html",
    );
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("does not escape in text mode (subject lines aren't HTML)", () => {
    expect(
      renderTemplate("{{store_name}}", { store_name: "Ben & Jerry's" }, "text"),
    ).toBe("Ben & Jerry's");
  });

  it("coerces numbers", () => {
    expect(renderTemplate("{{stock}} left", { stock: 4 })).toBe("4 left");
  });

  it("returns empty for an empty template", () => {
    expect(renderTemplate("", { a: "b" })).toBe("");
  });
});

describe("extractVariables", () => {
  it("lists each distinct token once, in order", () => {
    expect(extractVariables("{{b}} {{a}} {{b}} plain {{c}}")).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("is empty for a template with no variables", () => {
    expect(extractVariables("Just words")).toEqual([]);
  });
});

describe("validateTemplate", () => {
  it("accepts variables the event provides", () => {
    const result = validateTemplate(
      "New order {{subject_label}} — {{total}}",
      "order.placed",
    );
    expect(result.valid).toBe(true);
    expect(result.unknown).toEqual([]);
  });

  // The merchant finds out while editing, not from a customer.
  it("rejects a variable the event doesn't provide", () => {
    const result = validateTemplate(
      "Track it: {{tracking_number}}",
      "order.placed",
    );
    expect(result.valid).toBe(false);
    expect(result.unknown).toEqual(["tracking_number"]);
    expect(result.error).toContain("tracking_number");
  });

  it("names every unknown variable at once", () => {
    const result = validateTemplate("{{foo}} {{bar}}", "order.placed");
    expect(result.unknown).toEqual(["foo", "bar"]);
  });

  it("rejects a variable that belongs to a DIFFERENT event", () => {
    // `rating` is real, but only on customer.review_submitted.
    expect(validateTemplate("{{rating}}", "order.placed").valid).toBe(false);
    expect(
      validateTemplate("{{rating}}", "customer.review_submitted").valid,
    ).toBe(true);
  });

  it("enforces a subject length limit", () => {
    const result = validateTemplate("x".repeat(400), "order.placed", "subject");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("too long");
  });

  it("allows the base variables on every event", () => {
    for (const def of EVENTS) {
      for (const variable of BASE_VARIABLES) {
        expect(
          validateTemplate(`{{${variable.name}}}`, def.key).valid,
          `${def.key} / ${variable.name}`,
        ).toBe(true);
      }
    }
  });
});

describe("templateValues", () => {
  it("maps the event envelope onto base variables", () => {
    const values = templateValues(
      "order.placed",
      {
        storeName: "Acme",
        actorLabel: "Priya S.",
        subjectLabel: "ORD10010004",
        eventName: "New order",
        date: "26 Jul 2026",
        link: "https://acme.storemink.com/dashboard/orders",
      },
      null,
    );
    expect(values.store_name).toBe("Acme");
    expect(values.subject_label).toBe("ORD10010004");
    expect(values.link).toContain("https://");
  });

  it("converts camelCase payload keys to snake_case tokens", () => {
    const values = templateValues("plan.expiring", {}, { daysLeft: 7 });
    expect(values.days_left).toBe("7");
  });

  // A payload key nobody documented must not be reachable from a template.
  it("ignores payload keys the event doesn't declare", () => {
    const values = templateValues(
      "order.placed",
      {},
      { total: 1240, internalSecretRef: "abc" },
    );
    expect(values.total).toBe("1240");
    expect(values).not.toHaveProperty("internal_secret_ref");
  });

  it("skips null and undefined", () => {
    const values = templateValues(
      "order.placed",
      { storeName: null },
      { total: null },
    );
    expect(values).not.toHaveProperty("store_name");
    expect(values).not.toHaveProperty("total");
  });
});

describe("default email templates", () => {
  it("gives every notification a subject and a non-empty body", () => {
    for (const def of EVENTS) {
      const t = defaultEmailTemplate(def.key);
      expect(t.subject.length, def.key).toBeGreaterThan(0);
      expect(t.body.length, def.key).toBeGreaterThan(20);
    }
  });

  it("only uses variables the event actually provides", () => {
    for (const def of EVENTS) {
      const t = defaultEmailTemplate(def.key);
      expect(
        validateTemplate(t.subject, def.key, "subject").valid,
        def.key,
      ).toBe(true);
      expect(validateTemplate(t.body, def.key, "body").valid, def.key).toBe(
        true,
      );
    }
  });

  it("renders with no leftover tokens", () => {
    for (const def of EVENTS) {
      const t = defaultEmailTemplate(def.key);
      const values = sampleValuesFor(def.key);
      expect(renderTemplate(t.subject, values, "text"), def.key).not.toContain(
        "{{",
      );
      expect(renderTemplate(t.body, values), def.key).not.toContain("{{");
    }
  });

  it("opens with a readable sentence, not a bare label", () => {
    const t = defaultEmailTemplate("order.placed");
    expect(t.body.split("\n")[0]).toBe("You've received a new order.");
  });
});

describe("splitBody", () => {
  it("separates prose from Label: value facts", () => {
    const { paragraphs, rows } = splitBody(
      "You've received a new order.\n\nReference: ORD10010004\nTotal: 1240",
    );
    expect(paragraphs).toEqual(["You've received a new order."]);
    expect(rows).toEqual([
      { label: "Reference", value: "ORD10010004" },
      { label: "Total", value: "1240" },
    ]);
  });

  // An empty "Total:" row is worse than no row at all.
  it("drops rows whose value resolved to nothing", () => {
    const { rows } = splitBody("Reference: ORD1\nTotal: \nWho: Priya");
    expect(rows.map((r) => r.label)).toEqual(["Reference", "Who"]);
  });

  it("keeps a merchant's free-form prose containing a colon as prose", () => {
    const { paragraphs, rows } = splitBody(
      "Heads up: this order came in through the new landing page we launched",
    );
    expect(rows).toEqual([]);
    expect(paragraphs).toHaveLength(1);
  });

  it("ignores blank lines", () => {
    const { paragraphs } = splitBody("One\n\n\nTwo");
    expect(paragraphs).toEqual(["One", "Two"]);
  });
});

describe("variable catalog", () => {
  it("gives every event at least the base variables", () => {
    for (const def of EVENTS) {
      expect(variablesFor(def.key).length).toBeGreaterThanOrEqual(
        BASE_VARIABLES.length,
      );
    }
  });

  it("has no duplicate variable names within an event", () => {
    for (const def of EVENTS) {
      const names = variablesFor(def.key).map((v) => v.name);
      expect(new Set(names).size, def.key).toBe(names.length);
    }
  });

  it("uses snake_case tokens throughout", () => {
    for (const def of EVENTS) {
      for (const variable of variablesFor(def.key)) {
        expect(variable.name, `${def.key}/${variable.name}`).toMatch(
          /^[a-z][a-z0-9_]*$/,
        );
      }
    }
  });

  // The preview must exercise the same names the validator allows, or a
  // merchant sees a blank where their variable will actually resolve.
  it("provides a sample for every declared variable", () => {
    for (const def of EVENTS) {
      const samples = sampleValuesFor(def.key);
      for (const name of variableNamesFor(def.key)) {
        expect(samples, `${def.key}/${name}`).toHaveProperty(name);
      }
    }
  });

  it("renders a preview with no leftover tokens", () => {
    for (const def of EVENTS) {
      const template = variablesFor(def.key)
        .map((v) => `{{${v.name}}}`)
        .join(" ");
      const out = renderTemplate(template, sampleValuesFor(def.key));
      expect(out, def.key).not.toContain("{{");
    }
  });
});
