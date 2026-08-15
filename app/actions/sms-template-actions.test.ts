/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { getManagerUserId } from "@/app/dashboard/lib/access";
import {
  deleteSmsTemplate,
  getSmsTemplates,
  saveSmsTemplate,
} from "./sms-template-actions";

const V = "{#var#}";
// A real event key with real variables, so the token check is exercised
// against the actual registry rather than a stub of it.
const EVENT = "order.placed";
const GOOD = {
  eventKey: EVENT,
  audience: "customer" as const,
  dltTemplateId: "1707161234567890123",
  body: `Order ${V} confirmed. - Corner Store`,
  // `subject_label` IS the order reference for this event. `order_ref` is not
  // a variable it carries — using it here was a bug in an earlier draft of this
  // test, and the action correctly refused it.
  variables: ["subject_label"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
  dbHolder.current = makeDbMock({ selectQueue: [[]] });
});

describe("permissions", () => {
  it.each([
    ["saveSmsTemplate", () => saveSmsTemplate(GOOD)],
    [
      "deleteSmsTemplate",
      () => deleteSmsTemplate({ eventKey: EVENT, audience: "team" }),
    ],
  ])("%s refuses without the notifications grant", async (_n, call) => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    expect((await call()).error).toMatch(/permission/i);
  });

  it("getSmsTemplates returns nothing without the grant", async () => {
    vi.mocked(getManagerUserId).mockResolvedValue(null);
    expect((await getSmsTemplates(EVENT)).templates).toEqual([]);
  });
});

describe("saveSmsTemplate", () => {
  it("stores a valid mirror", async () => {
    const r = await saveSmsTemplate(GOOD);
    expect(r.success).toBe(true);
    const row = dbHolder.current.calls.values[0];
    expect(row.dltTemplateId).toBe(GOOD.dltTemplateId);
    expect(row.variables).toEqual(["subject_label"]);
    expect(row.storeId).toBe("store-1");
  });

  it("refuses an event this store doesn't send", async () => {
    const r = await saveSmsTemplate({ ...GOOD, eventKey: "made.up" });
    expect(r.error).toMatch(/isn't a notification/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("refuses an audience that isn't team or customer", async () => {
    const r = await saveSmsTemplate({ ...GOOD, audience: "everyone" as never });
    expect(r.error).toMatch(/who this message is for/i);
  });

  // ★ Validated on save, so a template that cannot work is refused in front of
  // the person pasting it — not discovered as messages that never arrive.
  it("refuses a template with no DLT id", async () => {
    const r = await saveSmsTemplate({ ...GOOD, dltTemplateId: "  " });
    expect(r.error).toMatch(/template ID/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("refuses a body ending in a variable", async () => {
    const r = await saveSmsTemplate({
      ...GOOD,
      body: `Your order is ${V}`,
    });
    expect(r.error).toMatch(/cannot end with/i);
  });

  // ★★ DLT variables are POSITIONAL and unnamed, so a mapping of the wrong
  // length puts a literal {#var#} in a customer's message or drops a value the
  // merchant meant to send. Neither can be recalled.
  it("refuses a mapping with too few values", async () => {
    const r = await saveSmsTemplate({
      ...GOOD,
      body: `Order ${V} for ${V} confirmed. - Us`,
      variables: ["subject_label"],
    });
    expect(r.error).toMatch(/2 variables/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("refuses a mapping with too many values", async () => {
    const r = await saveSmsTemplate({
      ...GOOD,
      variables: ["subject_label", "total"],
    });
    expect(r.error).toMatch(/1 variable/i);
  });

  it("accepts a template with no variables and no mapping", async () => {
    const r = await saveSmsTemplate({
      ...GOOD,
      body: "Your order is ready to collect. - Corner Store",
      variables: [],
    });
    expect(r.success).toBe(true);
  });

  // A name the event doesn't carry resolves to nothing at send time, so the
  // message goes out with a gap in it.
  it("refuses a variable this event doesn't carry", async () => {
    const r = await saveSmsTemplate({
      ...GOOD,
      variables: ["not_a_real_variable"],
    });
    expect(r.error).toMatch(/not_a_real_variable/);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  it("ignores blank entries in the mapping rather than counting them", async () => {
    const r = await saveSmsTemplate({
      ...GOOD,
      variables: ["subject_label", "  "],
    });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].variables).toEqual([
      "subject_label",
    ]);
  });

  it("scopes to the acting store, never to caller input", async () => {
    await saveSmsTemplate({ ...GOOD, storeId: "other-store" } as never);
    expect(dbHolder.current.calls.values[0].storeId).toBe("store-1");
  });
});

describe("getSmsTemplates", () => {
  // ★ The cost is DERIVED on read rather than stored, so it can never be stale
  // against a body someone edited.
  it("reports what each template will cost per message", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            eventKey: EVENT,
            audience: "customer",
            dltTemplateId: "1",
            // A rupee sign forces UCS-2, so 100 characters is 2 segments.
            body: "₹" + "a".repeat(99),
            variables: [],
            enabled: true,
          },
        ],
      ],
    });
    const { templates } = await getSmsTemplates(EVENT);
    expect(templates[0].segments).toBe(2);
  });

  it("survives a malformed variables column", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            eventKey: EVENT,
            audience: "team",
            dltTemplateId: "1",
            body: "Hi.",
            variables: "not-an-array",
            enabled: true,
          },
        ],
      ],
    });
    const { templates } = await getSmsTemplates(EVENT);
    expect(templates[0].variables).toEqual([]);
  });
});
