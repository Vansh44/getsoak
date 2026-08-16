import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  loadManifest,
  migrationPlan,
  parseCli,
  sha256,
  validateEnvironment,
} from "./db-migrations-core.mjs";

const manifest = {
  baseline: { id: "baseline:x", checksum: "base" },
  migrations: [
    { id: "001_first", checksum: "one" },
    { id: "002_second", checksum: "two" },
  ],
};

describe("database migration controls", () => {
  it("loads the repository manifest and checksums the enrolled SQL", async () => {
    const loaded = await loadManifest();
    expect(loaded.baseline.id).toBe("baseline:cloudsql-2026-08-14");
    expect(loaded.migrations).toHaveLength(3);
    expect(loaded.migrations[0]).toMatchObject({
      id: "20260814_0001_logistics_shiprocket",
      transaction: true,
    });
    expect(loaded.migrations[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[1]).toMatchObject({
      id: "20260814_0002_schema_drift_repair",
      transaction: true,
    });
    expect(loaded.migrations[2]).toMatchObject({
      id: "20260816_0003_pos_pickup_prepared_at",
      transaction: true,
    });
    expect(loaded.migrations[2].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalizes objects before hashing", () => {
    expect(canonicalJson({ b: 2, a: [3, { z: true }] })).toBe(
      '{"a":[3,{"z":true}],"b":2}',
    );
    expect(sha256("same")).toBe(sha256("same"));
    expect(sha256("same")).not.toBe(sha256("changed"));
  });

  it("reports pending migrations only after a baseline", () => {
    expect(migrationPlan(manifest, [])).toMatchObject({
      baselineApplied: false,
      pending: [{ id: "001_first" }, { id: "002_second" }],
      drifted: [],
      unknown: [],
    });
  });

  it("fails closed on changed and unknown ledger entries", () => {
    const plan = migrationPlan(manifest, [
      { id: "baseline:x", checksum: "wrong" },
      { id: "001_first", checksum: "one" },
      { id: "hand_applied", checksum: "mystery" },
    ]);
    expect(plan.drifted).toEqual([
      { id: "baseline:x", expected: "base", actual: "wrong" },
    ]);
    expect(plan.unknown).toEqual([{ id: "hand_applied", checksum: "mystery" }]);
    expect(plan.pending.map((migration) => migration.id)).toEqual([
      "002_second",
    ]);
  });

  it("guards the physical database behind each environment name", () => {
    expect(validateEnvironment("staging", "storemink_staging")).toEqual({
      needsProductionConfirmation: false,
    });
    expect(() => validateEnvironment("staging", "storemink")).toThrow(
      "expected storemink_staging",
    );
    expect(validateEnvironment("production", "storemink", true)).toEqual({
      needsProductionConfirmation: true,
    });
  });

  it("requires explicit command and environment arguments", () => {
    expect(parseCli(["verify", "--environment", "staging"])).toEqual({
      command: "verify",
      environment: "staging",
    });
    expect(() => parseCli(["apply"])).toThrow("--environment is required");
    expect(() => parseCli(["destroy", "--environment", "local"])).toThrow(
      "Usage",
    );
  });
});
