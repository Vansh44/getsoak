/* eslint-disable @typescript-eslint/no-unused-vars -- a stub mirrors the real
   module's signature; its parameters exist to keep call sites type-checking
   and are unused by design. */
// `next/cache`'s revalidation helpers only mean something inside a running
// Next server — they throw outside a request/render scope (the same invariant
// that makes `unstable_cache` unusable in a script). A standalone script has no
// cache to bust, so these are no-ops.
//
// ⚠ CONSEQUENCE: a script that writes data does NOT invalidate a running
// server's caches. Storefront reads are `unstable_cache` with a 300s
// revalidate, so a data change can take up to five minutes to appear on an
// already-running server. A NEW store host shows up immediately, because
// lib/store/resolve.ts deliberately never caches a negative host lookup.
/**
 * `unstable_cache` wraps a function and returns a cached version. Outside a
 * render scope there is no incremental cache to read, and the real one throws
 * ("Invariant: incrementalCache missing"), so the stub returns the function
 * untouched — every call goes straight to the database, which is what a
 * one-shot script wants anyway.
 *
 * It is called at MODULE scope in lib/store/resolve.ts, so this has to exist
 * for any script that transitively imports the store resolver, not just for
 * scripts that read through it.
 */
export function unstable_cache<T extends (...args: never[]) => unknown>(
  fn: T,
  _keyParts?: readonly string[],
  _options?: unknown,
): T {
  return fn;
}
export function revalidateTag(_tag: string, _profile?: unknown): void {}
export function revalidatePath(_path: string, _type?: unknown): void {}
export function updateTag(_tag: string): void {}
export function unstable_noStore(): void {}
