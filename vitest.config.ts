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
      // NOTE: the istanbul text-summary tree occasionally omits a row for a
      // fully-covered file (e.g. group-form.tsx, which is at 100%) — see the
      // HTML report (coverage/index.html) for the complete, authoritative
      // picture.
      //
      // Scope to the code we actually unit-test. Remaining Supabase SDK
      // wrappers, email layout templates, and untested Next.js route/component
      // files are covered by integration/e2e flows rather than vitest.
      include: [
        // Pure lib utilities
        "lib/utils.ts",
        "lib/slug.ts",
        "lib/pricing.ts",
        "lib/sanitize.ts",
        "lib/og-image.ts",
        "lib/phone-labels.ts",
        "lib/blog-reactions.ts",
        "lib/email/coupon-campaign.ts",
        "lib/email/campaign-worker.ts",
        "lib/homepage/section-types.ts",
        "lib/ai/gemini.ts",
        "lib/use-otp-throttle.ts",
        // ★ MONEY. Returns, refunds and store credit — the modules where a bug
        // means the wrong amount leaves. These were absent until 2026-08-04,
        // which meant the coverage report said nothing at all about them while
        // six ways for money to escape sat in code it never looked at. An
        // allowlist silently omitting the highest-stakes directory in the
        // codebase is worse than no allowlist: the number stays reassuring.
        //
        // Whole directories, not named files, so a module added next to these
        // is measured by default rather than by remembering to come here.
        "lib/returns/**/*.ts",
        "lib/credit/**/*.ts",
        "lib/payments/**/*.ts",
        "lib/pos/returns.ts",
        "lib/pos/totals.ts",
        "lib/pos/shifts.ts",
        "lib/orders/**/*.ts",
        "lib/billing/tax.ts",
        "lib/billing/gst.ts",
        // Server actions + permission logic
        "app/actions/**/*.ts",
        "app/dashboard/lib/permissions.ts",
        "app/dashboard/lib/use-row-selection.ts",
        // Behavior-tested client components (storefront + dashboard).
        "**/components/cart/CartProvider.tsx",
        "**/components/cart/CouponField.tsx",
        "**/components/auth/AuthProvider.tsx",
        "**/enquiries/enquiries-form.tsx",
        "**/user_groups/group-form.tsx",
        "**/marketing/coupons/coupon-form.tsx",
      ],
      exclude: ["**/*.test.{ts,tsx}", "**/_test-helpers.ts"],
    },
  },
});
