import { spawn } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const devCacheDir = path.join(projectRoot, ".next", "dev");
const nextBin = path.join(
  projectRoot,
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);
const MB = 1024 * 1024;

function numericArg(prefix) {
  const raw = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (!raw) return null;
  const value = Number(raw.slice(prefix.length));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function directoryBytes(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  let bytes = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      bytes += await directoryBytes(target);
    } else if (entry.isFile()) {
      bytes += (await stat(target)).size;
    }
  }
  return bytes;
}

async function resetDevCache(reason) {
  const bytes = await directoryBytes(devCacheDir);
  if (bytes === 0) return false;
  console.log(
    `[dev] ${reason}: removing ${(bytes / MB / 1024).toFixed(1)} GB of generated .next/dev cache.`,
  );
  await rm(devCacheDir, { recursive: true, force: true });
  return true;
}

if (process.argv.includes("--reset-cache")) {
  const removed = await resetDevCache("manual reset");
  if (!removed) console.log("[dev] .next/dev is already empty.");
  process.exit(0);
}

const cacheLimitMb = Number(process.env.DEV_CACHE_MAX_MB ?? 3072);
if (Number.isFinite(cacheLimitMb) && cacheLimitMb > 0) {
  const cacheBytes = await directoryBytes(devCacheDir);
  if (cacheBytes > cacheLimitMb * MB) {
    await resetDevCache(`cache exceeded ${cacheLimitMb} MB`);
  }
}

const memoryGb = totalmem() / 1024 ** 3;
const explicitHeapMb = numericArg("--heap-mb=");
const heapMb =
  explicitHeapMb ?? (memoryGb <= 12 ? 2048 : memoryGb <= 20 ? 3072 : 0);

const inheritedNodeOptions = (process.env.NODE_OPTIONS ?? "")
  .replace(/--max-old-space-size(?:=|\s+)\d+/g, "")
  .trim();
const nodeOptions = [
  inheritedNodeOptions,
  heapMb > 0 ? `--max-old-space-size=${heapMb}` : "",
]
  .filter(Boolean)
  .join(" ");
const childEnv = { ...process.env };
if (nodeOptions) childEnv.NODE_OPTIONS = nodeOptions;
else delete childEnv.NODE_OPTIONS;
const nextArgs = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--heap-mb=") && arg !== "--reset-cache");

if (heapMb > 0) {
  console.log(
    `[dev] ${memoryGb.toFixed(0)} GB RAM detected; limiting Next.js to a ${heapMb} MB V8 heap.`,
  );
  console.log(
    "[dev] Use npm run dev:full only when an uncapped heap is needed.",
  );
} else {
  console.log(
    `[dev] ${memoryGb.toFixed(0)} GB RAM detected; using an uncapped Next.js heap.`,
  );
}

const child = spawn(
  process.execPath,
  [nextBin, "dev", "--turbopack", ...nextArgs],
  {
    cwd: projectRoot,
    env: childEnv,
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error("[dev] Failed to start Next.js:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
