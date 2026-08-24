import { execFileSync, spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const devCacheDir = path.join(projectRoot, ".next", "dev");
// `next build`'s webpack cache. Turbopack dev NEVER reads it, so on a machine
// that only ever runs `npm run dev` it is pure dead disk that grows to gigabytes
// and is never reclaimed by anything. Measured 2026-08-24: 1.5 GB, last written
// ten days earlier. It matters because macOS grows its swap file on the same
// volume, and this project's dev server pushes an 8 GB machine into swap — so
// free disk is not a cosmetic concern here, it is what swap competes for.
const buildCacheDir = path.join(projectRoot, ".next", "cache");
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

// Drop the webpack build cache whenever it is big enough to matter. Unlike the
// dev cache above this costs NOTHING to discard in dev — nothing in this process
// reads it — so it is a plain reclaim, not a speed/space trade. The next
// `next build` rebuilds it.
const buildCacheBytes = await directoryBytes(buildCacheDir);
if (buildCacheBytes > 256 * MB) {
  console.log(
    `[dev] reclaiming ${(buildCacheBytes / MB / 1024).toFixed(1)} GB of .next/cache (next build's webpack cache; unused by dev).`,
  );
  await rm(buildCacheDir, { recursive: true, force: true });
}

// Keep Spotlight out of the generated directories.
//
// `.next` is 11.5k files that Turbopack REWRITES continuously while you develop,
// and `node_modules` is another 75.8k. Every write is an event mdworker would
// otherwise wake up for, on a machine that has no CPU or IO to spare.
//
// ⚠ MEASURED HONESTLY (2026-08-24): Spotlight is ingesting NO new files on this
// machine at all — a brand-new file written into an indexed directory was still
// unindexed after 70 s, and mds/mdworker sit at 0.0% CPU. So this is a NO-OP
// today and is NOT part of the current slowdown; do not credit it with one.
// It is here because the documented fix for that slowdown is a REBOOT (macOS
// never shrinks swap), and a reboot is exactly what would restart normal
// indexing — at which point these two directories become the largest churn
// source on the volume. Cheap insurance, placed before the cost arrives.
//
// Written on every start rather than once: `.next` is wiped by `dev:reset` and
// by the cache rotation above, and `node_modules` by `npm ci`, so a
// one-time marker silently disappears. Both are gitignored, so the marker
// cannot be committed — recreating it here is the only thing that makes it
// durable.
//
// `.metadata_never_index` is a long-standing Spotlight convention rather than a
// formally documented API, and it could not be verified on this machine because
// indexing is stalled. It is inert if it does nothing. The authoritative
// alternative is System Settings → Spotlight → Privacy, which needs a human.
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

// ★★ THE HEAP CAP IS NOT A CAP ON THE DEV SERVER'S MEMORY, and reading it as
// one is how "why is my Mac slow?" goes unanswered for weeks.
// `--max-old-space-size` bounds ONE region: V8's old space. Turbopack is Rust,
// so its graph, module cache and source maps are NATIVE allocations sitting
// entirely outside it, as is every Node buffer. Measured on this repo
// (2026-08-24, M2/8 GB): a freshly booted dev server is ~90 MB RSS, and
// compiling eight routes takes it to 1.77 GB — while the "2048 MB heap cap" was
// in force the whole time and never bound anything. A long session that touches
// the builder, POS and analytics climbs past 4 GB, because dev mode compiles
// routes lazily and keeps every one it has compiled resident.
//
// So the cap is worth keeping (it stops V8 itself ballooning) but it CANNOT be
// the reason the machine stays responsive. Restarting the dev server
// periodically is what actually reclaims the memory.
function memoryPreflight() {
  let swapUsedMb = 0;
  let swapTotalMb = 0;
  try {
    const raw = execFileSync("sysctl", ["-n", "vm.swapusage"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
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
    "[dev]    The dev server needs 2-4 GB. On top of a machine already swapping, the",
  );
  console.log(
    "[dev]    slowdown you feel is the SSD paging other apps back in, not Next.js compiling.",
  );
  console.log(
    "[dev]    macOS never shrinks swap, so this only clears on reboot. Quitting memory-heavy",
  );
  console.log(
    "[dev]    apps (Electron editors/browsers) buys back the most headroom right now.",
  );
  console.log("");
}

memoryPreflight();

if (heapMb > 0) {
  console.log(
    `[dev] ${memoryGb.toFixed(0)} GB RAM detected; capping V8's old space at ${heapMb} MB.`,
  );
  console.log(
    "[dev] Note: this bounds V8 only — Turbopack's native memory is outside it, so total",
  );
  console.log(
    "[dev] RSS still grows through a session. Restart the server when it feels sluggish.",
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
