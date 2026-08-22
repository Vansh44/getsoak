import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server-user", () => ({
  getServerUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsUploadObject: vi.fn(async (path: string) => `https://media/${path}`),
}));
vi.mock("@/lib/storage/process-image", () => ({
  processImageUpload: vi.fn(async () => ({
    ok: true,
    data: {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
      ext: "webp",
    },
  })),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/storage/upload-owner", () => ({
  resolveUploadOwner: vi.fn(async () => ({
    kind: "store",
    storeId: "store-1",
  })),
}));

import { POST } from "./route";
import { gcsUploadObject } from "@/lib/storage/gcs";
import { resolveUploadOwner } from "@/lib/storage/upload-owner";

function uploadRequest() {
  const form = new FormData();
  form.append("file", new File(["image"], "photo.png", { type: "image/png" }));
  form.append("folder", "product-images");
  // Keep the jsdom File instance intact. Undici's Request parser constructs a
  // different-realm File, which correctly fails the route's instanceof guard.
  return { formData: async () => form } as Request;
}

describe("POST /api/upload storage ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUploadOwner).mockResolvedValue({
      kind: "store",
      storeId: "store-1",
    });
  });

  it("places a store-host upload below that store's deletable prefix", async () => {
    expect((await POST(uploadRequest())).status).toBe(200);
    expect(gcsUploadObject).toHaveBeenCalledWith(
      expect.stringMatching(
        /^stores\/store-1\/uploads\/product-images\/[a-z0-9]+_\d+\.webp$/,
      ),
      expect.any(Uint8Array),
      "image/webp",
    );
  });

  it("places a platform-host upload below the platform prefix", async () => {
    vi.mocked(resolveUploadOwner).mockResolvedValueOnce({ kind: "platform" });
    expect((await POST(uploadRequest())).status).toBe(200);
    expect(gcsUploadObject).toHaveBeenCalledWith(
      expect.stringMatching(
        /^platform\/uploads\/product-images\/[a-z0-9]+_\d+\.webp$/,
      ),
      expect.any(Uint8Array),
      "image/webp",
    );
  });

  it("rejects a signed-in user who does not own the upload scope", async () => {
    vi.mocked(resolveUploadOwner).mockResolvedValueOnce(null);
    expect((await POST(uploadRequest())).status).toBe(403);
    expect(gcsUploadObject).not.toHaveBeenCalled();
  });
});
