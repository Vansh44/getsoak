import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  enabled: false,
  withService: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ enabled: holder.enabled }),
}));
vi.mock("@/lib/db/client", () => ({ withService: holder.withService }));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: vi.fn(),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { runMinkBlogPublicationWorker } from "./blog-publication-worker";

describe("Mink blog publication worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    holder.enabled = false;
  });

  it("pauses every due publication while Mink is globally disabled", async () => {
    await expect(runMinkBlogPublicationWorker()).resolves.toEqual({
      processed: 0,
      published: 0,
      conflicted: 0,
    });
    expect(holder.withService).not.toHaveBeenCalled();
  });
});
