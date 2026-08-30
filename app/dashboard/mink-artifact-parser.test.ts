import { describe, expect, it } from "vitest";
import { readMinkArtifacts } from "./mink-artifact-parser";

describe("readMinkArtifacts", () => {
  it("restores proposal cards alongside read-only artifacts", () => {
    const artifacts = ["metrics", "records", "sources", "proposal"].map(
      (type) => ({ type, marker: type }),
    );

    expect(readMinkArtifacts(artifacts).map((item) => item.type)).toEqual([
      "metrics",
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
});
