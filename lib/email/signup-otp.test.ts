import { beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn();
const logEmail = vi.fn();
vi.mock("./send", () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
  logEmail: (...args: unknown[]) => logEmail(...args),
}));

import { sendSignupOtpEmail } from "./signup-otp";

beforeEach(() => {
  vi.clearAllMocks();
  sendEmail.mockResolvedValue({ sent: true });
  logEmail.mockResolvedValue(undefined);
});

describe("sendSignupOtpEmail", () => {
  it("keeps RFC-reserved dummy addresses inside the operator log", async () => {
    const result = await sendSignupOtpEmail("owner@demo.test", "123456");

    expect(result).toEqual({ sent: false, operatorLogOnly: true });
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
});
