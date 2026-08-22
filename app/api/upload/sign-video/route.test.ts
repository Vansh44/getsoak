import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server-user", () => ({
  getServerUser: vi.fn(async () => ({ id: "user-1" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsSignUploadUrl: vi.fn(async (path: string) => `https://signed/${path}`),
  gcsPublicUrl: vi.fn((path: string) => `https://media/${path}`),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/storage/upload-owner", () => ({
  resolveUploadOwner: vi.fn(async () => ({
    kind: "store",
    storeId: "store-1",
  })),
}));

import { POST } from "./route";
import { gcsSignUploadUrl } from "@/lib/storage/gcs";
import { resolveUploadOwner } from "@/lib/storage/upload-owner";

function videoRequest() {
  return new Request("https://echos.storemink.com/api/upload/sign-video", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "video/mp4", size: 1024, folder: "homepage" }),
  });
}

describe("POST /api/upload/sign-video storage ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUploadOwner).mockResolvedValue({
      kind: "store",
      storeId: "store-1",
    });
  });

  it("signs only a path below the current store's deletable prefix", async () => {
    expect((await POST(videoRequest())).status).toBe(200);
    expect(gcsSignUploadUrl).toHaveBeenCalledWith(
      expect.stringMatching(
        /^stores\/store-1\/uploads\/homepage\/[a-z0-9]+_\d+\.mp4$/,
      ),
      "video/mp4",
    );
  });
});
