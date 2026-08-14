import { beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn();
const logEmail = vi.fn();
const emailConfigured = vi.fn();
vi.mock("./send", () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
  logEmail: (...args: unknown[]) => logEmail(...args),
  emailConfigured: () => emailConfigured(),
}));

import { sendSignupOtpEmail } from "./signup-otp";

beforeEach(() => {
  vi.clearAllMocks();
  // Restored explicitly, not left to clearAllMocks — it clears CALLS, not
  // IMPLEMENTATIONS, so a value set inside one test leaks into every test
  // after it (see the test:shuffle note in CODEBASE.md §5.8).
  sendEmail.mockResolvedValue({ sent: true });
  logEmail.mockResolvedValue(undefined);
  emailConfigured.mockReturnValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("sendSignupOtpEmail", () => {
  it("keeps RFC-reserved dummy addresses inside the operator log", async () => {
    const result = await sendSignupOtpEmail("owner@demo.test", "123456");

    expect(result).toEqual({
      sent: false,
      operatorLogOnly: true,
      devConsoleOnly: false,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(logEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@demo.test",
        mailer: "signup_test_otp",
        status: "skipped",
        subject: expect.stringContaining("123456"),
      }),
    );
  });

  it("sends real addresses through the email choke point", async () => {
    const result = await sendSignupOtpEmail("owner@shop.com", "654321");

    expect(result).toEqual({
      sent: true,
      operatorLogOnly: false,
      devConsoleOnly: false,
      error: undefined,
    });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@shop.com",
        mailer: "signup_otp",
        ignoreSuppression: true,
      }),
    );
    expect(logEmail).not.toHaveBeenCalled();
  });

  it("prints the code locally when no email provider is configured", async () => {
    emailConfigured.mockReturnValue(false);

    const result = await sendSignupOtpEmail("owner@shop.com", "246810");

    // devConsoleOnly is what lets the caller still issue the code cookie —
    // without it the signup dead ends on a step nobody can pass.
    expect(result).toEqual({
      sent: false,
      operatorLogOnly: false,
      devConsoleOnly: true,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("246810"));
    expect(logEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@shop.com",
        mailer: "signup_otp",
        status: "skipped",
      }),
    );
  });

  it("never prints a code in production, even unconfigured", async () => {
    emailConfigured.mockReturnValue(false);
    const previous = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");
    sendEmail.mockResolvedValue({ sent: false, error: "not configured" });

    try {
      const result = await sendSignupOtpEmail("owner@shop.com", "135791");

      // A deployed environment that lost its key must fail loudly, not mint
      // live codes into Cloud Logging while claiming the mail went out.
      expect(result.devConsoleOnly).toBe(false);
      expect(result.sent).toBe(false);
      expect(console.log).not.toHaveBeenCalled();
      expect(sendEmail).toHaveBeenCalled();
    } finally {
      vi.stubEnv("NODE_ENV", previous ?? "test");
    }
  });
});
