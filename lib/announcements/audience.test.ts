import { describe, expect, it } from "vitest";
import {
  CATEGORY_META,
  contactKey,
  decideRecipient,
  describeAudience,
  normalizeAudience,
  type AudienceCandidate,
} from "./audience";

function candidate(over: Partial<AudienceCandidate> = {}): AudienceCandidate {
  return {
    kind: "owner",
    name: "Asha",
    email: "asha@example.com",
    phone: "+919876543210",
    storeId: "store-1",
    role: "superadmin",
    marketingOptIn: true,
    ...over,
  };
}

const none = new Set<string>();

describe("decideRecipient — consent", () => {
  it("skips a feature announcement for someone who never opted in", () => {
    const decision = decideRecipient(candidate({ marketingOptIn: false }), {
      channel: "email",
      category: "feature",
      suppressed: none,
      seen: none,
    });
    expect(decision.send).toBe(false);
    expect(decision).toMatchObject({ reason: "no_consent" });
  });

  // The whole reason `category` is a stored column: an outage notice is service
  // correspondence about an account they already have, not marketing.
  it("sends an operational notice to someone who opted OUT of marketing", () => {
    const decision = decideRecipient(candidate({ marketingOptIn: false }), {
      channel: "email",
      category: "operational",
      suppressed: none,
      seen: none,
    });
    expect(decision.send).toBe(true);
  });

  // pos_staff has no marketing_opt_in column — nobody ever asked them, and an
  // absent preference is not consent.
  it("never markets to till staff, even when the flag defaults true", () => {
    const decision = decideRecipient(
      candidate({ kind: "pos", marketingOptIn: true }),
      { channel: "email", category: "feature", suppressed: none, seen: none },
    );
    expect(decision.send).toBe(false);
    expect(decision).toMatchObject({ reason: "no_consent" });
  });

  it("still sends till staff an operational notice", () => {
    const decision = decideRecipient(candidate({ kind: "pos" }), {
      channel: "email",
      category: "operational",
      suppressed: none,
      seen: none,
    });
    expect(decision.send).toBe(true);
  });

  it("keeps the two categories' opt-in behaviour opposite", () => {
    expect(CATEGORY_META.feature.honoursOptIn).toBe(true);
    expect(CATEGORY_META.operational.honoursOptIn).toBe(false);
  });
});

describe("decideRecipient — deliverability", () => {
  it("skips a suppressed address, case-insensitively", () => {
    const decision = decideRecipient(candidate({ email: "Asha@Example.com" }), {
      channel: "email",
      category: "operational",
      suppressed: new Set(["asha@example.com"]),
      seen: none,
    });
    expect(decision).toMatchObject({ send: false, reason: "suppressed" });
  });

  it("skips a second row for the same person across two stores", () => {
    const decision = decideRecipient(candidate({ storeId: "store-2" }), {
      channel: "email",
      category: "operational",
      suppressed: none,
      seen: new Set(["asha@example.com"]),
    });
    expect(decision).toMatchObject({ send: false, reason: "duplicate" });
  });

  it("skips an empty address rather than sending nowhere", () => {
    for (const email of [null, "", "   "]) {
      const decision = decideRecipient(candidate({ email }), {
        channel: "email",
        category: "operational",
        suppressed: none,
        seen: none,
      });
      expect(decision).toMatchObject({ send: false, reason: "no_email" });
    }
  });

  it("skips SMS with no phone number", () => {
    const decision = decideRecipient(candidate({ phone: null }), {
      channel: "sms",
      category: "operational",
      suppressed: none,
      seen: none,
    });
    expect(decision).toMatchObject({ send: false, reason: "no_phone" });
  });

  // The email suppression list is about EMAIL. Applying it to a phone number
  // would silently drop texts for a reason that says nothing about the phone.
  it("does not apply the email suppression list to SMS", () => {
    const decision = decideRecipient(candidate(), {
      channel: "sms",
      category: "operational",
      suppressed: new Set(["asha@example.com"]),
      seen: none,
    });
    expect(decision.send).toBe(true);
  });
});

describe("contactKey", () => {
  it("lowercases email and leaves the phone alone", () => {
    expect(contactKey(candidate({ email: "A@B.com" }), "email")).toBe(
      "a@b.com",
    );
    expect(contactKey(candidate(), "sms")).toBe("+919876543210");
  });

  it("is null when there is nothing to key on", () => {
    expect(contactKey(candidate({ email: "" }), "email")).toBeNull();
    expect(contactKey(candidate({ phone: "  " }), "sms")).toBeNull();
  });
});

describe("normalizeAudience", () => {
  // The filter reaches a SQL predicate, so unknown values are dropped rather
  // than escaped — and dropping is the safe direction only because the
  // defaults NARROW rather than widen.
  it("drops values that are not in the allowlist", () => {
    const filter = normalizeAudience({
      plans: ["pro", "enterprise", "'; drop table stores; --"],
      statuses: ["active", "deleted"],
      include: ["owner", "root"],
    });
    expect(filter.plans).toEqual(["pro"]);
    expect(filter.statuses).toEqual(["active"]);
    expect(filter.include).toEqual(["owner"]);
  });

  // A mis-saved filter must not mail the whole platform.
  it("defaults to owners only, not everyone", () => {
    expect(normalizeAudience({}).include).toEqual(["owner"]);
    expect(normalizeAudience({ include: [] }).include).toEqual(["owner"]);
  });

  it("treats an empty plan list as every plan, not no plan", () => {
    // Empty means "no filter" downstream — the resolver adds no predicate.
    expect(normalizeAudience({}).plans).toEqual([]);
  });

  it("de-duplicates and bounds the day window", () => {
    expect(normalizeAudience({ plans: ["pro", "pro"] }).plans).toEqual(["pro"]);
    expect(normalizeAudience({ newerThanDays: 99999 }).newerThanDays).toBe(
      3650,
    );
    expect(normalizeAudience({ newerThanDays: -5 }).newerThanDays).toBe(0);
    expect(normalizeAudience({ newerThanDays: "abc" }).newerThanDays).toBe(0);
  });

  it("requires an explicit opt-in to include demo stores", () => {
    expect(normalizeAudience({}).includeDemo).toBe(false);
    expect(normalizeAudience({ includeDemo: "yes" }).includeDemo).toBe(false);
    expect(normalizeAudience({ includeDemo: true }).includeDemo).toBe(true);
  });
});

describe("describeAudience", () => {
  it("reads as a sentence an operator can check before sending", () => {
    expect(
      describeAudience({
        include: ["owner", "staff"],
        plans: ["pro"],
        newerThanDays: 30,
      }),
    ).toBe("Store owners + Dashboard staff, on pro, joined in 30d");
  });
});
