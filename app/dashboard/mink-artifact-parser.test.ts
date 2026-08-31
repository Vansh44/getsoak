import { describe, expect, it } from "vitest";
import { readMinkArtifacts } from "./mink-artifact-parser";

describe("readMinkArtifacts", () => {
  it("restores proposal cards alongside read-only artifacts", () => {
    const artifacts = [
      { type: "metrics", marker: "metrics" },
      {
        type: "catalog",
        marker: "catalog",
        counts: {},
        items: [],
        filters: [],
      },
      { type: "records", marker: "records" },
      { type: "sources", marker: "sources" },
      { type: "proposal", marker: "proposal" },
    ];

    expect(readMinkArtifacts(artifacts).map((item) => item.type)).toEqual([
      "metrics",
      "catalog",
      "records",
      "sources",
      "proposal",
    ]);
  });

  it("rejects unknown values and preserves the six-artifact bound", () => {
    const valid = Array.from({ length: 8 }, () => ({ type: "metrics" }));
    expect(
      readMinkArtifacts([null, { type: "unknown" }, ...valid]),
    ).toHaveLength(6);
  });

  it("rejects malformed or oversized catalogue artifacts", () => {
    expect(
      readMinkArtifacts([
        { type: "catalog" },
        {
          type: "catalog",
          counts: {},
          items: Array.from({ length: 21 }, () => ({})),
          filters: [],
        },
      ]),
    ).toEqual([]);
  });
});
