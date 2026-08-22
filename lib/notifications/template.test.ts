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
import { defaultEmailTemplate } from "./default-templates";
import { inlineEmailStyles } from "@/lib/email/notification-emails";

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
    // Formatted for reading, not echoed raw — see lib/notifications/format.ts.
    expect(values.days_left).toBe("7 days");
  });

  // A payload key nobody documented must not be reachable from a template.
  it("ignores payload keys the event doesn't declare", () => {
    const values = templateValues(
      "order.placed",
      {},
      { total: 1240, internalSecretRef: "abc" },
    );
    // Money carries its currency: "Total ₹1,240.00", never a bare "1240".
    expect(values.total).toBe("₹1,240.00");
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

  it("★ a refund's amount reaches the customer", () => {
    // The emitters sent `total`, the catalog declares `amount`, and
    // templateValues drops anything undeclared — so the figure silently
    // vanished and the email read "Your refund has been …" with no number.
    const withAmount = templateValues(
      "order.refund_issued",
      { date: new Date("2026-08-22T10:00:00Z").toISOString() },
      { amount: 1240, currency: "INR", paymentMethod: "razorpay" },
    );
    expect(withAmount.amount).toBe("\u20b91,240.00");

    // The old shape yields nothing at all — this is what regressed.
    const asTotal = templateValues(
      "order.refund_issued",
      {},
      { total: 1240, currency: "INR" },
    );
    expect(asTotal.amount).toBeUndefined();
  });

  it("★ a refund email never claims the original payment method it didn't use", () => {
    // Both renderers said "sent to your original payment method" for EVERY
    // method, so a store-credit refund told the shopper their card was
    // credited when no money had left at all.
    const credit = defaultEmailTemplate(
      "order.refund_issued",
      "customer",
      {},
      {
        paymentMethod: "store_credit",
      },
    );
    expect(credit.body).toMatch(/store credit/i);
    expect(credit.body).not.toMatch(/original payment method/i);
    // …and no bank timeline, because no bank is involved.
    expect(credit.body).not.toMatch(/5–7 working days/);

    const manual = defaultEmailTemplate(
      "order.refund_issued",
      "customer",
      {},
      {
        paymentMethod: "manual",
      },
    );
    expect(manual.body).not.toMatch(/original payment method/i);

    // The gateway refund is the one that earns the promise.
    const online = defaultEmailTemplate(
      "order.refund_issued",
      "customer",
      {},
      {
        paymentMethod: "razorpay",
      },
    );
    expect(online.body).toMatch(/original payment method/i);
    expect(online.body).toMatch(/5–7 working days/);
  });

  it("falls back to copy true of any method when none is known", () => {
    const t = defaultEmailTemplate("order.refund_issued", "customer", {}, null);
    expect(t.body).toMatch(/on its way back to you/i);
    expect(t.body).not.toMatch(/original payment method/i);
  });

  it("opens with a readable sentence, not a bare label", () => {
    const t = defaultEmailTemplate("order.placed");
    expect(t.body.split("\n")[0]).toBe(
      '<p class="email-lead">A new order is ready for review.</p>',
    );
  });
});

describe("default template HTML", () => {
  it("is HTML, not plain text", () => {
    const t = defaultEmailTemplate("order.placed");
    expect(t.body).toContain('<p class="email-lead">');
    expect(t.body).toContain('<ul class="email-details">');
    expect(t.body).toContain('<li class="email-detail">');
  });

  it("leads the facts with the thing itself", () => {
    const t = defaultEmailTemplate("order.placed");
    expect(t.body).toContain(">Order</strong>");
    expect(t.body).toContain("{{subject_label}}");
  });

  it("omits the customer identity from shopper copy", () => {
    expect(defaultEmailTemplate("order.placed", "team").body).toContain(
      ">Customer</strong>",
    );
    expect(defaultEmailTemplate("order.placed", "customer").body).not.toContain(
      ">Customer</strong>",
    );
  });

  it("uses a different voice for each audience", () => {
    expect(defaultEmailTemplate("order.placed", "customer").body).toContain(
      "Thank you for your order",
    );
    expect(defaultEmailTemplate("order.placed", "team").body).toContain(
      "ready for review",
    );
  });

  it("makes the pickup code the focal point of ready-to-collect mail", () => {
    const body = defaultEmailTemplate(
      "order.ready_for_pickup",
      "customer",
    ).body;
    expect(body).toContain("Collection code");
    expect(body).toContain('class="email-code"');
    expect(body).toContain("{{collection_code}}");
  });

  it("does not promise a refund before money has actually moved", () => {
    const cancelled = defaultEmailTemplate("order.cancelled", "customer").body;
    const expired = defaultEmailTemplate(
      "order.pickup_expired",
      "customer",
    ).body;
    expect(cancelled).toContain("once it has been issued");
    expect(expired).toContain("once it has been issued");
    expect(cancelled).not.toContain("refund is on its way");
    expect(expired).not.toContain("refund is on its way");
  });

  it("only uses tags the email shell knows how to style", () => {
    // Mirrors TAG_STYLES in lib/email/shell.ts, plus `br` — a void element
    // that needs no styling. A tag the shell doesn't style arrives unstyled in
    // the inbox, which is why this list exists; keep the two in step.
    const allowed = new Set([
      "p",
      "ul",
      "ol",
      "li",
      "strong",
      "br",
      "h2",
      "h3",
      "a",
      "hr",
    ]);
    for (const def of EVENTS) {
      for (const audience of ["team", "customer"] as const) {
        const body = defaultEmailTemplate(def.key, audience).body;
        for (const match of body.matchAll(/<\/?([a-z0-9]+)/gi)) {
          expect(allowed, `${def.key}: <${match[1]}>`).toContain(
            match[1].toLowerCase(),
          );
        }
      }
    }
  });
});

describe("inlineEmailStyles", () => {
  it("inlines styles for the supported tags", () => {
    const out = inlineEmailStyles("<p>Hello</p>");
    expect(out).toContain("<p style=");
    expect(out).toContain("font-family");
  });

  it("preserves other attributes", () => {
    const out = inlineEmailStyles('<a href="https://x.test">link</a>');
    expect(out).toContain('href="https://x.test"');
    expect(out).toContain("style=");
  });

  // A merchant who deliberately styles something keeps their styling.
  it("leaves a tag that already has a style attribute alone", () => {
    const out = inlineEmailStyles('<p style="color:red">Hi</p>');
    expect(out).toBe('<p style="color:red">Hi</p>');
  });

  it("leaves unknown tags untouched", () => {
    expect(inlineEmailStyles("<span>x</span>")).toBe("<span>x</span>");
  });

  it("styles every occurrence, not just the first", () => {
    const out = inlineEmailStyles("<p>a</p><p>b</p>");
    expect(out.match(/<p style=/g)).toHaveLength(2);
  });

  it("progressively enhances notification template classes", () => {
    const out = inlineEmailStyles(
      '<p class="email-code">PK0M-3T9V</p><ul class="email-details"><li class="email-detail">Order</li></ul>',
    );
    expect(out).toContain("font-family:'Courier New'");
    expect(out).toContain("letter-spacing:3px");
    expect(out).toContain("background-color:#fafbfb");
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
