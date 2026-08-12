import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("Shiprocket webhook credentials", () => {
  it("uses a provider-neutral callback URL accepted by Shiprocket", async () => {
    const { shiprocketWebhookUrl } = await import("./connection");
    const url = shiprocketWebhookUrl("connection id");

    expect(url.endsWith("/api/webhooks/logistics/connection%20id")).toBe(true);
    expect(new URL(url).pathname).not.toMatch(
      /shiprocket|kartrocket|(^|\/)sr(\/|$)|(^|\/)kr(\/|$)/i,
    );
  });

  it("uses a one-way hash and constant-time verification", async () => {
    const { hashWebhookSecret, verifyWebhookSecret } =
      await import("./connection");
    const hash = hashWebhookSecret("secret-value");
    expect(hash).not.toContain("secret-value");
    expect(verifyWebhookSecret("secret-value", hash)).toBe(true);
    expect(verifyWebhookSecret("wrong", hash)).toBe(false);
  });
});
