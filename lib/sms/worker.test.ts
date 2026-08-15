import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
const sendSms = vi.fn();
const loadSmsSender = vi.fn();
const loadSmsTemplates = vi.fn();
const isSuppressed = vi.fn();

vi.mock("@/lib/db/client", () => ({
  withService: (fn: (db: unknown) => unknown) => fn({ execute }),
}));
vi.mock("./send", () => ({ sendSms: (i: unknown) => sendSms(i) }));
vi.mock("./channel", () => ({
  loadSmsSender: (...a: unknown[]) => loadSmsSender(...a),
  loadSmsTemplates: (...a: unknown[]) => loadSmsTemplates(...a),
}));
vi.mock("./suppression", () => ({
  isSuppressed: (...a: unknown[]) => isSuppressed(...a),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import { runSmsWorker } from "./worker";

const V = "{#var#}";
const TEMPLATE = {
  audience: "customer",
  dltTemplateId: "170716",
  body: `Order ${V} confirmed. - Us`,
  variables: ["subject_label"],
};

function queued(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    store_id: "store-1",
    recipient_id: "cust-1",
    recipient_type: "customer",
    phone: "9876543210",
    event_key: "order.placed",
    values: ["ORD1001"],
    attempts: 1,
    ...over,
  };
}

/**
 * The SQL of the settle/requeue calls only.
 *
 * ⚠ The CLAIM query itself contains `status = 'pending'` in its WHERE clause,
 * so asserting over every call can never distinguish a requeue from the claim
 * that found the row. Only calls after the first are the worker's verdict.
 */
function verdictSql(): string {
  return JSON.stringify(execute.mock.calls.slice(1));
}

/** The claim is the first execute; every later one is a settle/requeue. */
function seedClaim(rows: unknown[]) {
  execute.mockReset();
  execute.mockResolvedValueOnce({ rows });
  execute.mockResolvedValue({ rows: [] });
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS — restore every default.
  execute.mockResolvedValue({ rows: [] });
  sendSms.mockResolvedValue({ sent: true, messageId: "SM1", segments: 1 });
  loadSmsSender.mockResolvedValue({
    creds: { accountSid: "AC1", authToken: "t" },
    senderHeader: "CORNRS",
    dltEntityId: "170",
  });
  loadSmsTemplates.mockResolvedValue(new Map([["customer", TEMPLATE]]));
  isSuppressed.mockResolvedValue(false);
});

describe("runSmsWorker", () => {
  it("does nothing when the queue is empty", async () => {
    seedClaim([]);
    const r = await runSmsWorker();
    expect(r).toMatchObject({ claimed: 0, sent: 0 });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("sends a queued message and settles it", async () => {
    seedClaim([queued()]);
    const r = await runSmsWorker();
    expect(r.sent).toBe(1);
    const sent = sendSms.mock.calls[0][0];
    expect(sent.body).toBe("Order ORD1001 confirmed. - Us");
    expect(sent.senderHeader).toBe("CORNRS");
    expect(sent.dltTemplateId).toBe("170716");
    // E.164 — Twilio rejects the bare national form outright.
    expect(sent.to).toBe("+919876543210");
  });

  it("claims with FOR UPDATE SKIP LOCKED so two runs take different rows", async () => {
    seedClaim([]);
    await runSmsWorker();
    expect(JSON.stringify(execute.mock.calls)).toContain(
      "for update skip locked",
    );
  });

  // ★★ THE RULE THIS WORKER EXISTS TO GET RIGHT.
  describe("retry policy", () => {
    it("RETRIES a rejection — it provably did not send", async () => {
      seedClaim([queued({ attempts: 1 })]);
      sendSms.mockResolvedValue({
        sent: false,
        outcome: "rejected",
        error: "Invalid number",
      });
      await runSmsWorker();
      expect(verdictSql()).toContain("'pending'");
    });

    // ★ An unknown outcome MAY HAVE GONE. Sending again to find out is the one
    // thing that cannot be undone — a phone buzzing twice is worse than once.
    it("NEVER retries an unknown outcome", async () => {
      seedClaim([queued({ attempts: 1 })]);
      sendSms.mockResolvedValue({
        sent: false,
        outcome: "unknown",
        error: "timeout",
      });
      const r = await runSmsWorker();
      expect(r.unknown).toBe(1);
      expect(verdictSql()).not.toContain("'pending'");
      expect(verdictSql()).toContain("Unconfirmed");
    });

    it("gives up on a rejection once the attempts run out", async () => {
      seedClaim([queued({ attempts: 3 })]);
      sendSms.mockResolvedValue({
        sent: false,
        outcome: "rejected",
        error: "Invalid number",
      });
      await runSmsWorker();
      expect(verdictSql()).not.toContain("'pending'");
    });
  });

  // ★ CHECKED AT SEND, NOT AT ENQUEUE. Someone can text STOP between an order
  // being placed and the queue draining, and the message that arrives after
  // they opted out is the one that gets a complaint.
  it("does not send to a number that opted out", async () => {
    seedClaim([queued()]);
    isSuppressed.mockResolvedValue(true);
    const r = await runSmsWorker();
    expect(sendSms).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it("does not send when the store disconnected since queueing", async () => {
    seedClaim([queued()]);
    loadSmsSender.mockResolvedValue(null);
    const r = await runSmsWorker();
    expect(sendSms).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
  });

  it("does not send when the template is gone", async () => {
    seedClaim([queued()]);
    loadSmsTemplates.mockResolvedValue(new Map());
    const r = await runSmsWorker();
    expect(sendSms).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
  });

  // A merchant who fixed a mistyped mirror should get the fix, not the version
  // that was already wrong — but the VALUES stay as snapshotted.
  it("renders against the CURRENT template using the SNAPSHOTTED values", async () => {
    seedClaim([queued({ values: ["ORD9"] })]);
    loadSmsTemplates.mockResolvedValue(
      new Map([
        ["customer", { ...TEMPLATE, body: `Ref ${V} is on its way. - Us` }],
      ]),
    );
    await runSmsWorker();
    expect(sendSms.mock.calls[0][0].body).toBe("Ref ORD9 is on its way. - Us");
  });

  it("fails a row whose values no longer fit the template", async () => {
    seedClaim([queued({ values: [] })]);
    const r = await runSmsWorker();
    expect(sendSms).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
  });

  it("picks the team template for a team recipient", async () => {
    seedClaim([queued({ recipient_type: "admin" })]);
    loadSmsTemplates.mockResolvedValue(
      new Map([["team", { ...TEMPLATE, audience: "team" }]]),
    );
    await runSmsWorker();
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  // Resolved once per store, not once per message — a batch is usually all one
  // store, and the fan-out already paid for these lookups once.
  it("loads the sender once for a batch from one store", async () => {
    seedClaim([queued({ id: "a" }), queued({ id: "b" }), queued({ id: "c" })]);
    await runSmsWorker();
    expect(loadSmsSender).toHaveBeenCalledTimes(1);
    expect(loadSmsTemplates).toHaveBeenCalledTimes(1);
    expect(sendSms).toHaveBeenCalledTimes(3);
  });

  it("survives a claim failure without throwing into the cron", async () => {
    execute.mockReset();
    execute.mockRejectedValue(new Error("db down"));
    await expect(runSmsWorker()).resolves.toMatchObject({ claimed: 0 });
  });
});
