// `server-only` is provided by Next's bundler, not installed as a package, so
// any module importing it can't be resolved by a plain Node script. This stub
// stands in for it under tsconfig.scripts.json — it does nothing, which is
// exactly what the real one does at runtime inside a server context.
export {};
