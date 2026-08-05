import { beforeEach, describe, expect, it, vi } from "vitest";

const headerState = vi.hoisted(() => ({ host: "themes.storemink.com" }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ host: headerState.host })),
}));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

describe("themes host discovery metadata", () => {
  beforeEach(() => {
    headerState.host = "themes.storemink.com";
  });

  it("publishes a themes-host sitemap without touching store tenancy", async () => {
    expect(await sitemap()).toEqual([
      {
        url: "https://themes.storemink.com",
        changeFrequency: "weekly",
        priority: 1,
      },
    ]);
  });

  it("publishes themes-host robots metadata", async () => {
    expect(await robots()).toEqual({
      rules: { userAgent: "*", allow: "/" },
      sitemap: "https://themes.storemink.com/sitemap.xml",
      host: "https://themes.storemink.com",
    });
  });
});
