// The Failures log — merge ordering and partial-failure behaviour.
//
// The per-source queries are thin drizzle selects and are verified by reading,
// like lib/domains/reconcile.ts. What has a decision in it — how rows from
// five tables interleave, and what happens when one table is unreachable — is
// exercised here.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

// The module builds drizzle queries at import time; nothing here runs them.
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn({})),
}));

import {
  FAILURE_SOURCES,
  collectFailures,
  mergeFailures,
  type FailureRow,
  type FailureSource,
} from "./failures";
import { FAILURE_SOURCE_META } from "./failure-types";

function row(id: string, occurredAt: string): FailureRow {
  return {
    id,
    source: "email",
    title: id,
    detail: null,
    occurredAt,
    storeId: "s1",
    href: null,
  };
}

function source(
  key: string,
  rows: FailureRow[],
  throws = false,
): FailureSource {
  return {
    key: key as FailureSource["key"],
    label: key,
    blurb: "",
    fetch: throws
      ? vi.fn().mockRejectedValue(new Error("relation does not exist"))
      : vi.fn().mockResolvedValue(rows),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("mergeFailures", () => {
  it("interleaves sources newest first", () => {
    const merged = mergeFailures([
      [row("a", "2026-08-01T10:00:00Z"), row("b", "2026-08-03T10:00:00Z")],
      [row("c", "2026-08-02T10:00:00Z")],
    ]);
    expect(merged.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("orders ties by id so a batch that failed together doesn't shuffle", () => {
    // The common case: one send batch fails, every row carrying the same
    // timestamp. Without the tiebreak the order changes between refreshes.
    const same = "2026-08-01T10:00:00Z";
    const first = mergeFailures([[row("z", same)], [row("a", same)]]);
    const second = mergeFailures([[row("a", same)], [row("z", same)]]);
    expect(first.map((r) => r.id)).toEqual(["a", "z"]);
    expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  });

  it("caps the merged list", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row(`r${i}`, `2026-08-0${(i % 9) + 1}T10:00:00Z`),
    );
    expect(mergeFailures([rows], 3)).toHaveLength(3);
  });

  it("returns nothing when every source is empty", () => {
    expect(mergeFailures([[], []])).toEqual([]);
  });
});

describe("the two catalogs stay in step", () => {
  // The client renders filter chips from FAILURE_SOURCE_META while the server
  // queries FAILURE_SOURCES. They live in different files so the browser
  // bundle doesn't pull in `pg`, which means they can drift: a chip with no
  // source behind it filters to a permanently empty list, and a source with no
  // chip is unreachable.
  it("has the same keys in the same order", () => {
    expect(FAILURE_SOURCES.map((s) => s.key)).toEqual(
      FAILURE_SOURCE_META.map((m) => m.key),
    );
  });

  it("carries the label and blurb through from the metadata", () => {
    for (const source of FAILURE_SOURCES) {
      const meta = FAILURE_SOURCE_META.find((m) => m.key === source.key);
      expect(source.label).toBe(meta?.label);
      expect(source.blurb).toBe(meta?.blurb);
    }
  });
});

const STORE = { kind: "store", storeId: "s1" } as const;

describe("collectFailures", () => {
  it("names a source that failed rather than silently shortening the list", async () => {
    // A short list that looks clean is the failure mode worth preventing:
    // this view is read precisely when things are broken.
    const registry = [
      source("email", [row("a", "2026-08-01T10:00:00Z")]),
      source("refund", [], true),
    ];

    const feed = await collectFailures(STORE, { registry });

    expect(feed.rows.map((r) => r.id)).toEqual(["a"]);
    expect(feed.failedSources).toEqual(["refund"]);
  });

  it("still returns rows when EVERY source fails", async () => {
    const registry = [source("email", [], true), source("refund", [], true)];
    const feed = await collectFailures(STORE, { registry });
    expect(feed.rows).toEqual([]);
    expect(feed.failedSources.sort()).toEqual(["email", "refund"]);
  });

  it("queries only the sources asked for", async () => {
    const email = source("email", [row("a", "2026-08-01T10:00:00Z")]);
    const refund = source("refund", [row("b", "2026-08-02T10:00:00Z")]);

    const feed = await collectFailures(STORE, {
      registry: [email, refund],
      sources: ["refund"],
    });

    expect(feed.rows.map((r) => r.id)).toEqual(["b"]);
    expect(email.fetch).not.toHaveBeenCalled();
  });

  it("passes the scope through to each source untouched", async () => {
    // ★ The scope is what keeps one store's failures out of another's view.
    const email = source("email", []);
    await collectFailures(STORE, { registry: [email] });
    expect(email.fetch).toHaveBeenCalledWith(STORE, expect.any(Number));

    const platform = { kind: "platform" } as const;
    await collectFailures(platform, { registry: [email] });
    expect(email.fetch).toHaveBeenLastCalledWith(platform, expect.any(Number));
  });
});
