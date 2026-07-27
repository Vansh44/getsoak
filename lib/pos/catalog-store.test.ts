import { describe, it, expect } from "vitest";
import {
  catalogKey,
  clearCatalog,
  readCatalog,
  writeCatalog,
} from "./catalog-store";

// jsdom ships no IndexedDB, which makes it a faithful stand-in for the browsers
// that matter here: private-mode Safari, locked-down kiosk profiles, a device
// out of quota. The contract under test is that the register keeps working —
// every call degrades quietly instead of throwing, so the sell path simply
// falls back to the server.
describe("catalog-store without IndexedDB", () => {
  const key = catalogKey("store-1", "loc-1");

  it("reads null instead of throwing", async () => {
    await expect(readCatalog(key)).resolves.toBeNull();
  });

  it("writes and clears without throwing", async () => {
    await expect(writeCatalog(key, [])).resolves.toBeUndefined();
    await expect(clearCatalog(key)).resolves.toBeUndefined();
  });
});

describe("catalogKey", () => {
  // Stock is per-location and a browser can be shared between stores, so a
  // cache entry may never be reused across either boundary.
  it("scopes the cache to one store AND one location", () => {
    expect(catalogKey("s1", "l1")).toBe("s1:l1");
    expect(catalogKey("s1", "l1")).not.toBe(catalogKey("s1", "l2"));
    expect(catalogKey("s1", "l1")).not.toBe(catalogKey("s2", "l1"));
  });
});
