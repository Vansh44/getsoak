import { execFileSync, spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const devCacheDir = path.join(projectRoot, ".next", "dev");
// Turbopack's persistent dev cache is a SUBTREE of the above, and needs its own
// name because it is reclaimed on its own when the filesystem cache is off —
// the rest of .next/dev is this session's compiled output.
const devFsCacheDir = path.join(devCacheDir, "cache");
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

// Preserve warm compiles across restarts. Cache size is not RAM usage.
// Rotation is opt-in for machines where disk space, rather than RAM, is scarce.
const cacheLimitMb = Number(process.env.DEV_CACHE_MAX_MB ?? 0);
if (Number.isFinite(cacheLimitMb) && cacheLimitMb > 0) {
  const cacheBytes = await directoryBytes(devCacheDir);
  if (cacheBytes > cacheLimitMb * MB) {
    await resetDevCache(`cache exceeded ${cacheLimitMb} MB`);
  }
}

// Best-effort Spotlight markers, not a verified performance fix. Recreate
// after npm ci / cache reset; failure must not prevent development.
async function ensureNoIndexMarkers() {
  for (const dir of [".next", "node_modules", "coverage"]) {
    const target = path.join(projectRoot, dir);
    try {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, ".metadata_never_index"), "", {
        flag: "a",
      });
    } catch {
      // Best effort, always. A read-only volume or a permissions quirk must
      // never stop the dev server booting over a performance nicety.
    }
  }
}

await ensureNoIndexMarkers();

const memoryGb = totalmem() / 1024 ** 3;

// ★ THE BUNDLER IS CHOSEN BEFORE THE CACHE POLICY, because the policy is
// Turbopack-only and would otherwise be applied to a Webpack run.
const explicitBundler = process.argv
  .slice(2)
  .find((arg) => ["--webpack", "--turbopack", "--turbo"].includes(arg));
const bundlerArgs = explicitBundler
  ? []
  : [memoryGb <= 12 ? "--webpack" : "--turbopack"];
const usingTurbopack = explicitBundler
  ? explicitBundler !== "--webpack"
  : !bundlerArgs.includes("--webpack");

// ★★ TURBOPACK'S DEV FILESYSTEM CACHE, WHICH IS A DEFAULT AS OF NEXT 16.1.
//
// It writes and periodically COMPACTS a database under `.next/dev/cache`, and
// those writes are neither free nor fully in the background. Measured on an
// 8 GB M2 with a 2.88 GB cache: a 2.5-MINUTE cache write, during which an
// ordinary request logged `102s (next.js: 101s, application-code: 1564ms)`.
// ★ READ THAT SPLIT — 101 s of framework against 1.5 s of app code, so it is
// NOT the ~46 ms Mumbai round trip, which is the tempting and wrong lead.
// The cost is disk IO, and on a small machine the SSD is already saturated by
// macOS paging, so the cache amplifies the very thrash it is competing with.
//
// ⚠ ONLY MEANINGFUL UNDER TURBOPACK. On a ≤12 GB machine this runner now picks
// WEBPACK by default (see above), so in practice this applies when Turbopack is
// forced on a small machine, and it leaves the cache ON where there is RAM to
// spare and no swap to compete with.
const FS_CACHE_MIN_MEMORY_GB = 12;

function resolveFsCache() {
  if (!usingTurbopack) return { enabled: false, reason: "Webpack" };
  if (process.argv.includes("--no-fs-cache"))
    return { enabled: false, reason: "--no-fs-cache" };
  if (process.argv.includes("--fs-cache"))
    return { enabled: true, reason: "--fs-cache" };
  const override = process.env.DEV_FS_CACHE;
  if (override === "0" || override === "false")
    return { enabled: false, reason: "DEV_FS_CACHE=0" };
  if (override === "1" || override === "true")
    return { enabled: true, reason: "DEV_FS_CACHE=1" };
  return {
    enabled: memoryGb > FS_CACHE_MIN_MEMORY_GB,
    reason: `${memoryGb.toFixed(0)} GB RAM`,
  };
}

const fsCache = resolveFsCache();

// Nothing reads this subtree while the cache is off — under Webpack, nothing
// reads it at all — so it is dead disk on the volume macOS grows swap on.
if (!fsCache.enabled) {
  const staleBytes = await directoryBytes(devFsCacheDir);
  if (staleBytes > 0) {
    // Announce it only when it is worth knowing about. A few stray bytes
    // reported as "reclaiming 0.0 GB" is noise on every single start.
    if (staleBytes > 64 * MB) {
      console.log(
        `[dev] reclaiming ${(staleBytes / MB / 1024).toFixed(1)} GB of .next/dev/cache (Turbopack filesystem cache, not in use).`,
      );
    }
    await rm(devFsCacheDir, { recursive: true, force: true });
  }
}
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
// next.config.ts is the only place the flag can be set, and it is evaluated
// inside the Next process — so the decision travels as an env var rather than
// being computed twice. Left UNSET under Webpack and for a bare `npx next dev`,
// where Next's own default should stand.
if (usingTurbopack) childEnv.NEXT_DEV_FS_CACHE = fsCache.enabled ? "1" : "0";
if (nodeOptions) childEnv.NODE_OPTIONS = nodeOptions;
else delete childEnv.NODE_OPTIONS;
const nextArgs = process.argv
  .slice(2)
  .filter(
    (arg) =>
      !arg.startsWith("--heap-mb=") &&
      arg !== "--reset-cache" &&
      arg !== "--fs-cache" &&
      arg !== "--no-fs-cache",
  );

// V8's old-space cap excludes native allocations and buffers. It is not a
// process-wide RAM limit, especially with Turbopack's Rust module graph.
// Swap usage is historical context, not a measurement of current paging rate.
function memoryPreflight() {
  let swapUsedMb = 0;
  let swapTotalMb = 0;
  try {
    const raw = execFileSync("sysctl", ["-n", "vm.swapusage"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    swapTotalMb = Number(/total\s*=\s*([\d.]+)M/.exec(raw)?.[1] ?? 0);
    swapUsedMb = Number(/used\s*=\s*([\d.]+)M/.exec(raw)?.[1] ?? 0);
  } catch {
    return; // Not macOS, or sysctl unavailable — a warning is a nicety, never a gate.
  }
  if (!swapTotalMb) return;

  const ratio = swapUsedMb / swapTotalMb;
  if (ratio < 0.6) return;

  console.log("");
  console.log(
    `[dev] ⚠  Swap is ${(ratio * 100).toFixed(0)}% full (${(swapUsedMb / 1024).toFixed(1)} GB of ${(swapTotalMb / 1024).toFixed(1)} GB) BEFORE this server starts.`,
  );
  console.log(
    "[dev]    Check Activity Monitor → Memory Pressure; swap usage alone does not prove active thrashing.",
  );
  console.log(
    "[dev]    Close unused heavy apps and restart the dev server if pressure is high. Keep the warm cache.",
  );
  console.log("");
}

memoryPreflight();

if (heapMb > 0) {
  console.log(
    `[dev] ${memoryGb.toFixed(0)} GB RAM detected; capping V8's old space at ${heapMb} MB.`,
  );
  console.log(
    "[dev] Note: this bounds V8 only — native memory and buffers are outside it, so total",
  );
  console.log(
    "[dev] RSS still grows through a session. Restart the server when it feels sluggish.",
  );
} else {
  console.log(
    `[dev] ${memoryGb.toFixed(0)} GB RAM detected; using an uncapped Next.js heap.`,
  );
}

console.log(
  `[dev] Bundler: ${usingTurbopack ? "Turbopack" : "Webpack"}; preserving compilation caches.`,
);
if (usingTurbopack) {
  if (fsCache.enabled) {
    console.log(
      `[dev] Turbopack filesystem cache: ON (${fsCache.reason}).` +
        (Number(process.env.DEV_CACHE_MAX_MB ?? 0) > 0
          ? ` Rotated past ${Number(process.env.DEV_CACHE_MAX_MB)} MB.`
          : ""),
    );
  } else {
    console.log(
      `[dev] Turbopack filesystem cache: OFF (${fsCache.reason}) — it stalls requests on a swapping machine.`,
    );
    console.log(
      "[dev] Cold compiles after a restart cost a few seconds more; edit-refresh is unaffected.",
    );
    console.log("[dev] Force it back on with: npm run dev -- --fs-cache");
  }
}

const child = spawn(
  process.execPath,
  [nextBin, "dev", ...bundlerArgs, ...nextArgs],
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
