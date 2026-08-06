import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    alias: {
      "@": path.resolve(__dirname, "./"),
      // `server-only` throws when resolved outside an RSC graph; stub it so
      // server modules can be imported directly in unit tests.
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // ★ MEASURE EVERYTHING. This used to be an allowlist of ~100 hand-listed
      // files, and the number it printed (63.86%) was not a fact about the
      // codebase — it was a fact about the list. True coverage was 33.77%. An
      // allowlist reports on the code someone remembered to add to it, so the
      // files most likely to be missing are the ones nobody has thought about
      // recently: exactly the ones a coverage report exists to find. The list
      // it replaced had already learned this once — lib/returns, lib/credit and
      // lib/payments were added to it in 2026-08 after the highest-stakes
      // directory in the codebase turned out to be entirely unmeasured, with
      // the number staying reassuring throughout. This generalises that fix
      // instead of waiting to rediscover it per directory.
      //
      // Files that NO test imports are counted too — that is Vitest 4's default
      // (the old `all` flag is gone). It matters: without it a module with zero
      // tests is simply absent from the denominator, so deleting the last test
      // for one makes coverage go UP.
      include: [
        "app/**/*.{ts,tsx}",
        "lib/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "hooks/**/*.{ts,tsx}",
        "proxy.ts",
      ],
      // Everything excluded here is excluded because executing it proves
      // nothing, NOT because it is hard to test.
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/_test-helpers.ts",
        "**/*.d.ts",
        // Introspected from the live database by drizzle-kit. Regenerated, not
        // authored; a test asserting a column exists would assert the
        // generator ran.
        "drizzle/**",
        // Declarative shadcn/ui primitives, vendored from the generator.
        "components/ui/**",
      ],
    },
  },
});
