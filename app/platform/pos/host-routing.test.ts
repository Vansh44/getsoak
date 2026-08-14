import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const headerState = vi.hoisted(() => ({ host: "pos.storemink.com" }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: headerState.host })),
}));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { metadata } from "./page";

describe("POS product host discovery metadata", () => {
  beforeEach(() => {
    headerState.host = "pos.storemink.com";
  });

  it("publishes only the canonical POS product page in its own sitemap", async () => {
    expect(await sitemap()).toEqual([
      {
        url: "https://pos.storemink.com",
        changeFrequency: "monthly",
        priority: 1,
      },
    ]);
  });

  it("publishes POS-host robots metadata", async () => {
    expect(await robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: "https://pos.storemink.com/sitemap.xml",
      host: "https://pos.storemink.com",
    });
  });

  it("canonicalises the product page onto the dedicated host", () => {
    expect(metadata.alternates).toEqual({
      canonical: "https://pos.storemink.com",
    });
    expect(metadata.openGraph).toMatchObject({
      url: "https://pos.storemink.com",
    });
  });

  it("keeps the closing CTA legible and the light footer compact", () => {
    const page = readFileSync(
      join(process.cwd(), "app/platform/pos/page.tsx"),
      "utf8",
    );
    const css = readFileSync(
      join(process.cwd(), "app/platform/platform.css"),
      "utf8",
    );

    expect(page).toMatch(
      /href=\{PLATFORM_URL\}\s+className="stq-btn stq-btn-outline"[\s\S]*?Back to StoreMink/,
    );
    expect(page).toContain('className="stq-footer stq-footer-compact"');
    expect(css).toMatch(
      /\.stq-footer-simple \.stq-logo\s*\{[\s\S]*?color: var\(--stq-ink\)/,
    );
    expect(css).toMatch(
      /\.stq-footer-simple p\s*\{[\s\S]*?color: var\(--stq-muted\)/,
    );
  });
});
