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

import { logError } from "@/lib/observability/logger";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
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
      failed: 0,
    });
    expect(holder.withService).not.toHaveBeenCalled();
  });

  it("still announces blogs already published when a later row fails", async () => {
    holder.enabled = true;
    // mockReset, not clearAllMocks: the once-queue is implementation state, so
    // a leaked one from another file would make this pass for the wrong reason.
    holder.withService
      .mockReset()
      .mockResolvedValueOnce({
        type: "published",
        storeId: "store-1",
        slug: "first-post",
        blogId: "blog-1",
      })
      .mockRejectedValueOnce(new Error("connection reset"));

    await expect(runMinkBlogPublicationWorker()).resolves.toEqual({
      processed: 1,
      published: 1,
      conflicted: 0,
      failed: 1,
    });
    // The published row has committed, so `status = 'scheduled'` will never
    // select it again — this run is its ONLY chance to reach IndexNow and
    // Search Console. Letting the failure escape used to skip it entirely.
    expect(notifyStoreContentPublished).toHaveBeenCalledWith({
      storeId: "store-1",
      paths: ["/blogs/first-post", "/blogs", "/"],
    });
    expect(logError).toHaveBeenCalled();
    // The batch stops rather than re-failing on the same claimable row.
    expect(holder.withService).toHaveBeenCalledTimes(2);
  });
});
