import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("Shiprocket webhook credentials", () => {
  it("uses a one-way hash and constant-time verification", async () => {
    const { hashWebhookSecret, verifyWebhookSecret } =
      await import("./connection");
    const hash = hashWebhookSecret("secret-value");
    expect(hash).not.toContain("secret-value");
    expect(verifyWebhookSecret("secret-value", hash)).toBe(true);
    expect(verifyWebhookSecret("wrong", hash)).toBe(false);
  });
});
