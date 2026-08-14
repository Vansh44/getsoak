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

  it("turns JSON-encoded provider validation into readable text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: JSON.stringify({
            address: [
              "Address line 1 can't be less than 10 characters.",
              "Address line 1 should have House no / Flat no / Road no.",
            ],
          }),
        }),
        { status: 422 },
      ),
    );
    const { shiprocketLogin } = await import("./shiprocket");

    await expect(
      shiprocketLogin("api@example.com", "wrong", fetchImpl),
    ).rejects.toThrow(
      "Address line 1 can't be less than 10 characters. Address line 1 should have House no / Flat no / Road no.",
    );
  });

  it("promotes house details from location line 2 for pickup sync", async () => {
    const { shiprocketPickupAddressFields } = await import("./shiprocket");

    expect(
      shiprocketPickupAddressFields({
        line1: "faridkot",
        line2: "house number 46, near kamiana chowk",
      }),
    ).toEqual({
      address: "house number 46, near kamiana chowk, faridkot",
      address_2: "",
    });
    expect(
      shiprocketPickupAddressFields({
        line1: "hostel D, Thapar University",
        line2: "house number 46, near kamiana chowk",
      }),
    ).toEqual({
      address: "house number 46, near kamiana chowk",
      address_2: "hostel D, Thapar University",
    });
  });

  it("preserves a valid primary address and merges a short second line", async () => {
    const { shiprocketPickupAddressFields } = await import("./shiprocket");

    expect(
      shiprocketPickupAddressFields({
        line1: "12 MG Road",
        line2: "Unit 4",
      }),
    ).toEqual({ address: "12 MG Road, Unit 4", address_2: "" });
  });
});
