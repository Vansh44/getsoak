import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = path.resolve(
  SCRIPT_DIR,
  "../drizzle/migrations/manifest.json",
);

export const ENV_DATABASES = Object.freeze({
  local: null,
  staging: "storemink_staging",
  production: "storemink",
});

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertIdentifier(id, kind) {
  if (!/^[a-z0-9][a-z0-9:_-]*$/.test(id)) {
    throw new Error(`Invalid ${kind} id: ${id}`);
  }
}

function assertVerifyContract(verify, context) {
  if (!verify || typeof verify !== "object") {
    throw new Error(`${context} needs a verify contract`);
  }
  for (const key of [
    "tables",
    "columns",
    "constraints",
    "rlsTables",
    "functions",
    "queries",
  ]) {
    if (verify[key] !== undefined && !Array.isArray(verify[key])) {
      throw new Error(`${context}.verify.${key} must be an array`);
    }
  }
  for (const query of verify.queries ?? []) {
    if (
      !query ||
      typeof query.name !== "string" ||
      typeof query.sql !== "string" ||
      !/^select\b/i.test(query.sql.trim()) ||
      query.sql.includes(";") ||
      !("equals" in query)
    ) {
      throw new Error(`${context}.verify.queries contains an invalid check`);
    }
  }
}

export async function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  const absolutePath = path.resolve(manifestPath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8"));
  if (parsed.version !== 1) throw new Error("Unsupported migration manifest");
  if (!parsed.baseline?.id)
    throw new Error("Migration manifest has no baseline");
  assertIdentifier(parsed.baseline.id, "baseline");
  assertVerifyContract(parsed.baseline.verify, "baseline");
  if (!Array.isArray(parsed.migrations)) {
    throw new Error("Migration manifest has no migrations array");
  }

  const seen = new Set([parsed.baseline.id]);
  const baseDir = path.dirname(absolutePath);
  const migrations = [];
  for (const entry of parsed.migrations) {
    assertIdentifier(entry.id, "migration");
    if (seen.has(entry.id))
      throw new Error(`Duplicate migration id: ${entry.id}`);
    seen.add(entry.id);
    if (!entry.file || typeof entry.file !== "string") {
      throw new Error(`Migration ${entry.id} has no file`);
    }
    if (entry.transaction !== true) {
      throw new Error(
        `Migration ${entry.id} must explicitly use a transaction; add runner support before opting out`,
      );
    }
    if (!Array.isArray(entry.requires)) {
      throw new Error(`Migration ${entry.id} must declare requires`);
    }
    assertVerifyContract(entry.verify, `migration ${entry.id}`);
    if (entry.applyVerify !== undefined) {
      assertVerifyContract(
        entry.applyVerify,
        `migration ${entry.id}.applyVerify`,
      );
    }
    if (entry.adoptVerify !== undefined) {
      assertVerifyContract(
        entry.adoptVerify,
        `migration ${entry.id}.adoptVerify`,
      );
    }
    const sqlPath = path.resolve(baseDir, entry.file);
    const sql = await readFile(sqlPath, "utf8");
    if (!sql.trim()) throw new Error(`Migration ${entry.id} is empty`);
    const metadata = { ...entry };
    delete metadata.file;
    migrations.push({
      ...entry,
      sqlPath,
      sql,
      checksum: sha256(`${canonicalJson(metadata)}\0${sql}`),
    });
  }

  const baseline = {
    ...parsed.baseline,
    checksum: sha256(canonicalJson(parsed.baseline)),
  };
  return { path: absolutePath, baseline, migrations };
}

export function validateEnvironment(environment, database, mutating = false) {
  if (!(environment in ENV_DATABASES)) {
    throw new Error("--environment must be local, staging, or production");
  }
  const expected = ENV_DATABASES[environment];
  if (expected && database !== expected) {
    throw new Error(
      `Environment guard refused ${environment}: connected to ${database}, expected ${expected}`,
    );
  }
  if (mutating && environment === "production") {
    return { needsProductionConfirmation: true };
  }
  return { needsProductionConfirmation: false };
}

export function migrationPlan(manifest, appliedRows) {
  const applied = new Map(appliedRows.map((row) => [row.id, row]));
  const known = new Set([
    manifest.baseline.id,
    ...manifest.migrations.map((migration) => migration.id),
  ]);
  const unknown = appliedRows.filter((row) => !known.has(row.id));
  const drifted = [];
  const pending = [];
  const outOfOrder = [];

  const baselineRow = applied.get(manifest.baseline.id);
  if (baselineRow && baselineRow.checksum !== manifest.baseline.checksum) {
    drifted.push({
      id: manifest.baseline.id,
      expected: manifest.baseline.checksum,
      actual: baselineRow.checksum,
    });
  }
  let sawGap = !baselineRow;
  for (const migration of manifest.migrations) {
    const row = applied.get(migration.id);
    if (!row) {
      pending.push(migration);
      sawGap = true;
    } else {
      if (sawGap) outOfOrder.push({ id: row.id });
      if (row.checksum === migration.checksum) continue;
      drifted.push({
        id: migration.id,
        expected: migration.checksum,
        actual: row.checksum,
      });
    }
  }

  return {
    baselineApplied: Boolean(baselineRow),
    drifted,
    pending,
    unknown,
    outOfOrder,
  };
}

export function parseCli(argv) {
  const [command, ...rest] = argv;
  if (
    !command ||
    !["status", "baseline", "apply", "verify", "audit", "adopt"].includes(
      command,
    )
  ) {
    throw new Error(
      "Usage: db-migrate <status|baseline|apply|verify|audit|adopt> --environment <local|staging|production>",
    );
  }
  const allowedFlags = {
    status: new Set(["environment", "manifest"]),
    baseline: new Set([
      "environment",
      "manifest",
      "commit",
      "confirm-production",
    ]),
    apply: new Set(["environment", "manifest", "commit", "confirm-production"]),
    verify: new Set(["environment", "manifest"]),
    audit: new Set(["environment", "through"]),
    adopt: new Set([
      "environment",
      "migration",
      "confirm-adopt",
      "confirm-checksum",
      "confirm-database",
      "confirm-production",
      "commit",
    ]),
  }[command];
  const options = { command };
  const seenFlags = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`);
    const key = flag.slice(2);
    if (!allowedFlags.has(key)) {
      throw new Error(`Unknown flag for ${command}: ${flag}`);
    }
    if (seenFlags.has(key)) {
      throw new Error(`Duplicate flag: ${flag}`);
    }
    seenFlags.add(key);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    options[key] = value;
    index += 1;
  }
  if (!options.environment) throw new Error("--environment is required");
  if (options.through) assertIdentifier(options.through, "migration");
  if (command === "adopt") {
    if (!options.migration) {
      throw new Error("adopt requires --migration <migration-id>");
    }
    assertIdentifier(options.migration, "migration");
    if (options["confirm-adopt"] !== options.migration) {
      throw new Error("adopt requires --confirm-adopt to match --migration");
    }
    if (!/^[0-9a-f]{64}$/.test(options["confirm-checksum"] ?? "")) {
      throw new Error("adopt requires --confirm-checksum <64-hex-checksum>");
    }
    if (!options["confirm-database"]) {
      throw new Error("adopt requires --confirm-database <database-name>");
    }
  }
  return options;
}
