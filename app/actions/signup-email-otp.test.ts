import { beforeEach, describe, expect, it, vi } from "vitest";

let jar: Map<string, string>;
const fakeJar = {
  get: (key: string) =>
    jar.has(key) ? { value: jar.get(key) as string } : undefined,
  set: (key: string, value: string) => jar.set(key, value),
  delete: (key: string) => jar.delete(key),
};

const cookies = vi.fn();
const headers = vi.fn();
vi.mock("next/headers", () => ({
  cookies: () => cookies(),
  headers: () => headers(),
}));

const rateLimit = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => rateLimit(...args),
  clientIp: () => "1.2.3.4",
}));

const getServerUser = vi.fn();
vi.mock("@/lib/auth/server-user", () => ({
  getServerUser: () => getServerUser(),
}));

const updateAuthUser = vi.fn();
vi.mock("@/lib/auth/firebase-users", () => ({
  updateAuthUser: (...args: unknown[]) => updateAuthUser(...args),
}));

let sentCode = "";
let operatorLogOnly = false;
const sendSignupOtpEmail = vi.fn();
vi.mock("@/lib/email/signup-otp", () => ({
  sendSignupOtpEmail: (...args: unknown[]) => sendSignupOtpEmail(...args),
}));

import {
  requestSignupEmailOtp,
  verifySignupEmailOtp,
} from "./signup-email-otp";

const USER = {
  id: "uid-1",
  email: "owner@example.test",
  emailConfirmed: false,
  phone: null,
  phoneConfirmed: false,
  metadata: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "signup-test-secret";
  jar = new Map();
  sentCode = "";
  operatorLogOnly = false;
  cookies.mockResolvedValue(fakeJar);
  headers.mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" }));
  rateLimit.mockResolvedValue({ allowed: true });
  getServerUser.mockResolvedValue(USER);
  sendSignupOtpEmail.mockImplementation(
    async (_email: string, code: string) => {
      sentCode = code;
      return { sent: !operatorLogOnly, operatorLogOnly };
    },
  );
  updateAuthUser.mockResolvedValue(undefined);
});

describe("requestSignupEmailOtp", () => {
  it("issues a six-digit code tied to a signed httpOnly cookie", async () => {
    const result = await requestSignupEmailOtp();

    expect(result).toEqual({ ok: true, operatorLogOnly: false });
    expect(sentCode).toMatch(/^\d{6}$/);
    expect(jar.get("sm_signup_email_otp")).toBeTruthy();
  });

  it("supports reserved dummy addresses through the operator log", async () => {
    operatorLogOnly = true;
    const result = await requestSignupEmailOtp();

    expect(result).toEqual({ ok: true, operatorLogOnly: true });
    expect(jar.get("sm_signup_email_otp")).toBeTruthy();
  });

  it("does not issue a second code for an already verified email", async () => {
    getServerUser.mockResolvedValue({ ...USER, emailConfirmed: true });

    expect(await requestSignupEmailOtp()).toEqual({
      ok: true,
      alreadyVerified: true,
    });
    expect(sendSignupOtpEmail).not.toHaveBeenCalled();
  });

  it("rate limits code requests", async () => {
    rateLimit.mockResolvedValue({ allowed: false });
    const result = await requestSignupEmailOtp();

    expect(result.ok).toBe(false);
    expect(sendSignupOtpEmail).not.toHaveBeenCalled();
  });
});

describe("verifySignupEmailOtp", () => {
  it("marks the Firebase email verified and consumes the code", async () => {
    await requestSignupEmailOtp();
    const result = await verifySignupEmailOtp(sentCode);

    expect(result).toEqual({ ok: true });
    expect(updateAuthUser).toHaveBeenCalledWith("uid-1", {
      emailVerified: true,
    });
    expect(jar.has("sm_signup_email_otp")).toBe(false);
  });

  it("counts wrong attempts without exposing the expected code", async () => {
    await requestSignupEmailOtp();
    const wrong = sentCode === "000000" ? "111111" : "000000";
    const result = await verifySignupEmailOtp(wrong);

    expect(result.error).toMatch(/4 attempts left/);
    expect(updateAuthUser).not.toHaveBeenCalled();
    expect(jar.has("sm_signup_email_otp")).toBe(true);
  });

  it("rejects a code requested for another signed-in user", async () => {
    await requestSignupEmailOtp();
    getServerUser.mockResolvedValue({ ...USER, id: "uid-2" });

    const result = await verifySignupEmailOtp(sentCode);
    expect(result.error).toMatch(/No active code/);
    expect(updateAuthUser).not.toHaveBeenCalled();
  });
});
