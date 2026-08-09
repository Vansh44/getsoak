import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next. ⚠ `**/` IS LOAD-BEARING on
    // `.next`: a bare `.next/**` anchors to THIS directory, so it ignores the
    // root build output and nothing else. A `.next` one level down is linted in
    // full — and Next's generated `types/validator.ts` alone is thousands of
    // `@ts-ignore` errors. A Claude Code worktree under `.claude/worktrees/`
    // carrying its own build output turned `npm run lint` into 65,172 problems
    // (3,895 of them errors) on 2026-08-10, all of it generated code, none of it
    // ours. CI never saw it — `.claude/worktrees/` is in `.git/info/exclude` —
    // so this only ever broke the local run, which is the one a person reads.
    "**/.next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated test-coverage report — not source.
    "coverage/**",
    // Agent worktrees are SEPARATE CHECKOUTS of this repo, so linting them is
    // wrong even where the files are hand-written source: they are another
    // branch's copy, and every finding is a duplicate reported against a path
    // that is not the one you would edit.
    ".claude/**",
  ]),
]);

export default eslintConfig;
