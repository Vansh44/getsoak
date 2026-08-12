import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("Shiprocket client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("logs in and assigns an AWB from the nested response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "jwt" }), { status: 200 }),
      );
    const { shiprocketLogin } = await import("./shiprocket");
    const session = await shiprocketLogin(
      "api@example.com",
      "secret",
      fetchImpl,
    );
    expect(session.token).toBe("jwt");
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/v1/external/auth/login" }),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces provider validation errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Wrong credentials" }), {
        status: 401,
      }),
    );
    const { shiprocketLogin, ShiprocketError } = await import("./shiprocket");
    await expect(
      shiprocketLogin("api@example.com", "wrong", fetchImpl),
    ).rejects.toBeInstanceOf(ShiprocketError);
  });
});
