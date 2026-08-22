import { describe, expect, it } from "vitest";
import { storeStoragePrefix, storeUploadPath } from "./paths";

describe("store-owned storage paths", () => {
  it("namespaces merchant uploads below the immutable store id", () => {
    expect(storeUploadPath("store-123", "product-images", "photo.webp")).toBe(
      "stores/store-123/uploads/product-images/photo.webp",
    );
    expect(storeStoragePrefix("store-123")).toBe("stores/store-123/");
  });

  it("keeps platform uploads outside every merchant prefix", () => {
    expect(storeUploadPath(null, "help-articles", "guide.webp")).toBe(
      "platform/uploads/help-articles/guide.webp",
    );
  });

  it("normalizes unsafe and empty folder segments", () => {
    expect(storeUploadPath("s1", "/blog covers//", "cover.webp")).toBe(
      "stores/s1/uploads/blogcovers/cover.webp",
    );
  });
});
