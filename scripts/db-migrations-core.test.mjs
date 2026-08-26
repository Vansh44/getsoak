import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
    expect(loaded.migrations).toHaveLength(25);
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
    expect(loaded.migrations[3]).toMatchObject({
      id: "20260816_0004_ai_credit_invoice_paid_repair",
      transaction: true,
    });
    expect(loaded.migrations[3].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[4]).toMatchObject({
      id: "20260818_0005_analytics_dashboard_layouts",
      transaction: true,
    });
    expect(loaded.migrations[4].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[5]).toMatchObject({
      id: "20260819_0006_search_metrics",
      transaction: true,
    });
    expect(loaded.migrations[5].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[6]).toMatchObject({
      id: "20260820_0007_platform_analytics_controls",
      transaction: true,
    });
    expect(loaded.migrations[6].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[7]).toMatchObject({
      id: "20260820_0008_analytics_help_documents",
      transaction: true,
    });
    expect(loaded.migrations[7].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[8]).toMatchObject({
      id: "20260820_0009_help_article_indexability",
      transaction: true,
    });
    expect(loaded.migrations[8].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[9]).toMatchObject({
      id: "20260820_0010_merchant_pixels",
      transaction: true,
    });
    expect(loaded.migrations[9].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[10]).toMatchObject({
      id: "20260820_0011_storefront_conversion",
      transaction: true,
    });
    expect(loaded.migrations[10].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[11]).toMatchObject({
      id: "20260820_0012_gross_margin",
      transaction: true,
    });
    expect(loaded.migrations[12]).toMatchObject({
      id: "20260822_0013_payment_shift_attribution",
      transaction: true,
    });
    expect(loaded.migrations[12].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[13]).toMatchObject({
      id: "20260823_0014_store_deletion_cascade",
      transaction: true,
    });
    expect(loaded.migrations[13].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[14]).toMatchObject({
      id: "20260825_0015_pos_help_documents",
      transaction: true,
    });
    expect(loaded.migrations[14].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[15]).toMatchObject({
      id: "20260825_0016_help_assistant_guide",
      transaction: true,
    });
    expect(loaded.migrations[15].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[15].sql).toMatch(
      /\$article\$,\s*'published',\s*'How to use Mink AI in the StoreMink Help Centre'/,
    );
    expect(loaded.migrations[16]).toMatchObject({
      id: "20260825_0017_help_article_embeddings",
      transaction: true,
      requires: ["20260825_0016_help_assistant_guide"],
      verify: {
        tables: ["help_article_chunks"],
        rlsTables: ["help_article_chunks"],
      },
      applyVerify: {
        queries: expect.arrayContaining([
          expect.objectContaining({
            name: "Mink AI guide explains hybrid published-guide retrieval",
          }),
        ]),
      },
      adoptVerify: {
        queries: expect.arrayContaining([
          expect.objectContaining({
            name: "Mink AI guide explains hybrid published-guide retrieval",
          }),
        ]),
      },
    });
    expect(loaded.migrations[16].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[16].sql).toMatch(
      /CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public/,
    );
    expect(loaded.migrations[16].sql).toMatch(
      /embedding\s+public\.vector\(768\) NOT NULL/,
    );
    expect(loaded.migrations[16].sql).toMatch(/heading_level BETWEEN 1 AND 6/);
    expect(loaded.migrations[16].sql).toMatch(/chunk_index >= 0/);
    expect(loaded.migrations[16].sql).not.toMatch(/chunk_count/);
    expect(loaded.migrations[16].sql).not.toMatch(/index_version/);
    expect(loaded.migrations[17]).toMatchObject({
      id: "20260826_0018_help_embedding_hardening",
      requires: ["20260825_0017_help_article_embeddings"],
      verify: {
        columns: [
          "help_article_chunks.chunk_count",
          "help_article_chunks.index_version",
        ],
      },
    });
    expect(loaded.migrations[17].sql).toMatch(
      /chunk_index >= 0 AND chunk_index < chunk_count/,
    );
    expect(loaded.migrations[17].sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_store_search_rate_slot\(text, integer\)[\s\S]*FROM app_user/,
    );
    expect(
      loaded.migrations.slice(18, 24).map((migration) => migration.id),
    ).toEqual([
      "20260826_0019_getting_started_account_help",
      "20260826_0020_storefront_domains_help",
      "20260826_0021_products_customers_help",
      "20260826_0022_payments_tax_help",
      "20260826_0023_orders_shipping_help",
      "20260826_0024_marketing_communications_help",
    ]);
    expect(
      loaded.migrations.slice(18, 24).map((migration) => migration.requires),
    ).toEqual([
      ["20260826_0018_help_embedding_hardening"],
      ["20260826_0019_getting_started_account_help"],
      ["20260826_0020_storefront_domains_help"],
      ["20260826_0021_products_customers_help"],
      ["20260826_0022_payments_tax_help"],
      ["20260826_0023_orders_shipping_help"],
    ]);
    for (const migration of loaded.migrations.slice(18, 24)) {
      expect(migration.transaction).toBe(true);
      expect(migration.verify).toEqual({});
      expect(migration.applyVerify?.queries).toEqual(expect.any(Array));
      expect(migration.adoptVerify?.queries).toEqual(expect.any(Array));
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);

      for (const contract of [migration.applyVerify, migration.adoptVerify]) {
        const articleCheck = contract.queries.find((query) =>
          query.name.includes("guides are complete and published"),
        );
        expect(articleCheck?.sql).toContain("length(trim(a.title)) > 0");
      }
    }
    expect(loaded.migrations[24]).toMatchObject({
      id: "20260826_0025_mink_ai_fullscreen_help",
      transaction: true,
      requires: ["20260826_0024_marketing_communications_help"],
      verify: {},
      applyVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("clarification guidance"),
            equals: "1",
          }),
        ],
      },
      adoptVerify: {
        queries: [
          expect.objectContaining({
            name: expect.stringContaining("clarification guidance"),
            equals: "1",
          }),
        ],
      },
    });
    expect(loaded.migrations[24].checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.migrations[24].sql).toContain(
      "at the beginning of the new answer",
    );
    expect(loaded.migrations[24].sql).toContain(
      "non-clickable examples of details you can add",
    );
    const repairChecks = [
      loaded.migrations[22].applyVerify,
      loaded.migrations[22].adoptVerify,
    ].map((contract) =>
      contract.queries.find((query) =>
        query.name.includes("POS and Analytics Help statements"),
      ),
    );
    for (const repairCheck of repairChecks) {
      expect(repairCheck?.equals).toBe("6");
      expect(repairCheck?.sql).toContain("where status = 'published'");
      expect(repairCheck?.sql).toContain(
        "Their setup guides are available to eligible merchants",
      );
      expect(repairCheck?.sql).toContain("take-returns-at-the-counter");
      expect(repairCheck?.sql).toContain(
        "refunds-store-credit-exchanges-and-credit-notes",
      );
    }
    for (const contract of [
      loaded.migrations[22].applyVerify,
      loaded.migrations[22].adoptVerify,
    ]) {
      expect(
        contract.queries.find((query) =>
          query.name.includes("controlled-live warning"),
        ),
      ).toMatchObject({ equals: "5" });
      expect(
        contract.queries.find((query) =>
          query.name.includes("spent-credit cleanup"),
        ),
      ).toMatchObject({ equals: "2" });
    }
    expect(loaded.migrations[7]).toMatchObject({
      id: "20260820_0008_analytics_help_documents",
      verify: {},
      applyVerify: { queries: expect.any(Array) },
      adoptVerify: { queries: expect.any(Array) },
    });
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
    expect(plan.outOfOrder).toEqual([]);
  });

  it("detects a valid later ledger row after a missing migration", () => {
    const plan = migrationPlan(manifest, [
      { id: "baseline:x", checksum: "base" },
      { id: "002_second", checksum: "two" },
    ]);

    expect(plan.pending.map((migration) => migration.id)).toEqual([
      "001_first",
    ]);
    expect(plan.outOfOrder).toEqual([{ id: "002_second" }]);
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
    expect(
      parseCli([
        "audit",
        "--environment",
        "staging",
        "--through",
        "002_second",
      ]),
    ).toEqual({
      command: "audit",
      environment: "staging",
      through: "002_second",
    });
    expect(
      parseCli([
        "adopt",
        "--environment",
        "staging",
        "--migration",
        "002_second",
        "--confirm-adopt",
        "002_second",
        "--confirm-checksum",
        "a".repeat(64),
        "--confirm-database",
        "storemink_staging",
      ]),
    ).toEqual({
      command: "adopt",
      environment: "staging",
      migration: "002_second",
      "confirm-adopt": "002_second",
      "confirm-checksum": "a".repeat(64),
      "confirm-database": "storemink_staging",
    });
    expect(() => parseCli(["apply"])).toThrow("--environment is required");
    expect(() => parseCli(["adopt", "--environment", "staging"])).toThrow(
      "adopt requires --migration",
    );
    expect(() =>
      parseCli([
        "adopt",
        "--environment",
        "staging",
        "--migration",
        "002_second",
      ]),
    ).toThrow("adopt requires --confirm-adopt");
    expect(() =>
      parseCli([
        "adopt",
        "--environment",
        "staging",
        "--migration",
        "002_second",
        "--confirm-adopt",
        "001_first",
        "--confirm-checksum",
        "a".repeat(64),
        "--confirm-database",
        "storemink_staging",
      ]),
    ).toThrow("--confirm-adopt to match");
    expect(() =>
      parseCli([
        "verify",
        "--environment",
        "staging",
        "--environment",
        "production",
      ]),
    ).toThrow("Duplicate flag");
    expect(() =>
      parseCli(["verify", "--environment", "staging", "--typo", "yes"]),
    ).toThrow("Unknown flag");
    expect(() => parseCli(["destroy", "--environment", "local"])).toThrow(
      "Usage",
    );
  });

  it("fingerprints public aggregates without decompiling them as functions", async () => {
    const runner = await readFile(
      path.resolve(process.cwd(), "scripts/db-migrate.mjs"),
      "utf8",
    );

    expect(runner).toMatch(
      /when p\.prokind in \('f', 'p'\) then pg_get_functiondef\(p\.oid\)/,
    );
    expect(runner).toContain("concat('kind=', p.prokind)");
    expect(runner).toContain("join pg_language l on l.oid = p.prolang");
  });

  it("never falls back from the migration administrator to the app login", async () => {
    const runner = await readFile(
      path.resolve(process.cwd(), "scripts/db-migrate.mjs"),
      "utf8",
    );

    expect(runner).toContain("DB_ADMIN_USER is required");
    expect(runner).not.toContain(
      "process.env.DB_ADMIN_USER ?? process.env.DB_USER",
    );
    expect(runner).toContain(
      "revoke all on ${LEDGER} from public, app_user, app_service",
    );
  });

  it("adopts only verified schema in one serializable ledger transaction", async () => {
    const runner = await readFile(
      path.resolve(process.cwd(), "scripts/db-migrate.mjs"),
      "utf8",
    );

    expect(runner).toContain(
      'client.query("begin isolation level serializable")',
    );
    expect(runner).toContain("const lockedRows = await appliedRows(client)");
    expect(runner).toContain(
      "const lockedPlan = migrationPlan(manifest, lockedRows)",
    );
    expect(runner).toMatch(/`adopt:\$\{migration\.file\}`/);
    expect(runner).toContain("`adoption ${migration.id}`");
    expect(runner).toContain('await client.query("rollback")');
  });

  it("runs adoption audits in a database-enforced read-only transaction", async () => {
    const runner = await readFile(
      path.resolve(process.cwd(), "scripts/db-migrate.mjs"),
      "utf8",
    );

    expect(runner).toContain(
      'client.query("begin isolation level repeatable read read only")',
    );
    expect(runner).toContain(
      "ADOPTION AUDIT — migration SQL and ledger writes are disabled.",
    );
  });
});
