import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
