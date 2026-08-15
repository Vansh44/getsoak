import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
vi.mock("@/lib/db/client", () => ({
  withService: (fn: (db: unknown) => unknown) => fn({ execute }),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import {
  classifyInbound,
  isSuppressed,
  suppressPhone,
  suppressionKey,
  unsuppressPhone,
} from "./suppression";

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue({ rows: [] });
});

describe("classifyInbound", () => {
  it.each([
    ["STOP"],
    ["stop"],
    ["  Stop  "],
    ["STOPALL"],
    ["unsubscribe"],
    ["cancel"],
    ["quit"],
    ["please stop"],
    ["stop please"],
    ["OPTOUT"],
  ])("reads %s as an opt-out", (body) => {
    expect(classifyInbound(body)).toBe("stop");
  });

  it.each([["START"], ["start"], ["unstop"], ["subscribe"]])(
    "reads %s as an opt-in",
    (body) => {
      expect(classifyInbound(body)).toBe("start");
    },
  );

  // ★ WHEN IN DOUBT, `other`. A missed opt-out is recoverable by a human
  // reading the log; a wrongly-inferred one silently ends someone's order
  // updates and they only find out by not hearing from the shop.
  it.each([
    ["stop sending me so many messages", "a complaint, not a command"],
    ["where is my order", "an ordinary reply"],
    ["", "empty"],
    ["thanks", "unrelated"],
  ])("reads %s as other (%s)", (body) => {
    expect(classifyInbound(body)).toBe("other");
  });

  it("ignores punctuation and case around the keyword", () => {
    expect(classifyInbound("STOP!")).toBe("stop");
    expect(classifyInbound("stop.")).toBe("stop");
  });
});

// The same number arrives as +91…, 0…, or bare depending on who typed it.
// A match that depends on the format is a match that silently fails.
describe("suppressionKey", () => {
  it.each([
    ["9876543210", "9876543210"],
    ["+919876543210", "9876543210"],
    ["919876543210", "9876543210"],
    ["09876543210", "9876543210"],
    ["+91 98765 43210", "9876543210"],
  ])("reduces %s to %s", (input, expected) => {
    expect(suppressionKey(input)).toBe(expected);
  });

  it("returns empty for nothing usable", () => {
    expect(suppressionKey("")).toBe("");
    expect(suppressionKey("abc")).toBe("");
  });
});

describe("isSuppressed", () => {
  it("is true when a row exists", async () => {
    execute.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    await expect(isSuppressed("store-1", "9876543210")).resolves.toBe(true);
  });

  it("is false when none does", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(isSuppressed("store-1", "9876543210")).resolves.toBe(false);
  });

  it("matches regardless of the number's format", async () => {
    await isSuppressed("store-1", "+91 98765 43210");
    expect(JSON.stringify(execute.mock.calls)).toContain("9876543210");
  });

  // ★ FAILS OPEN. "We couldn't check, so assume they opted out" would stop
  // every message for as long as the outage lasts.
  it("does not block sending when the check itself fails", async () => {
    execute.mockRejectedValue(new Error("db down"));
    await expect(isSuppressed("store-1", "9876543210")).resolves.toBe(false);
  });

  it("does not query on an unusable number", async () => {
    await expect(isSuppressed("store-1", "nonsense")).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("suppressPhone / unsuppressPhone", () => {
  it("records an opt-out against the store, not globally", async () => {
    await suppressPhone("store-1", "+919876543210");
    const sent = JSON.stringify(execute.mock.calls);
    expect(sent).toContain("sms_suppressions");
    expect(sent).toContain("store-1");
    expect(sent).toContain("9876543210");
  });

  // A second STOP from someone already opted out is not an error.
  it("is idempotent", async () => {
    await suppressPhone("store-1", "9876543210");
    expect(JSON.stringify(execute.mock.calls)).toContain("do nothing");
  });

  it("never throws, even though a failure here is the serious one", async () => {
    execute.mockRejectedValue(new Error("db down"));
    await expect(
      suppressPhone("store-1", "9876543210"),
    ).resolves.toBeUndefined();
  });

  it("clears an opt-out for START", async () => {
    await unsuppressPhone("store-1", "9876543210");
    expect(JSON.stringify(execute.mock.calls)).toContain("delete");
  });

  it("does nothing for an unusable number", async () => {
    await suppressPhone("store-1", "");
    await unsuppressPhone("store-1", "");
    expect(execute).not.toHaveBeenCalled();
  });
});
